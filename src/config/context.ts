/**
 * The config DSL. A config file default-exports a function that receives this
 * context and declares resources:
 *
 *   export default (ct: ConfigContext) => {
 *     ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });
 *     ct.group({ key: "mainz_kids_lead", name: "Mainz · Kids Leitung", parent: "mainz_area" });
 *   };
 *
 * The context is injected (no global state), so blueprints are just functions
 * and loops, and the whole thing is trivially testable without file I/O.
 */
import type { DesiredResource } from "../engine/types.js";

export interface ResourceInput {
  key: string;
  parent?: string;
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
  const { key, parent, dependsOn = [], ...fields } = input;
  if (!key || typeof key !== "string") {
    throw new Error(`${type} declaration is missing a string "key".`);
  }
  const edges = [...dependsOn];
  if (parent) {
    edges.push(parent);
  }
  return { type, key, fields, parent, dependsOn: edges };
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
  return resources;
}
