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
  | "security-level"
  | "comment-viewer"
  | "group-type"
  | "group-status"
  | "person-status"
  | "role-def"
  | "group"
  | "group-role"
  | "group-type-role"
  | "group-member-field";

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

/** Simple key-addressed reference: campus / department / security level / group type / group status / person status / role definition / group. */
export interface SimpleRef {
  __ctRef: true;
  kind:
    | "campus"
    | "department"
    | "security-level"
    | "comment-viewer"
    | "group-type"
    | "group-status"
    | "person-status"
    | "role-def"
    | "group";
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

/**
 * Compound reference: a GROUP-SCOPED MEMBER FIELD, addressed by its portable
 * `(group key, local field key)` pair (#135) — `ojbp_2026_27_praktikum_1::wahl`.
 *
 * It has to be compound for the same reason {@link GroupTypeRoleRef} does, only more strongly: a
 * member field belongs to exactly ONE group and is not globally reusable, so its local key alone
 * names nothing. Two groups declaring `wahl` are two independent fields with two different
 * ChurchTools ids, and that is the whole point of the blueprint use case — running the same
 * function for 25/26 and 26/27 must mint fresh fields per group, with no id from the other year
 * participating in resolution.
 *
 * This is what lets a dynamic-group ruleset name a member field portably instead of freezing this
 * host's numeric field id into a file that is then applied somewhere else.
 */
export interface GroupMemberFieldRef {
  __ctRef: true;
  kind: "group-member-field";
  group: string;
  field: string;
}

export type Ref = SimpleRef | GroupRoleRef | GroupTypeRoleRef | GroupMemberFieldRef;

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
   * `churchdb:view alldata` ("Personen eines Bereiches sehen") — #98.
   *
   * Catalog-only FOR NOW: `ct` reads `GET /departments` and resolves a name against it, but declares
   * and creates nothing, so an unresolvable name is a hard error rather than a create. That is a
   * statement about what this tool drives today, NOT about ChurchTools: `/departments` has no REST
   * write verb (live-probed against the instance OpenAPI spec, eqrm prod CT 3.135.2, 2026-08-13), but
   * the admin UI does create Bereiche, through the legacy `POST /index.php?q=churchdb/ajax`
   * `func=saveMasterData` interface that appears in no OpenAPI spec (captured 2026-08-13, #108/#109).
   * Making departments declarable is tracked there.
   */
  department: (key: string): SimpleRef => ({
    __ctRef: true,
    kind: "department",
    key: requireKey("department", key),
  }),
  /**
   * A SECURITY LEVEL (`/securitylevels`), the scope dimension of `cc_securitylevel` rights such as
   * `churchdb:+see persons` — #110.
   *
   * Exists because "security-level ids are universal, so a numeric literal is portable" was an
   * assumption, not a guarantee: `cc_securitylevel` is an admin-editable master-data table (`id`,
   * `bezeichnung`, `sortkey`) with an auto-increment id — confirmed in the instance's own master-data
   * registry, eqrm-dev CT 3.135.2, 2026-08-14 — so 1/2/3 line up across instances by convention, not
   * by construction. Reordering is not even exotic: `PATCH /securitylevels/{id}` takes `newid` +
   * `forcereorder`. Referencing a level by name makes a config say what it means on any host, and
   * hard-error instead of silently granting the wrong level when the name is absent.
   *
   * Catalog-only TODAY, and unlike {@link ref.department} that is not forced by CT:
   * `/securitylevels/{id}` exposes POST, PATCH and DELETE (live-probed 2026-08-14), so security
   * levels could become a fully managed resource. They are not one yet because CREATE is
   * `POST /securitylevels/{id}` — an id-bearing create path the registry's `collectionPath` contract
   * does not model. Tracked on #110.
   *
   * Numeric scope entries stay fully supported (#49): the names are localised German strings with
   * parentheses ("Stufe 3 (Hoch)" slugs to `stufe_3_hoch`), so a rename breaks a ref where a number
   * would have survived. Pick per config which risk you would rather carry.
   */
  securityLevel: (key: string): SimpleRef => ({
    __ctRef: true,
    kind: "security-level",
    key: requireKey("security-level", key),
  }),
  /**
   * A COMMENT VIEWER (`/person/commentviewers`), the scope dimension of `cdb_comment_viewer` rights
   * such as `churchdb:view comments` — #102.
   *
   * The dimension existed in the catalog all along but had no logical form, which is what made three
   * role instances on `Bereich Pastoral Care` undeclarable: each was blocked by exactly ONE
   * comment_viewer-scoped grant, so the whole role instance fell out of `ct coverage` as unmanageable.
   * #109 assumed this would need the legacy master-data endpoint; it does not — `/person/commentviewers`
   * is conventional REST (`[{id, name, sortKey}]`, plus POST/PUT/DELETE), live-probed on eqrm-dev
   * CT 3.135.2, 2026-08-14.
   *
   * DECLARABLE since #151 — `ct.commentViewer({ key, name, sortKey })` — and the promotion was not
   * cosmetic: this was the last scope dimension a config could not express portably, so a
   * `churchdb:view comments` grant had to carry a raw host-specific `dataId` that silently means
   * something else (or nothing) on another host. Resolution now goes managed-state-first, live
   * `/person/commentviewers` catalog second, so an existing name ref against a viewer this config
   * does not own keeps working unchanged.
   */
  commentViewer: (key: string): SimpleRef => ({
    __ctRef: true,
    kind: "comment-viewer",
    key: requireKey("comment-viewer", key),
  }),
  groupType: (key: string): SimpleRef => ({
    __ctRef: true,
    kind: "group-type",
    key: requireKey("group-type", key),
  }),
  status: (key: string): SimpleRef => ({
    __ctRef: true,
    kind: "group-status",
    key: requireKey("group-status", key),
  }),
  /**
   * A PERSON status (`/statuses` — "0 - First", "3 - Group Active", …), the domain of a `status`
   * permission declaration. Unrelated to {@link ref.status} (GROUP status, `groupStatusId`), which
   * has no catalog at all (#67) — person statuses do, so this one resolves by name like any other
   * master-data ref.
   */
  personStatus: (key: string): SimpleRef => ({
    __ctRef: true,
    kind: "person-status",
    key: requireKey("person-status", key),
  }),
  roleDef: (key: string): SimpleRef => ({
    __ctRef: true,
    kind: "role-def",
    key: requireKey("role-def", key),
  }),
  group: (key: string): SimpleRef => ({ __ctRef: true, kind: "group", key: requireKey("group", key) }),
  /**
   * A `group_role` permission domain, by its (group, role) pair (#25). The resolver maps it to the
   * numeric pairing domainId at plan time by matching the role name against the group's role list
   * (see the VERIFIED LIVE block in src/resolve/resolver.ts; the numeric `id:` escape hatch remains
   * the fallback). The Ref itself is an inert sentinel until then.
   *
   * When the GROUP is declared in the same config but does not exist on the target host yet, the
   * domain resolves to a {@link PendingRef} and is completed during apply (#106) — after the group is
   * created, from its own `/groups/{id}/roles`. That is what keeps one config plannable on a host
   * where the group already exists AND on a fresh one where it does not.
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
  /**
   * A group-scoped member FIELD (#135), by its portable `(group key, local field key)` pair — the
   * `ojbp_2026_27_praktikum_1::wahl` identity. The resolver maps it to this host's numeric field id
   * from `GET /groups/{groupId}/memberfields`; a field the same config declares but that does not
   * exist on this host yet resolves to a {@link PendingRef} and is completed during apply, after the
   * owning group's fields have been created. See {@link GroupMemberFieldRef}.
   */
  groupMemberField: (group: string, field: string): GroupMemberFieldRef => ({
    __ctRef: true,
    kind: "group-member-field",
    group: requireKey("group-member-field", group),
    field: requireKey("group-member-field", field),
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
    case "group-member-field":
      return `group-member-field:${r.group}::${r.field}`;
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
    case "group-member-field":
      // The portable `<group>::<field>` identity itself — the same string the docs, the plan and
      // `ct destroy --member-field` all use, so one identity is spoken everywhere (#135).
      return `group-member-field:${r.group}::${r.field}`;
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
    typeof value === "object" && value !== null && isRef((value as { __pendingRef?: unknown }).__pendingRef)
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
 * dependencies the referencing resource needs.
 *
 * The compound kinds contribute nothing here. `group-type-role` never goes pending at all. A
 * `group-role` CAN (#106), but only in the permission-DOMAIN position — permissions are applied after
 * every resource tier, so they need no per-resource ordering edge — and never inside a resource's
 * field bag, which is the only thing this function walks.
 */
export function collectPendingRefKeys(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (isPendingRef(v)) {
      const r = v.__pendingRef;
      // A pending group-scoped member field (#135) DOES belong here, and its ordering dependency is
      // the OWNING GROUP: the field is created by that group's own apply item (before its dynamic
      // ruleset — see engine/synthetic.ts), so sequencing the group first is exactly what makes a
      // ruleset on another group able to name a field created in the same run. A self-reference (the
      // ruleset and the field on the same group) is dropped by buildPlan's `k !== d.key` filter.
      if (r.kind === "group-member-field") out.push(r.group);
      // Only the simple, single-`key` kinds contribute an apply-order dependency here — see the note
      // above for why the other compound ones cannot reach this walk.
      else if (r.kind !== "group-role" && r.kind !== "group-type-role") out.push(r.key);
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
