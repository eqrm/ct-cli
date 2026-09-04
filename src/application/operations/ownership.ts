import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { loadEnvProfile } from "../../env/envs.js";
import { identityDifferences } from "../../resolve/external.js";
import { resourceType } from "../../resources/registry.js";
import {
  externalResources,
  loadState,
  type ExternalResource,
  type ManagedResource,
} from "../../state/state.js";
import type { OperationResult } from "../contracts.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "out",
]);

export interface OwnershipCheckRequest {
  root: string;
  environment: string;
  cwd?: string;
}

export interface OwnershipProject {
  name: string;
  path: string;
  relativePath: string;
  host: string;
  statePath: string;
  managed: ManagedResource[];
  externals: ExternalResource[];
}

export type OwnershipReason =
  | "DUPLICATE_OWNER"
  | "OWNER_HINT_MISMATCH"
  | "OWNER_OUTSIDE_SCOPE"
  | "OWNER_NOT_VISIBLE"
  | "KEY_MISMATCH"
  | "CONFLICTING_BINDING"
  | "INCOMPATIBLE_IDENTITY"
  | "PROJECT_STATE_INVALID";

export interface OwnershipFinding {
  severity: "ok" | "error";
  reason: OwnershipReason | "OWNERSHIP_OK";
  host: string;
  type?: string;
  id?: number;
  key?: string;
  projects: string[];
  message: string;
  remediation?: string[];
}

export type OwnershipCheckResult = OperationResult<{
  root: string;
  environment: string;
  projects: OwnershipProject[];
  hosts: string[];
  findings: OwnershipFinding[];
  conflicts: number;
  completeScope: true;
}>;

export interface OwnershipDependencies {
  discover?: (root: string) => Promise<string[]>;
  loadEnvProfile?: typeof loadEnvProfile;
  loadState?: typeof loadState;
}

async function discoverEnvironmentFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path);
        } else if (entry.isFile() && entry.name === "ct.envs.json") {
          found.push(path);
        }
      }),
    );
  };
  await walk(root);
  return found.sort();
}

function pair(type: string, id: number): string {
  return `${type}\0${id}`;
}

function claim(
  project: OwnershipProject,
  entry: ManagedResource | ExternalResource,
  kind: "managed" | "external",
) {
  return { project, entry, kind } as const;
}

