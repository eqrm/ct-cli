/**
 * The diff engine: compare desired state (config) against the state file and
 * the actual ChurchTools values, and produce an ordered plan.
 *
 * Managed-guard: only resources in config or the state file are ever
 * considered. Anything else in ChurchTools is invisible — never diffed, never
 * proposed for deletion.
 */
import type { State } from "../state/state.js";
import type { DesiredResource, FieldChange, Plan, PlanItem } from "./types.js";
import { orderKeys, tierOf } from "./graph.js";

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Field-by-field diff over the desired fields only (the ones we manage). */
export function diffFields(desired: Record<string, unknown>, actual: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, to] of Object.entries(desired)) {
    if (!deepEqual(actual[field], to)) {
      changes.push({ field, from: actual[field], to });
    }
  }
  return changes;
}

function creationChanges(fields: Record<string, unknown>): FieldChange[] {
  return Object.entries(fields).map(([field, to]) => ({ field, from: undefined, to }));
}

/** Drift over the managed fields: what changed in ChurchTools since the snapshot (last known → actual). */
export function driftFields(
  lastKnown: Record<string, unknown>,
  actual: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, known] of Object.entries(lastKnown)) {
    if (!deepEqual(actual[field], known)) {
      changes.push({ field, from: known, to: actual[field] });
    }
  }
  return changes;
}

export function computePlan(
  desired: DesiredResource[],
  state: State,
  actualById: Map<number, Record<string, unknown>>,
): Plan {
  const desiredByKey = new Map(desired.map((d) => [d.key, d]));
  const creates: PlanItem[] = [];
  const updates: PlanItem[] = [];
  const deletes: PlanItem[] = [];

  for (const d of desired) {
    const managed = state.resources[d.key];
    if (!managed) {
      creates.push({
        type: d.type,
        key: d.key,
        id: null,
        action: "create",
        changes: creationChanges(d.fields),
      });
      continue;
    }
    const actual = actualById.get(managed.id);
    if (!actual) {
      creates.push({
        type: d.type,
        key: d.key,
        id: null,
        action: "create",
        changes: creationChanges(d.fields),
        recreated: true,
      });
      continue;
    }
    const changes = diffFields(d.fields, actual);
    const drift = driftFields(managed.fields, actual);
    updates.push({
      type: d.type,
      key: d.key,
      id: managed.id,
      action: changes.length > 0 ? "update" : "no-op",
      changes,
      drift: drift.length > 0 ? drift : undefined,
    });
  }

  for (const managed of Object.values(state.resources)) {
    if (desiredByKey.has(managed.key)) {
      continue;
    }
    const actual = actualById.get(managed.id);
    deletes.push({
      type: managed.type,
      key: managed.key,
      id: managed.id,
      action: actual ? "delete" : "no-op",
      changes: [],
    });
  }

  const applyOrder = orderKeys(desired);
  const rank = new Map(applyOrder.map((key, i) => [key, i]));
  const ordered = [...creates, ...updates].sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  // Deletes run in reverse dependency order (highest tier first).
  deletes.sort((a, b) => tierOf(b.type) - tierOf(a.type));

  return { items: [...ordered, ...deletes] };
}
