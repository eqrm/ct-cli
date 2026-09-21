import { loadConfig } from "../../config/load.js";
import { resourceType } from "../../resources/registry.js";
import { collectRefs, isRef, type Ref } from "../../resolve/refs.js";
import { refKindResolvesLive } from "../../resolve/resolver.js";
import { loadState, saveState, type ManagedResource } from "../../state/state.js";
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

export type StateListResult = OperationResult<{ resources: ManagedResource[] }>;

export interface StateRemoveRequest extends ProjectRequest {
  type: string;
  key: string;
  force?: boolean;
  dryRun?: boolean;
}

export type StateRemoveResult = OperationResult<{
  entry: ManagedResource;
  removed: boolean;
  churchToolsContacted: false;
}>;

const defaultLock = new InMemoryMutationLock();

export async function listState(
  request: ProjectRequest = {},
  dependencies: StateOperationDependencies = {},
): Promise<StateListResult> {
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  return {
    operation: "state",
    project,
    warnings: [],
    value: { resources: Object.values(state.resources) },
  };
}

/**
 * What the config DECLARES, and what it merely REFERENCES (#180).
 *
 * These were one set, and that made `ct state rm` refuse a key the config only points at. Same state
 * file, same config: `campus/horgen` (0 occurrences) was accepted, while `campus/mainz` — declared
 * nowhere, but named by `campus: "mainz"` on 60 other resources — was refused as "still declared".
 *
 * A reference is not a declaration. A logical ref asks the HOST for the id (`verify` labels exactly
 * these "logical ref, resolved live — not compared"); it never asks `ct` to create the referenced
 * object, so removing the state entry cannot make the next plan propose creating it. Only a real
 * declaration can do that, which is what the guard was written to catch.
 *
 * Declarations are keyed by `type\0key`, not by key alone: the guard exists to predict what the next
 * plan would do to a specific resource, and a `campus` declaration says nothing about what removing a
 * `group-type` of the same name would cause.
 *
 * One class of reference DOES still block removal, for the guard's original reason rather than a
 * spelling one: a ref whose kind has no live master-data catalog (a `group` — groups are managed-only)
 * can be resolved from nothing but ct's state, so dropping the entry it names makes the very next
 * plan a hard error instead of a create proposal. Those are refused, and said so in their own words.
 */
interface ConfigUsage {
  declared: Set<string>;
  /** key → how many times the config references it. Reported, never a refusal. */
  referenceCounts: Map<string, number>;
  /** Keys referenced by at least one ref kind that can only resolve from managed state. */
  stateOnlyRefs: Set<string>;
}

function declarationId(type: string, key: string): string {
  return `${type}\u0000${key}`;
}

