/**
 * The config DSL. A config file default-exports a function that receives this
 * context and declares resources:
 *
 *   export default (ct: ConfigContext) => {
 *     ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });
 *     ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupTypeId: 2 });
 *     ct.group({ key: "mainz_kids", name: "Mainz · Kids", groupTypeId: 2, parents: ["mainz_area"] });
 *   };
 *
 * The context is injected (no global state), so blueprints are just functions
 * and loops, and the whole thing is trivially testable without file I/O.
 */
import type { DesiredResource } from "../engine/types.js";

export interface ResourceInput {
  key: string;
  /** Ordering hint: apply this resource after `parent`. A dependency edge only — NOT managed hierarchy. */
  parent?: string;
  /**
   * Managed parent groups (group→group hierarchy). Opt-in: omit to leave a group's hierarchy
   * unmanaged; `[]` means "managed with no parents". Each key must reference a group declared
   * in the same config.
   */
  parents?: string[];
  dependsOn?: string[];
  [field: string]: unknown;
}

export interface ConfigContext {
  campus(input: ResourceInput): void;
  group(input: ResourceInput): void;
  groupType(input: ResourceInput): void;
  ageGroup(input: ResourceInput): void;
  targetGroup(input: ResourceInput): void;
  relationshipType(input: ResourceInput): void;
}

export type ConfigModule = (ct: ConfigContext) => void | Promise<void>;

function toDesired(type: string, input: ResourceInput): DesiredResource {
  const { key, parent, parents, dependsOn = [], ...fields } = input;
  if (!key || typeof key !== "string") {
    throw new Error(`${type} declaration is missing a string "key".`);
  }
  // A nullish/empty `parent` is "no parent", not an opt-in to managed-empty hierarchy.
  if (parent != null && typeof parent !== "string") {
    throw new Error(`${type} "${key}": "parent" must be a string key.`);
  }
  if (parents !== undefined && (!Array.isArray(parents) || parents.some((p) => typeof p !== "string"))) {
    throw new Error(`${type} "${key}": "parents" must be an array of string group keys.`);
  }
  // `parent` is an ordering hint only — a dependency edge, never a diffed/managed field
  // (its pre-hierarchy meaning; a `parent` may point at a campus). Group hierarchy is
  // managed opt-in via `parents`: `undefined` → unmanaged, `[]` → managed with no parents.
  const parentKey = typeof parent === "string" && parent !== "" ? parent : undefined;
  const parentKeys = parents !== undefined ? [...new Set(parents)] : undefined;
  const edges = [...new Set([...dependsOn, ...(parentKey ? [parentKey] : []), ...(parentKeys ?? [])])];
  return { type, key, fields, parent: parentKey, parents: parentKeys, dependsOn: edges };
}

/**
 * Every managed hierarchy parent must reference a group declared in the same config.
 * A parent that resolves to nothing (typo, unmanaged group) or to a non-group would
 * diff forever against the managed-only actual side, so reject it up front rather than
 * emit a plan that can never converge.
 */
function validateReferences(resources: DesiredResource[]): void {
  const byKey = new Map(resources.map((r) => [r.key, r]));
  for (const r of resources) {
    for (const parentKey of r.parents ?? []) {
      const target = byKey.get(parentKey);
      if (!target) {
        throw new Error(
          `Group "${r.key}" declares hierarchy parent "${parentKey}", which is not declared in this config. ` +
            `Managed parents must reference a group by its key (omit unmanaged parents entirely).`,
        );
      }
      if (target.type !== "group") {
        throw new Error(
          `Group "${r.key}" declares hierarchy parent "${parentKey}", but "${parentKey}" is a ${target.type}, not a group.`,
        );
      }
    }
  }
}

export function createContext(): { ct: ConfigContext; resources: DesiredResource[] } {
  const resources: DesiredResource[] = [];
  const seen = new Set<string>();
  const define =
    (type: string) =>
    (input: ResourceInput): void => {
      const resource = toDesired(type, input);
      if (seen.has(resource.key)) {
        throw new Error(`Duplicate logical key "${resource.key}" in config.`);
      }
      seen.add(resource.key);
      resources.push(resource);
    };
  // Every type emitted here MUST have an apply tier in engine/graph.ts TYPE_TIER
  // (locked by tests/context.test.ts), else computePlan rejects it at plan time.
  const ct: ConfigContext = {
    campus: define("campus"),
    group: define("group"),
    groupType: define("group-type"),
    ageGroup: define("age-group"),
    targetGroup: define("target-group"),
    relationshipType: define("relationship-type"),
  };
  return { ct, resources };
}

/** Run a loaded config module against a fresh context and collect its resources. */
export async function evaluateConfig(mod: ConfigModule): Promise<DesiredResource[]> {
  const { ct, resources } = createContext();
  await mod(ct);
  validateReferences(resources);
  return resources;
}
