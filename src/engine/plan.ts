/**
 * The diff engine: compare desired state (config) against the state file and
 * the actual ChurchTools values, and produce an ordered plan.
 *
 * Managed-guard: only resources in config or the state file are ever
 * considered. Anything else in ChurchTools is invisible — never diffed, never
 * proposed for deletion.
 *
 * `actual` is keyed by **logical key**, not CT id: ids are only unique within a
 * type (the Mainz campus is id 0), so a numeric-id map would collide across
 * types. Logical keys are globally unique in the state file.
 */
import type { State } from "../state/state.js";
import {
  resourceDisplayName,
  type DesiredResource,
  type FieldChange,
  type Plan,
  type PlanItem,
} from "./types.js";
import { orderKeys, isKnownType } from "./graph.js";
import { RESOURCES } from "../resources/registry.js";

/**
 * Refuse to plan a changed `id` on a CALLER-ASSIGNED-ID type (#110).
 *
 * For those types the id is not an opaque handle the tool owns — it is the resource's meaning, and
 * it is referenced from all over the instance (a security level id appears on person fields and in
 * every `cc_securitylevel` grant scope). ChurchTools models changing one as a RENUMBER — `PATCH`
 * with `newid` + `forcereorder` — not as a field update, and doing it silently rewrites what every
 * numeric grant on that dimension grants.
 *
 * The executor would otherwise emit a plain `PATCH {id: <new>}`, which is the wrong shape: CT would
 * either ignore it (a plan that never converges) or 409. So this is a hard error naming the real
 * operation, and the author performs it deliberately in ChurchTools.
 */
function assertNoRenumber(type: string, key: string, changes: FieldChange[], currentId: number): void {
  if (!RESOURCES[type]?.callerAssignedId) return;
  const idChange = changes.find((c) => c.field === "id");
  if (!idChange) return;
  throw new Error(
    `${type} "${key}": cannot change id ${currentId} → ${JSON.stringify(idChange.to)}. For ${type}s ` +
      `the id is chosen by the config and referenced across the instance, so changing it is a ` +
      `RENUMBER (ChurchTools: PATCH with "newid" + "forcereorder"), not a field update — and it ` +
      `silently changes what every numeric scope naming the old id grants. \`ct\` does not drive ` +
      `that. Renumber in the ChurchTools admin UI and update the config to match, or declare a ` +
      `separate ${type} under a new key.`,
  );
}

/**
 * Structural deep-equal. Order-independent for objects, so a mere key-order
 * difference between the API's JSON and the config's object is NOT reported as a
 * change (a `JSON.stringify` comparison would flag it, proposing an update that
 * can never converge).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/** Field-by-field diff over the first arg's fields only. `diffFields(fields, {})` yields a full creation change set. */
export function diffFields(desired: Record<string, unknown>, actual: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, to] of Object.entries(desired)) {
    if (!deepEqual(actual[field], to)) {
      changes.push({ field, from: actual[field], to });
    }
  }
  return changes;
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

/**
 * Tag every entry in `changes` (a `diffFields(desired, actual)` result) with its
 * {@link FieldChangeSource} (#24) — a JSON consumer's per-field attribution of WHY the field
 * differs from ChurchTools. `driftedFields` must be the field-name set of an already-computed
 * `driftFields(lastKnown, actual)` result, so a field the state snapshot never tracked (and thus
 * can never appear in `drift`) is never phantom-attributed to drift here either — same precedent
 * as the existing `drift` field (see "does not drift on a pre-#21 state snapshot" in plan.test.ts).
 */
function attributeChanges(
  changes: FieldChange[],
  lastKnown: Record<string, unknown>,
  driftedFields: ReadonlySet<string>,
): FieldChange[] {
  return changes.map((c) => {
    if (!driftedFields.has(c.field)) {
      return { ...c, source: "config" };
    }
    // Pure drift: the desired value still matches the last-known snapshot, so the only reason this
    // field differs from `actual` is the manual edit — applying reverts it. Otherwise both the
    // config AND ChurchTools moved independently since the last apply.
    return { ...c, source: deepEqual(c.to, lastKnown[c.field]) ? "drift" : "config+drift" };
  });
}

/** A create (or recreate) has no last-known snapshot to compare against — every field is "config". */
function attributeCreate(changes: FieldChange[]): FieldChange[] {
  return changes.map((c) => ({ ...c, source: "config" }));
}

export interface ComputePlanOptions {
  /** Logical keys whose managed type has no registry entry — cannot be fetched, so left untouched (not recreated/deleted). */
  unresolved?: ReadonlySet<string>;
  /**
   * Logical keys whose actual value could not be fetched (a non-404 error). Mapped
   * to a short status descriptor (e.g. "500"). These are NOT vanished resources, so
   * they must be excluded from create/recreate/stale classification and surfaced as
   * a fetch failure — otherwise a transient 500 reads as "recreate — missing in CT".
   */
  fetchFailed?: ReadonlyMap<string, string>;
}

