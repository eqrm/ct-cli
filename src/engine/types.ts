/**
 * Shared engine types: the desired-state resources parsed from config, and the
 * plan produced by diffing desired vs state vs actual.
 */

export interface DesiredResource {
  type: string;
  key: string;
  /** Managed fields — same shape as the Phase 2 registry snapshot, so they diff like-for-like against actual. */
  fields: Record<string, unknown>;
  /** Parent logical key (group hierarchy). Also contributes a dependency edge. */
  parent?: string;
  /** Logical keys this resource must be applied after (includes `parent`). */
  dependsOn: string[];
}

export type PlanAction = "create" | "update" | "delete" | "no-op";

/**
 * A resource that needs surfacing beyond its plain action:
 *  - `recreate`         — desired + managed, but vanished from ChurchTools (a create that replaces a dead id).
 *  - `stale`            — managed + dropped from config + already gone from ChurchTools (nothing to delete; prune from state).
 *  - `unresolved-type`  — managed but its type has no registry entry, so it cannot be fetched/diffed (left untouched).
 */
export type PlanNote = "recreate" | "stale" | "unresolved-type";

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface PlanItem {
  type: string;
  key: string;
  /** CT id when known (updates/deletes); null for creates. */
  id: number | null;
  action: PlanAction;
  /** For create: every desired field; update: only the differences; delete/no-op: empty. */
  changes: FieldChange[];
  /** Manual changes in ChurchTools since adoption (last-known snapshot vs actual). */
  drift?: FieldChange[];
  /** A non-standard state the plan must surface (see {@link PlanNote}). */
  note?: PlanNote;
}

export interface Plan {
  /** Items in execution order: creates/updates in dependency order, deletes in reverse. */
  items: PlanItem[];
}

export function summarize(plan: Plan): Record<PlanAction, number> {
  const counts: Record<PlanAction, number> = { create: 0, update: 0, delete: 0, "no-op": 0 };
  for (const item of plan.items) {
    counts[item.action]++;
  }
  return counts;
}
