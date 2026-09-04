import { loadConfig } from "../../config/load.js";
import { resourceType } from "../../resources/registry.js";
import { collectRefs, isRef, type Ref } from "../../resolve/refs.js";
import {
  externalResources,
  loadState,
  saveState,
  type ExternalResource,
  type ManagedResource,
} from "../../state/state.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { InMemoryMutationLock } from "../prepared-operation-store.js";
import type { MutationLock } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface StateOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  saveState?: typeof saveState;
  loadConfig?: typeof loadConfig;
  lock?: MutationLock;
}

export type StateEntry =
  | { kind: "managed"; ownership: "owned"; entry: ManagedResource }
  | { kind: "external"; ownership: "read-only"; entry: ExternalResource };

export interface StateListRequest extends ProjectRequest {
  managed?: boolean;
  external?: boolean;
}

export type StateListResult = OperationResult<{ entries: StateEntry[]; resources: ManagedResource[] }>;

export interface StateRemoveRequest extends ProjectRequest {
  type: string;
  key: string;
  force?: boolean;
  dryRun?: boolean;
  /** Restrict a public lifecycle command to its own state partition. */
  expectedKind?: "managed" | "external";
  /** Refuse a stale prepare/confirm/execute sequence if any binding metadata changed meanwhile. */
  expectedEntry?: ManagedResource | ExternalResource;
  /** Safe public commands fail closed when their reference guard cannot load config. */
  requireReadableConfig?: boolean;
  operation?: "state" | "unuse" | "unadopt";
}

export type StateRemoveResult = OperationResult<{
  kind: "managed" | "external";
  entry: ManagedResource | ExternalResource;
  removed: boolean;
  churchToolsContacted: false;
}>;

const defaultLock = new InMemoryMutationLock();

export async function listState(
  request: StateListRequest = {},
  dependencies: StateOperationDependencies = {},
): Promise<StateListResult> {
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  const includeManaged = request.managed || !request.external;
  const includeExternal = request.external || !request.managed;
  const resources = includeManaged ? Object.values(state.resources) : [];
  const entries: StateEntry[] = [
    ...resources.map((entry): StateEntry => ({ kind: "managed", ownership: "owned", entry })),
    ...(includeExternal
      ? Object.values(externalResources(state)).map((entry): StateEntry => ({
          kind: "external",
          ownership: "read-only",
          entry,
        }))
      : []),
  ];
  return {
    operation: "state",
    project,
    warnings: [],
    value: { entries, resources },
  };
}

async function declaredKeys(
  configPath: string,
  dependencies: StateOperationDependencies,
): Promise<Set<string>> {
  const { resources, permissions } = await (dependencies.loadConfig ?? loadConfig)(configPath);
  const keys = new Set(resources.map((resource) => resource.key));
  const addRef = (ref: Ref): void => {
    if (ref.kind === "group-role") keys.add(ref.group);
    else if (ref.kind === "group-type-role") keys.add(ref.groupType);
    else if (ref.kind === "group-member-field") keys.add(ref.group);
    else keys.add(ref.key);
  };
  // Resource fields and dynamic rulesets carry typed ref.* values; parent/dependsOn
  // remain portable string keys. Walk all of them so unuse/unadopt cannot leave a
  // config that only fails on the next plan.
  for (const resource of resources) {
    if (resource.parent) keys.add(resource.parent);
    for (const key of resource.parents ?? []) keys.add(key);
    for (const key of resource.dependsOn ?? []) keys.add(key);
    for (const ref of collectRefs([resource.fields, resource.dynamic?.ruleset])) addRef(ref);
  }
  for (const ref of collectRefs(permissions)) addRef(ref);
  for (const permission of permissions) {
    for (const grant of permission.grants) {
      if (typeof grant === "string" || !Array.isArray(grant.scope)) continue;
      for (const entry of grant.scope) {
        if (typeof entry === "string" && entry.length > 0) keys.add(entry);
        else if (entry !== null && typeof entry === "object" && !isRef(entry)) {
          const values = Object.values(entry as Record<string, unknown>);
          if (values.length === 1 && typeof values[0] === "string" && values[0].length > 0) {
            keys.add(values[0]);
          }
        }
      }
    }
  }
  return keys;
}