export function computePlan(
  desired: DesiredResource[],
  state: State,
  actual: Map<string, Record<string, unknown>>,
  opts: ComputePlanOptions = {},
): Plan {
  const unresolved = opts.unresolved ?? new Set<string>();
  const fetchFailed = opts.fetchFailed ?? new Map<string, string>();

  for (const d of desired) {
    if (!isKnownType(d.type)) {
      throw new Error(
        `Unknown resource type "${d.type}" for "${d.key}" — no apply tier defined. Add a registry entry in src/resources/registry.ts.`,
      );
    }
  }

  // Reject duplicate desired keys up front. The DSL path (evaluateConfig) already dedups, but a
  // programmatic caller (import command, test harness) that hands `computePlan` a raw array must not
  // silently last-wins: `desiredByKey` would collapse the duplicates while the loop below emits both,
  // corrupting the plan. Fail loudly instead.
  const seen = new Set<string>();
  for (const d of desired) {
    if (seen.has(d.key)) {
      throw new Error(`Duplicate desired key "${d.key}" — each resource must have a unique logical key.`);
    }
    seen.add(d.key);
  }

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
        displayName: resourceDisplayName(d.fields, d.key),
        id: null,
        action: "create",
        changes: attributeCreate(diffFields(d.fields, {})),
        preventDestroy: d.preventDestroy,
        allowDuplicateName: d.allowDuplicateName,
      });
      continue;
    }
    if (managed.type !== d.type) {
      throw new Error(
        `Logical key "${d.key}" is a ${d.type} in the config but a ${managed.type} in the state file. ` +
          `Rename one to reconcile.`,
      );
    }
    if (unresolved.has(d.key)) {
      // Type has no registry entry — we could not fetch its actual value, so we cannot diff it.
      updates.push({
        type: d.type,
        key: d.key,
        displayName: resourceDisplayName(d.fields, d.key),
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "unresolved-type",
        preventDestroy: d.preventDestroy,
      });
      continue;
    }
    if (fetchFailed.has(d.key)) {
      // Fetch errored (non-404). We can't diff it, and it is NOT gone — do not propose a recreate.
      updates.push({
        type: d.type,
        key: d.key,
        displayName: resourceDisplayName(d.fields, d.key),
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "fetch-failed",
        detail: fetchFailed.get(d.key),
        preventDestroy: d.preventDestroy,
      });
      continue;
    }
    const a = actual.get(d.key);
    if (!a) {
      creates.push({
        type: d.type,
        key: d.key,
        displayName: resourceDisplayName(d.fields, d.key),
        id: null,
        action: "create",
        changes: attributeCreate(diffFields(d.fields, {})),
        note: "recreate",
        preventDestroy: d.preventDestroy,
        allowDuplicateName: d.allowDuplicateName,
      });
      continue;
    }
    const changes = diffFields(d.fields, a);
    assertNoRenumber(d.type, d.key, changes, managed.id);
    const drift = driftFields(managed.fields, a);
    const driftedFields = new Set(drift.map((c) => c.field));
    updates.push({
      type: d.type,
      key: d.key,
      displayName: resourceDisplayName(d.fields, d.key),
      id: managed.id,
      action: changes.length > 0 ? "update" : "no-op",
      changes: attributeChanges(changes, managed.fields, driftedFields),
      // The fetched actual — the write body is built from this, not the stale state snapshot (#27).
      actual: a,
      drift: drift.length > 0 ? drift : undefined,
      preventDestroy: d.preventDestroy,
    });
  }

  for (const managed of Object.values(state.resources)) {
    if (desiredByKey.has(managed.key)) {
      continue;
    }
    if (unresolved.has(managed.key)) {
      deletes.push({
        type: managed.type,
        key: managed.key,
        displayName: resourceDisplayName(managed.fields, managed.key),
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "unresolved-type",
      });
      continue;
    }
    if (fetchFailed.has(managed.key)) {
      // Fetch errored — we can't tell if it is gone, so do not propose a stale-prune.
      deletes.push({
        type: managed.type,
        key: managed.key,
        displayName: resourceDisplayName(managed.fields, managed.key),
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "fetch-failed",
        detail: fetchFailed.get(managed.key),
      });
      continue;
    }
    const a = actual.get(managed.key);
    if (!a) {
      // Already gone from ChurchTools but still in the state file — surface it so the user prunes state (not a silent no-op).
      deletes.push({
        type: managed.type,
        key: managed.key,
        displayName: resourceDisplayName(managed.fields, managed.key),
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "stale",
      });
      continue;
    }
    deletes.push({
      type: managed.type,
      key: managed.key,
      displayName: resourceDisplayName(managed.fields, managed.key),
      id: managed.id,
      action: "delete",
      changes: [],
    });
  }

  const rank = new Map(orderKeys(desired).map((key, i) => [key, i]));
  const ordered = [...creates, ...updates].sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));

  // Deletes run in reverse dependency order. Reuse the same topological sort (reversed) rather than a
  // coarser tier-only heuristic, so intra-tier edges are honoured once the state file carries them.
  const deleteRank = new Map(
    orderKeys(deletes.map((it) => ({ type: it.type, key: it.key, fields: {}, dependsOn: [] }))).map(
      (key, i) => [key, i],
    ),
  );
  deletes.sort((a, b) => (deleteRank.get(b.key) ?? 0) - (deleteRank.get(a.key) ?? 0));

  return { items: [...ordered, ...deletes] };
}
