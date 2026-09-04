/**
 * Group hierarchy (parent/child) is a many-to-many DAG in ChurchTools: a group
 * can have several parents. `GET /groups/hierarchies` returns, per group, the
 * ids of its parents and children.
 *
 * We surface hierarchy in the plan as an opt-in `parents` set-field on a managed
 * group. Parent ids are mapped only when state gives them a logical key, either
 * as another managed group or as an explicit external group binding. Every other
 * live edge stays invisible (managed-guard), never diffed or proposed for removal.
 */

import { externalResources, type State } from "../state/state.js";
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
 * The state-bound parent keys for a group: parent ids that are managed or
 * explicitly external, mapped to their logical keys and sorted (stable for set diffing).
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
 * Only groups that opted into hierarchy (`parents !== undefined` on the desired
 * side) are touched: their `actual` record gets a `parents` set of managed
 * parent keys (from `parentIdsByGroup`), and their desired gets a sorted
 * `parents` field so `computePlan` diffs it generically. Groups that did not opt
 * in are left untouched on both sides — their hierarchy is not managed.
 *
 * Two caveats `parents` inherits from being a synthetic field:
 *  - It is a *pseudo-field* of logical keys, NOT a real ChurchTools group column.
 *    Apply must route it to the per-edge endpoint (`PUT`/`DELETE
 *    /groups/{id}/parents/{parentId}`) — never PATCH it onto the group object.
 *  - The adopt snapshot (`managed.fields`) never carries `parents`, so a
 *    third-party re-parent surfaces as an ordinary `update`, not under drift.
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
  for (const external of Object.values(externalResources(state))) {
    if (external.type === "group") groupIdToKey.set(external.id, external.key);
  }

  // Single pass over the desired opt-ins (one copy of the predicate, mirroring the desired-side
  // guard below). A group's actual gets a `parents` set only when it opted in AND is a managed
  // GROUP in state — the managed-type guard from the old state-side iteration is preserved via the
  // `state.resources[d.key]` lookup. A group not yet in state (fresh, first apply) has no actual to
  // annotate; it is created instead.
  for (const d of desired) {
    if (d.type !== "group" || d.parents === undefined) continue;
    const managed = state.resources[d.key];
    if (!managed || managed.type !== "group") continue;
    const a = actual.get(d.key);
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