async function configUsage(
  configPath: string,
  dependencies: StateOperationDependencies,
): Promise<ConfigUsage> {
  const { resources, permissions } = await (dependencies.loadConfig ?? loadConfig)(configPath);
  const declared = new Set(resources.map((resource) => declarationId(resource.type, resource.key)));
  const referenceCounts = new Map<string, number>();
  const stateOnlyRefs = new Set<string>();
  const countRef = (key: string, resolvesLive: boolean): void => {
    referenceCounts.set(key, (referenceCounts.get(key) ?? 0) + 1);
    if (!resolvesLive) stateOnlyRefs.add(key);
  };
  const addRef = (ref: Ref): void => {
    // The compound kinds address a permission DOMAIN, and the key they carry here is the GROUP or
    // GROUP TYPE the domain hangs off — so each is classified by the kind of that target, not by the
    // compound kind itself. A group_role domain needs its group in managed state; a group_type_role
    // domain resolves its type from `/group/grouptypes` like any other group-type ref.
    if (ref.kind === "group-role") countRef(ref.group, refKindResolvesLive("group"));
    else if (ref.kind === "group-member-field") countRef(ref.group, refKindResolvesLive("group"));
    else if (ref.kind === "group-type-role") countRef(ref.groupType, refKindResolvesLive("group-type"));
    else countRef(ref.key, refKindResolvesLive(ref.kind));
  };
  // Refs reachable from the resources themselves (`campus: "mainz"` on a group) as well as from the
  // permission set — the old check only walked the latter, so the count it reported was partial too.
  for (const ref of collectRefs(resources)) addRef(ref);
  for (const ref of collectRefs(permissions)) addRef(ref);
  for (const permission of permissions) {
    for (const grant of permission.grants) {
      if (typeof grant === "string" || !Array.isArray(grant.scope)) continue;
      for (const entry of grant.scope) {
        // A BARE STRING in a scope list is the historical group dimension (`resolveScope` looks it
        // up in managed state and nowhere else), so it is state-only by construction.
        if (typeof entry === "string" && entry.length > 0) countRef(entry, false);
        else if (entry !== null && typeof entry === "object" && !isRef(entry)) {
          const values = Object.values(entry as Record<string, unknown>);
          if (values.length === 1 && typeof values[0] === "string" && values[0].length > 0) {
            countRef(values[0], false);
          }
        }
      }
    }
  }
  return { declared, referenceCounts, stateOnlyRefs };
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
    const entry = state.resources[request.key];
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

    const warnings: CtWarning[] = [];
    if (!request.force) {
      try {
        const { declared, referenceCounts, stateOnlyRefs } = await configUsage(
          project.configPath,
          dependencies,
        );
        // Declaredness is checked FIRST because it is the more specific verdict: it is matched on
        // type AND key, while the state-only reference check below can only match on key. A key that
        // is both declared and referenced would otherwise be refused with the vaguer of the two
        // messages, naming a consequence that is not the main one.
        if (declared.has(declarationId(request.type, request.key))) {
          throw new Error(
            `"${request.key}" is still declared in the config, so removing it from state would make the next ` +
              `plan propose CREATING a resource that already exists on this host. Remove the ` +
              `declaration first, or pass --force if you are deleting both in the same change.`,
          );
        }
        if (stateOnlyRefs.has(request.key)) {
          throw new Error(
            `"${request.key}" is still referenced by the config as a resource that only ct's state can ` +
              `resolve (a group has no live master-data catalog to fall back to), so removing it would make ` +
              `the next plan fail to resolve those references. Remove the references first, or pass --force ` +
              `if you are deleting both in the same change.`,
          );
        }
        // Referenced but not declared — allowed, and worth saying out loud: every one of those refs
        // now resolves against the LIVE host by name, which is a different resolution path than the
        // state lookup it had a moment ago (see #181). A key whose live name does not slug back to it
        // will fail the next plan, and this is the last point at which that is cheap to notice.
        const references = referenceCounts.get(request.key) ?? 0;
        if (references > 0) {
          warnings.push({
            code: "STILL_REFERENCED",
            message:
              `The config references "${request.key}" ${references} time(s) but does not declare it, so it is ` +
              `removed from state. Those references now resolve against ${project.host} by name — check the ` +
              `next \`ct plan\` resolves them, or pin them to a numeric id.`,
            details: { key: request.key, type: request.type, references },
          });
        }
      } catch (caught) {
        // Both refusals above are verdicts, not read failures — re-throw them rather than degrade
        // into "could not read the config, removing anyway".
        if (
          caught instanceof Error &&
          (caught.message.includes("is still declared in the config") ||
            caught.message.includes("is still referenced by the config"))
        )
          throw caught;
        warnings.push({
          code: "CONFIG_UNREADABLE",
          message:
            `Could not read the config to check whether "${request.configPath ?? "the default config"}" still ` +
            `declares this key (${caught instanceof Error ? caught.message : String(caught)}) — removing anyway.`,
        });
      }
    }

    if (!request.dryRun) {
      delete state.resources[request.key];
      await (dependencies.saveState ?? saveState)(project.statePath, state);
    }
    return {
      operation: "state",
      project,
      warnings,
      value: { entry, removed: !request.dryRun, churchToolsContacted: false },
    };
  });
}
