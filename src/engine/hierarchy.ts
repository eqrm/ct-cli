/**
 * Group hierarchy (parent/child) is a many-to-many DAG in ChurchTools: a group
 * can have several parents. `GET /groups/hierarchies` returns, per group, the
 * ids of its parents and children.
 *
 * We surface hierarchy in the plan as an opt-in `parents` set-field on a group,
 * resolved to logical keys and **restricted to managed groups** — an edge to an
 * unmanaged group is invisible (managed-guard), never diffed or proposed for
 * removal.
 */

import type { State } from "../state/state.js";
import type { DesiredResource } from "./types.js";

export interface HierarchyEntry {
  groupId: number;
  parents?: number[];
  children?: number[];
}

/** Map each group id to its parent group ids. */
export function parentIdsByGroupId(entries: HierarchyEntry[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const entry of entries) {
    if (typeof entry.groupId === "number") {
      map.set(entry.groupId, Array.isArray(entry.parents) ? entry.parents : []);
    }
  }
  return map;
}

/**
 * The managed parent keys for a group: its parent ids that are themselves under
 * management, mapped to their logical keys and sorted (stable for set diffing).
 */
export function managedParentKeys(parentIds: number[], groupIdToKey: Map<number, string>): string[] {
  const keys: string[] = [];
  for (const id of parentIds) {
    const key = groupIdToKey.get(id);
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys.sort();
}

/**
 * Fold group hierarchy into the plan inputs as a `parents` set-field.
 *
 * Mutates `actual`: every managed group gets `parents` set to its managed
 * parent keys (from `parentIdsByGroup`). Returns a new desired list where each
 * group that opted into hierarchy (`parents !== undefined`) carries a sorted
 * `parents` field, so `computePlan` diffs it generically. Groups that did not
 * opt in are untouched — their hierarchy is not managed.
 */
export function applyHierarchy(
  desired: DesiredResource[],
  state: State,
  actual: Map<string, Record<string, unknown>>,
  parentIdsByGroup: Map<number, number[]>,
): DesiredResource[] {
  const groupIdToKey = new Map<number, string>();
  for (const managed of Object.values(state.resources)) {
    if (managed.type === "group") {
      groupIdToKey.set(managed.id, managed.key);
    }
  }

  for (const managed of Object.values(state.resources)) {
    if (managed.type !== "group") {
      continue;
    }
    const a = actual.get(managed.key);
    if (a) {
      a.parents = managedParentKeys(parentIdsByGroup.get(managed.id) ?? [], groupIdToKey);
    }
  }

  return desired.map((d) =>
    d.type === "group" && d.parents !== undefined
      ? { ...d, fields: { ...d.fields, parents: [...d.parents].sort() } }
      : d,
  );
}