export async function removeStateEntry(
  request: StateRemoveRequest,
  dependencies: StateOperationDependencies = {},
): Promise<StateRemoveResult> {
  resourceType(request.type);
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const lock = dependencies.lock ?? defaultLock;
  return lock.runExclusive(project.statePath, async () => {
    const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
    const managed = state.resources[request.key];
    const external = externalResources(state)[request.key];
    const entry = managed ?? external;
    if (!entry) {
      throw new Error(
        `No entry "${request.key}" in ${project.stateDisplayPath}. List them with \`ct state list\`.`,
      );
    }
    if (entry.type !== request.type) {
      throw new Error(
        `"${request.key}" in ${project.stateDisplayPath} is a ${entry.type} (#${entry.id}), not a ${request.type}. ` +
          `Pass the right type, or list them with \`ct state list\`.`,
      );
    }

    const kind = managed ? "managed" : "external";
    if (request.expectedKind && kind !== request.expectedKind) {
      const command = kind === "managed" ? "unadopt" : "unuse";
      throw new Error(
        `"${request.key}" is ${kind}, not ${request.expectedKind}. Use \`ct ${command} ${entry.type} ${request.key}\`.`,
      );
    }
    if (request.expectedEntry && JSON.stringify(entry) !== JSON.stringify(request.expectedEntry)) {
      throw new Error(
        `${kind} ${entry.type}.${request.key} changed while confirmation was pending. Inspect it and retry.`,
      );
    }
    const warnings: CtWarning[] = [];
    if (!request.force) {
      try {
        const declared = await declaredKeys(project.configPath, dependencies);
        if (declared.has(request.key)) {
          const consequence =
            kind === "managed"
              ? "the next plan could recreate the live object or fail to resolve one of its references"
              : "the next plan would fail because the external prerequisite no longer resolves";
          throw new Error(
            `"${request.key}" is still declared or referenced in the config; ${consequence}. ` +
              `Remove every declaration/ref first, or pass --force only when both changes belong together.`,
          );
        }
      } catch (caught) {
        if (caught instanceof Error && caught.message.includes("is still declared or referenced"))
          throw caught;
        if (request.requireReadableConfig) {
          throw new Error(
            `Could not read the config to verify that "${request.key}" is unused ` +
              `(${caught instanceof Error ? caught.message : String(caught)}). Fix the config or pass --force after reviewing all references.`,
          );
        }
        warnings.push({
          code: "CONFIG_UNREADABLE",
          message:
            `Could not read the config to check whether "${request.configPath ?? "the default config"}" still ` +
            `declares this key (${caught instanceof Error ? caught.message : String(caught)}) — removing anyway.`,
        });
      }
    }

    if (!request.dryRun) {
      if (kind === "managed") delete state.resources[request.key];
      else delete externalResources(state)[request.key];
      await (dependencies.saveState ?? saveState)(project.statePath, state);
    }
    return {
      operation: request.operation ?? "state",
      project,
      warnings,
      value: { kind, entry, removed: !request.dryRun, churchToolsContacted: false },
    };
  });
}

export interface StateRekeyRequest extends ProjectRequest {
  type: string;
  oldKey: string;
  newKey: string;
  dryRun?: boolean;
}

export type StateRekeyResult = OperationResult<{
  kind: "managed" | "external";
  entry: ManagedResource | ExternalResource;
  oldKey: string;
  newKey: string;
  changed: boolean;
  churchToolsContacted: false;
}>;

export async function rekeyStateEntry(
  request: StateRekeyRequest,
  dependencies: StateOperationDependencies = {},
): Promise<StateRekeyResult> {
  resourceType(request.type);
  const oldKey = request.oldKey.trim();
  const newKey = request.newKey.trim();
  if (!oldKey || !newKey) throw new Error("Old and new logical keys must be non-empty.");
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const lock = dependencies.lock ?? defaultLock;
  return lock.runExclusive(project.statePath, async () => {
    const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
    const externals = externalResources(state);
    const managed = state.resources[oldKey];
    const external = externals[oldKey];
    const entry = managed ?? external;
    if (!entry) throw new Error(`No entry "${oldKey}" in ${project.stateDisplayPath}.`);
    if (entry.type !== request.type) {
      throw new Error(`"${oldKey}" is a ${entry.type}, not a ${request.type}.`);
    }
    const collision = state.resources[newKey] ?? externals[newKey];
    if (collision && newKey !== oldKey) {
      throw new Error(
        `Logical key "${newKey}" is already used by ${collision.type} #${collision.id}; keys are unique across managed and external entries.`,
      );
    }
    const kind = managed ? "managed" : "external";
    const changed = oldKey !== newKey;
    const updated = changed ? { ...entry, key: newKey } : entry;
    if (changed && !request.dryRun) {
      if (kind === "managed") {
        delete state.resources[oldKey];
        state.resources[newKey] = updated as ManagedResource;
      } else {
        delete externals[oldKey];
        externals[newKey] = updated as ExternalResource;
      }
      await (dependencies.saveState ?? saveState)(project.statePath, state);
    }
    return {
      operation: "state",
      project,
      warnings: [
        {
          code: "STATE_REKEY_REFS",
          message: `Update every ref.* use from "${oldKey}" to "${newKey}" consistently.`,
        },
      ],
      value: {
        kind,
        entry: updated,
        oldKey,
        newKey,
        changed: changed && !request.dryRun,
        churchToolsContacted: false,
      },
    };
  });
}
