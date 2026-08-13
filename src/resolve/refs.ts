/**
 * Logical references (#20). A `Ref` is a leaf sentinel that stands in for a
 * ChurchTools numeric id the config author does not want to hardcode — a group
 * type by name, a campus by key, a permission domain by (group, role). It is the
 * one shared currency every id-bearing surface speaks: DSL id fields, query
 * `var` values, permission `domainId`.
 *
 * A config emits Refs at eval time (host-agnostic — no ids, no network). The
 * per-host {@link Resolver} (src/resolve/resolver.ts) turns each Ref into a
 * number at plan time, or into a `PendingRef` when it names a resource created
 * in the same run (id unknown until apply). Refs are leaf sentinels only: a Ref
 * never contains another Ref, and resolved ids are never written back to config.
 *
 * Two authoring forms compile to the same Refs:
 *  1. Named logical string fields on a declaration — `ct.group({ campus: "mainz" })`
 *     sugars into a Ref-valued `campusId` in `toDesired`.
 *  2. The explicit `ref.*` helper for inline positions — `ref.campus("mainz")`
 *     inside a query `var` value or `ct.groupTypeRole({ groupType: "…" })`.
 */

export type RefKind =
  | "campus"
  | "department"
  | "group-type"
  | "group-status"
  | "person-status"
  | "role-def"
  | "group"
  | "group-role"
  | "group-type-role";

/**
 * Shared explanation for why a group-status reference can never be resolved by name (#67):
 * ChurchTools exposes no REST catalog for group statuses — `GET /group/memberstatus` is a
 * different dimension (member statuses, string ids), live-verified 2026-07-10 on eqrm prod.
 * Used verbatim by both guards that can see a group-status reference, so their messages can't
 * drift apart:
 *  - the eval-time guard (src/config/context.ts) for a declared `status:` field, and
 *  - the plan-time guard (src/resolve/resolver.ts) for a `groupStatusId: ref.status(...)` value
 *    that bypassed the eval-time guard (the id-field escape hatch accepts any Ref) and reached
 *    the resolver directly.
 */
export const GROUP_STATUS_NO_CATALOG =
  `group statuses have no REST catalog (GET /group/memberstatus is a different dimension: member ` +
  `statuses, string ids — verified 2026-07-10). Declare a numeric "groupStatusId" instead (e.g. "groupStatusId: 1").`;

/** Simple key-addressed reference: campus / department / group type / group status / person status / role definition / group. */
export interface SimpleRef {
  __ctRef: true;
  kind: "campus" | "department" | "group-type" | "group-status" | "person-status" | "role-def" | "group";
  key: string;
}

/** Compound reference: a permission `group_role` domain, addressed by its (group, role) pair. */
export interface GroupRoleRef {
  __ctRef: true;
  kind: "group-role";
  group: string;
  role: string;
}

/**
 * Compound reference: a group-type-scoped role — CT's `groupTypeRoleId`, addressed by its
 * (group-type, role-name) pair (#76). This is what a captured dynamic-group ruleset's ChurchQuery
 * `role.id` operand (and a `process.*.handleMembership.groupTypeRoleId` field) actually holds: a role
 * that belongs to a specific group TYPE, exposed at `GET /group/roles` with a `groupTypeId` per row.
 *
 * It is a NEW kind, deliberately NOT reused from either {@link SimpleRef} `role-def` or the compound
 * {@link GroupRoleRef} `group-role`, because neither can address this id correctly:
 *   - `role-def` keys the GLOBAL `/group/roles` catalog by `slug(name)` alone — but role NAMES are not
 *     globally unique across group types (live prod, 2026-07-11: 3 roles named "Leiter", 6 "Organisator",
 *     6 "Mitglied", each on a different group type), so a lone name is genuinely ambiguous and the
 *     resolver throws. That was #86's wrong decision, which this ref replaces.
 *   - `group-role` is a (group-INSTANCE, role) permission-pairing domainId resolved via a specific
 *     group's `/groups/{id}/roles` — a different id in a different currency, keyed by a group not a type.
 * The (groupTypeId, name) PAIR IS unique (verified: 0 collisions across all 46 prod roles), so this ref
 * carries the group-type key + role name and the resolver picks the one `/group/roles` row matching both.
 * Mirrors {@link GroupRoleRef}'s compound shape (two string fields, no single `key`) for consistency.
 */
export interface GroupTypeRoleRef {
  __ctRef: true;
  kind: "group-type-role";
  groupType: string;
  role: string;
}

export type Ref = SimpleRef | GroupRoleRef | GroupTypeRoleRef;

