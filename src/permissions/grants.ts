/**
 * Grant tuples and set reconciliation. A grant's identity is (authId, sorted dataId, type).
 * Actuals exclude the self-re-adding system baseline (modifiedPid === -1) and inherited rows,
 * so reconciliation owns only user-authored grants and never fights the platform.
 */
/**
 * The permission domains this tool reconciles. `status` is CT's PERSON-status domain (#90) — a grant
 * there applies to every person carrying that status, which is the only instance-wide lever CT offers
 * short of granting per person (a people domain, permanently out of scope — see engine/guard.ts).
 */
export type DomainType = "group_role" | "group_type_role" | "status";

// What reconciliation owns vs. leaves untouched is decided SOLELY by `normalizeActual` below:
// it drops the self-re-adding system baseline (`modifiedPid === -1`) and any `isInherited` row, so
// only admin-authored DIRECT grants are managed. There is intentionally NO authId-based cutoff.
//
// (History, #65: an earlier `isInheritedOnlyRight(domainType, authId) = authId >= 10000` predicate
// gated declaration/adoption/diff on the authId. That was too broad — it also excluded the
// admin-authored `authId >= 10000` group-member rights (e.g. "Add group members" 10107) that CT DOES
// let you write on a group_type_role domain and that Equippers prod actually curates. Verified live
// on prod `group_type_role/9`: 24 such rows carry `isInherited:false` and a real admin's `modifiedPid`.
// The real, verified boundary is inheritance + system-baseline, which normalizeActual already
// enforces on every path that reads actuals — the #65 no-op guarantee holds without the authId cutoff.)

export interface GrantTuple {
  authId: number;
  dataId: number[];
  type: "grant" | "revoke";
  /**
   * For a scoped grant: the symbolic scope key this tuple was resolved from. Retained so the
   * dataId can be RE-RESOLVED against post-execute state at apply time — which fixes both a grant
   * scoped to a group created in the same apply (its dataId is `pending` at plan time) and a stale
   * dataId after a scope-target group is recreated (#29, #33.3). Absent on unscoped grants and on
   * actual tuples read back from ChurchTools.
   */
  scopeKey?: string;
  /**
   * The MANAGED RESOURCE TYPE behind {@link scopeKey} — "group" for the historical group dimension,
   * "campus" / "group-type" for a typed logical scope ref (#98). Read by `reresolveTuple` so the
   * post-apply state lookup checks the right type; absent means "group" for backward compatibility
   * with tuples built before typed scope refs existed.
   */
  scopeType?: string;
  /**
   * True when `scopeKey` names a group DECLARED in this config but not yet created (absent from
   * state at plan time). Its real dataId is unknown until `executePlan` runs, so the plan renders
   * it as pending and it always diffs into `toPut`. Cleared once re-resolved at apply time.
   */
  pending?: boolean;
}
export interface RawPermission {
  authId: number; dataId: number | null; type: "grant" | "revoke"; domainId: number;
  isInherited?: boolean; meta?: { modifiedPid?: number };
}

/**
 * Identity key for set reconciliation. A pending tuple has no resolved dataId yet, so key it by
 * its symbolic scope key instead — that keeps it distinct from an unscoped grant (`dataId: []`)
 * and guarantees it can never collide with an actual row (actuals never carry a scopeKey), so it
 * always lands in `toPut`.
 */
export function tupleKey(t: { authId: number; dataId: number[]; type: string; scopeKey?: string; pending?: boolean }): string {
  const scope = t.pending && t.scopeKey != null ? `pending:${t.scopeKey}` : [...t.dataId].sort((a, b) => a - b).join(",");
  return `${t.type}:${t.authId}:${scope}`;
}

export function normalizeActual(rows: RawPermission[]): GrantTuple[] {
  const out: GrantTuple[] = [];
  for (const r of rows) {
    if (r.meta?.modifiedPid === -1) continue; // system baseline — invisible to reconciliation
    if (r.isInherited) continue;              // inherited — not directly owned here
    // dataId is [] or a single element (CT reads scoped grants back one row per dataId), so there is
    // nothing to sort here — and tupleKey sorts defensively anyway when it builds the identity key.
    out.push({ authId: r.authId, dataId: r.dataId == null ? [] : [r.dataId], type: r.type });
  }
  return out;
}

export interface GrantDiff { toPut: GrantTuple[]; toDelete: GrantTuple[]; preserved: GrantTuple[] }

export function diffGrants(desired: GrantTuple[], actual: GrantTuple[]): GrantDiff {
  // Reconciliation owns only user-authored GRANT rows. `desiredTuples` only ever emits
  // `type: "grant"`, so an explicit deny row (`type: "revoke"`) has no desired counterpart and
  // would land in `toDelete` — silently removing an admin's deny. Treat non-grant rows as
  // unmanaged: keep them out of the diff and surface them as an informational `preserved` note.
  const managedActual = actual.filter((t) => t.type === "grant");
  const preserved = actual.filter((t) => t.type !== "grant");
  const desiredKeys = new Map(desired.map((t) => [tupleKey(t), t]));
  const actualKeys = new Map(managedActual.map((t) => [tupleKey(t), t]));
  const toPut = [...desiredKeys].filter(([k]) => !actualKeys.has(k)).map(([, t]) => t);
  const toDelete = [...actualKeys].filter(([k]) => !desiredKeys.has(k)).map(([, t]) => t);
  return { toPut, toDelete, preserved };
}