/** Analyse only the explicitly supplied directory tree; no network and no search outside it. */
export async function checkOwnership(
  request: OwnershipCheckRequest,
  dependencies: OwnershipDependencies = {},
): Promise<OwnershipCheckResult> {
  if (!request.environment.trim()) throw new Error("ownership check requires --env <name>.");
  const cwd = resolve(request.cwd ?? process.cwd());
  const root = resolve(cwd, request.root);
  const envFiles = await (dependencies.discover ?? discoverEnvironmentFiles)(root);
  const projects: OwnershipProject[] = [];
  const findings: OwnershipFinding[] = [];

  for (const envPath of envFiles) {
    const path = dirname(envPath);
    let profile;
    try {
      profile = await (dependencies.loadEnvProfile ?? loadEnvProfile)(request.environment, envPath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown environment")) continue;
      findings.push({
        severity: "error",
        reason: "PROJECT_STATE_INVALID",
        host: "unknown",
        projects: [relative(root, path) || "."],
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const statePath = resolve(path, profile.statePath);
    try {
      const state = await (dependencies.loadState ?? loadState)(statePath, profile.host);
      projects.push({
        name: basename(path),
        path,
        relativePath: relative(root, path) || ".",
        host: profile.host,
        statePath,
        managed: Object.values(state.resources),
        externals: Object.values(externalResources(state)),
      });
    } catch (error) {
      findings.push({
        severity: "error",
        reason: "PROJECT_STATE_INVALID",
        host: profile.host,
        projects: [relative(root, path) || "."],
        message: `Cannot inspect ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const host of [...new Set(projects.map((project) => project.host))].sort()) {
    const scoped = projects.filter((project) => project.host === host);
    const claims = scoped.flatMap((project) => [
      ...project.managed.map((entry) => claim(project, entry, "managed")),
      ...project.externals.map((entry) => claim(project, entry, "external")),
    ]);
    const byPair = new Map<string, typeof claims>();
    const byKey = new Map<string, typeof claims>();
    for (const item of claims) {
      const p = pair(item.entry.type, item.entry.id);
      byPair.set(p, [...(byPair.get(p) ?? []), item]);
      byKey.set(item.entry.key, [...(byKey.get(item.entry.key) ?? []), item]);
    }

    for (const items of byPair.values()) {
      const first = items[0]!;
      const errorsBefore = findings.filter((finding) => finding.severity === "error").length;
      const owners = items.filter((item) => item.kind === "managed");
      const consumers = items.filter((item) => item.kind === "external");
      const keys = [...new Set(items.map((item) => item.entry.key))];
      if (owners.length > 1) {
        findings.push({
          severity: "error",
          reason: "DUPLICATE_OWNER",
          host,
          type: first.entry.type,
          id: first.entry.id,
          projects: owners.map((item) => item.project.relativePath),
          message: `${first.entry.type} #${first.entry.id} is managed by ${owners.length} visible ct projects.`,
          remediation: owners
            .slice(1)
            .map(
              (item) =>
                `cd ${item.project.path} && ct unadopt ${item.entry.type} ${item.entry.key} --env ${request.environment}`,
            ),
        });
      }
      if (keys.length > 1) {
        const canonical = owners[0]?.entry.key ?? keys[0]!;
        findings.push({
          severity: "error",
          reason: "KEY_MISMATCH",
          host,
          type: first.entry.type,
          id: first.entry.id,
          projects: items.map((item) => item.project.relativePath),
          message: `${first.entry.type} #${first.entry.id} uses different logical keys: ${keys.join(", ")}.`,
          remediation: items
            .filter((item) => item.entry.key !== canonical)
            .map(
              (item) =>
                `cd ${item.project.path} && ct state rekey ${item.entry.type} ${item.entry.key} ${canonical} --env ${request.environment}`,
            ),
        });
      }
      for (const consumer of consumers) {
        const consumerEntry = consumer.entry as ExternalResource;
        const hinted = consumerEntry.owner;
        if (hinted) {
          const visible = scoped.find(
            (project) =>
              project.name === hinted || project.relativePath === hinted || project.path === hinted,
          );
          if (!visible) {
            findings.push({
              severity: "error",
              reason: "OWNER_OUTSIDE_SCOPE",
              host,
              type: consumer.entry.type,
              id: consumer.entry.id,
              key: consumer.entry.key,
              projects: [consumer.project.relativePath],
              message: `Owner hint ${JSON.stringify(hinted)} is not visible below ${root}.`,
              remediation: [`ct ownership check <broader-root> --env ${request.environment}`],
            });
          } else if (
            !visible.managed.some(
              (entry) => entry.type === consumer.entry.type && entry.id === consumer.entry.id,
            )
          ) {
            findings.push({
              severity: "error",
              reason: "OWNER_HINT_MISMATCH",
              host,
              type: consumer.entry.type,
              id: consumer.entry.id,
              key: consumer.entry.key,
              projects: [consumer.project.relativePath, visible.relativePath],
              message: `Owner hint ${JSON.stringify(hinted)} is visible but does not manage this binding.`,
              remediation: [`Correct --owner metadata with ct use, or repair the hinted owner's state.`],
            });
          }
        }
        if (
          owners.length === 0 &&
          !findings.some(
            (finding) => finding.reason === "OWNER_OUTSIDE_SCOPE" && finding.key === consumer.entry.key,
          )
        ) {
          findings.push({
            severity: "error",
            reason: "OWNER_NOT_VISIBLE",
            host,
            type: consumer.entry.type,
            id: consumer.entry.id,
            key: consumer.entry.key,
            projects: [consumer.project.relativePath],
            message: `No visible ct project manages ${consumer.entry.type} #${consumer.entry.id}.`,
            remediation: [`Broaden the explicit root or establish exactly one managed owner.`],
          });
        }
        const owner = owners[0];
        if (owner) {
          const ownerEntry = owner.entry as ManagedResource;
          const ownerIdentity = resourceType(ownerEntry.type).external.identity(ownerEntry.fields);
          const diff = identityDifferences(consumerEntry.identity, ownerIdentity);
          if (diff.length > 0) {
            findings.push({
              severity: "error",
              reason: "INCOMPATIBLE_IDENTITY",
              host,
              type: consumer.entry.type,
              id: consumer.entry.id,
              key: consumer.entry.key,
              projects: [owner.project.relativePath, consumer.project.relativePath],
              message: `Owner managed snapshot and consumer hard identity disagree (${diff.map((item) => item.field).join(", ")}).`,
              remediation: [
                `cd ${consumer.project.path} && ct use ${consumer.entry.type} ${consumer.entry.id} --key ${consumer.entry.key} --env ${request.environment}`,
              ],
            });
          }
        }
      }
      const errorsAfter = findings.filter((finding) => finding.severity === "error").length;
      if (owners.length === 1 && consumers.length > 0 && keys.length === 1 && errorsAfter === errorsBefore) {
        findings.push({
          severity: "ok",
          reason: "OWNERSHIP_OK",
          host,
          type: first.entry.type,
          id: first.entry.id,
          key: first.entry.key,
          projects: items.map((item) => item.project.relativePath),
          message: `${owners[0]!.project.relativePath} owns; ${consumers.length} consumer(s) bind read-only.`,
        });
      }
    }

    for (const [key, items] of byKey) {
      const bindings = [...new Set(items.map((item) => pair(item.entry.type, item.entry.id)))];
      if (bindings.length > 1) {
        findings.push({
          severity: "error",
          reason: "CONFLICTING_BINDING",
          host,
          key,
          projects: items.map((item) => item.project.relativePath),
          message: `Logical key ${JSON.stringify(key)} maps to incompatible type/id bindings on this host.`,
          remediation: ["Rekey the conflicting project state so one portable key has one meaning."],
        });
      }
    }
  }

  const conflicts = findings.filter((finding) => finding.severity === "error").length;
  return {
    operation: "ownership",
    project: {
      cwd,
      configPath: "",
      statePath: "",
      environmentsPath: "",
      configDisplayPath: "",
      stateDisplayPath: "",
      environment: request.environment,
      protected: false,
      host: "multiple",
    },
    warnings: [],
    value: {
      root,
      environment: request.environment,
      projects,
      hosts: [...new Set(projects.map((project) => project.host))].sort(),
      findings,
      conflicts,
      completeScope: true,
    },
  };
}