function requireKey(kind: RefKind, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ref.${kind}: expected a non-empty string key, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * The explicit reference helper for inline positions (query `var` values, permission domains).
 * Named-field sugar on declarations (`campus`/`groupType`/`status`) produces the same Refs.
 */
export const ref = {
  campus: (key: string): SimpleRef => ({ __ctRef: true, kind: "campus", key: requireKey("campus", key) }),
  /**
   * A Bereich/DEPARTMENT (`/departments`), the scope dimension of `cdb_bereich` rights such as
   * `churchdb:view alldata` ("Personen eines Bereiches sehen") — #98. Unlike campuses and group
   * types, departments are a READ-ONLY ref catalog: `GET /departments` exists but there is no POST /
   * PUT / DELETE (live-probed against the instance OpenAPI spec, eqrm prod CT 3.135.2, 2026-08-13).
   * So a department can be REFERENCED by name on any host, but never declared, adopted or created —
   * an unresolvable name is a hard error, not a create.
   */
  department: (key: string): SimpleRef => ({ __ctRef: true, kind: "department", key: requireKey("department", key) }),
  groupType: (key: string): SimpleRef => ({ __ctRef: true, kind: "group-type", key: requireKey("group-type", key) }),
  status: (key: string): SimpleRef => ({ __ctRef: true, kind: "group-status", key: requireKey("group-status", key) }),
  /**
   * A PERSON status (`/statuses` — "0 - First", "3 - Group Active", …), the domain of a `status`
   * permission declaration. Unrelated to {@link ref.status} (GROUP status, `groupStatusId`), which
   * has no catalog at all (#67) — person statuses do, so this one resolves by name like any other
   * master-data ref.
   */
  personStatus: (key: string): SimpleRef => ({ __ctRef: true, kind: "person-status", key: requireKey("person-status", key) }),
  roleDef: (key: string): SimpleRef => ({ __ctRef: true, kind: "role-def", key: requireKey("role-def", key) }),
  group: (key: string): SimpleRef => ({ __ctRef: true, kind: "group", key: requireKey("group", key) }),
  /**
   * A `group_role` permission domain, by its (group, role) pair (#25). The resolver maps it to the
   * numeric pairing domainId at plan time by matching the role name against the group's role list
   * (see the ASSUMPTION block in src/resolve/resolver.ts — the exact source is unverified; the
   * numeric `id:` escape hatch remains the fallback). The Ref itself is an inert sentinel until then.
   */
  groupRole: (group: string, role: string): GroupRoleRef => ({
    __ctRef: true,
    kind: "group-role",
    group: requireKey("group-role", group),
    role: requireKey("group-role", role),
  }),
  /**
   * A group-type-scoped role (`groupTypeRoleId`), by its (group-type, role-name) pair (#76). The
   * resolver maps it to this host's numeric groupTypeRoleId by finding the `/group/roles` row whose
   * `groupTypeId` is the group-type's id AND whose name slugs to `role`. See {@link GroupTypeRoleRef}
   * for why the pair is required (role names are not globally unique across group types).
   */
  groupTypeRole: (groupType: string, role: string): GroupTypeRoleRef => ({
    __ctRef: true,
    kind: "group-type-role",
    groupType: requireKey("group-type-role", groupType),
    role: requireKey("group-type-role", role),
  }),
};

export function isRef(value: unknown): value is Ref {
  return typeof value === "object" && value !== null && (value as { __ctRef?: unknown }).__ctRef === true;
}

/** Stable identity string for caching/deduping a Ref (not for display — see {@link refLabel}). */
export function refKey(r: Ref): string {
  switch (r.kind) {
    case "group-role":
      return `group-role:${r.group} ${r.role}`;
    case "group-type-role":
      return `group-type-role:${r.groupType} ${r.role}`;
    default:
      return `${r.kind}:${r.key}`;
  }
}

/** Human-readable label for error messages and plan rendering. */
export function refLabel(r: Ref): string {
  switch (r.kind) {
    case "group-role":
      return `group-role(group=${r.group}, role=${r.role})`;
    case "group-type-role":
      return `group-type-role(groupType=${r.groupType}, role=${r.role})`;
    default:
      return `${r.kind}:${r.key}`;
  }
}

/**
 * A same-run-created managed target: the Ref names a resource declared in this config but not yet
 * in state, so its id is unknown until the resource tier applies. Mirrors the permission scope
 * pending marker (src/permissions/scope.ts) — it renders in the plan and is re-resolved against
 * post-execute state at apply time (see {@link reresolvePendingValue} in resolver.ts).
 */
export interface PendingRef {
  __pendingRef: Ref;
}

export function pendingRef(r: Ref): PendingRef {
  return { __pendingRef: r };
}

export function isPendingRef(value: unknown): value is PendingRef {
  return (
    typeof value === "object" &&
    value !== null &&
    isRef((value as { __pendingRef?: unknown }).__pendingRef)
  );
}

/**
 * Deep-walk a value, replacing every leaf {@link Ref} with `fn(ref)` and passing everything else
 * through structurally. Rebuilds arrays/plain objects; Refs are leaves so recursion stops at them.
 */
export function deepMapRefs(value: unknown, fn: (r: Ref) => unknown): unknown {
  if (isRef(value)) return fn(value);
  if (Array.isArray(value)) return value.map((v) => deepMapRefs(v, fn));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepMapRefs(v, fn);
    return out;
  }
  return value;
}

/** Collect every {@link Ref} embedded in a value (deduping is the caller's job via {@link refKey}). */
export function collectRefs(value: unknown): Ref[] {
  const out: Ref[] = [];
  const walk = (v: unknown): void => {
    if (isRef(v)) {
      out.push(v);
      return; // Refs are leaves — never nested
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(value);
  return out;
}

/**
 * Collect the managed logical keys named by every {@link PendingRef} in a value. Pending markers
 * always point at a same-run declared resource, so these keys are exactly the apply-order
 * dependencies the referencing resource needs (group-role refs resolve to a concrete id at plan
 * time and never go pending).
 */
export function collectPendingRefKeys(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (isPendingRef(v)) {
      const r = v.__pendingRef;
      // Compound refs (group-role, group-type-role) resolve to a concrete id at plan time and never go
      // pending, so only the simple, single-`key` kinds contribute an apply-order dependency here.
      if (r.kind !== "group-role" && r.kind !== "group-type-role") out.push(r.key);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(value);
  return out;
}

/** True when a value contains at least one {@link PendingRef} marker (short-circuit for apply-time rewrite). */
export function hasPendingRef(value: unknown): boolean {
  if (isPendingRef(value)) return true;
  if (Array.isArray(value)) return value.some(hasPendingRef);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasPendingRef);
  }
  return false;
}
