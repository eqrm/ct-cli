/**
 * Portable-ruleset ergonomics (#76). A captured `dynamic: true` ruleset embeds ChurchQuery filters
 * that reference entities by raw numeric id (`ctgroup.id ∈ [148, …]`, `role.id ∈ [16, …]`). Those
 * ids are instance-specific, so a snapshot taken on prod is not portable to dev. The resolve/diff
 * engine ALREADY turns a logical `{ __ctRef }` marker anywhere in a ruleset into the per-host id
 * before the diff (src/resolve/refs.ts `collectRefs`/`deepMapRefs`, wired through src/engine/build.ts),
 * and the resolved form diffs byte-faithfully. The only missing piece is ergonomics: rewriting the
 * known-entity numeric ids a fresh capture carries into those markers. This module supplies the two
 * pure, offline pieces for that:
 *   - {@link VAR_REF_KINDS}: which ChurchQuery `var` maps to which {@link RefKind} (Stage 1), and
 *   - {@link portablizeRuleset}: the reverse-rewrite over caller-supplied catalogs (Stage 2).
 */
import type { GroupTypeRoleRef, RefKind, SimpleRef } from "../resolve/refs.js";
import type { RoleCatalogEntry } from "../resolve/reverse.js";
import { slug } from "../resources/registry.js";

export type { RoleCatalogEntry };

/**
 * ChurchQuery `var` name → the {@link RefKind} its id operand denotes. The kinds are the canonical
 * RefKind strings the resolver already speaks (src/resolve/refs.ts) — do NOT invent new ones.
 *
 * Verified against the real captured prod rulesets (ct-structure/rulesets/*.json, 2026-07-11); the
 * entity-bearing vars present there that this simple name-based table covers are exactly these four:
 *   - `ctgroup.id`          → `group`      (a group's own id)
 *   - `ctgroup.campusId`    → `campus`
 *   - `ctgroup.groupTypeId` → `group-type`
 *   - `person.campusId`     → `campus`
 *
 * `role.id` is DELIBERATELY NOT here (fixed in #76, reverting #86's `role-def` mapping). A ruleset's
 * `role.id` is a **groupTypeRoleId** — a role scoped to a group TYPE — not a global role-catalog id.
 * Role NAMES are not globally unique across group types (live prod, 2026-07-11: 3 roles named "Leiter",
 * 6 "Organisator", 6 "Mitglied", each on a different group type), so a NAME-KEYED `role-def` mapping
 * makes the resolver throw "ambiguous". So `role.id` needs the special case in
 * {@link portablizeRuleset}, which a lone name-based table entry cannot express. That special case
 * now emits, in order of preference:
 *
 *   1. `{ kind: "role-def", key }` when the role is under MANAGEMENT (#125) — a per-host id under a
 *      shared logical key, resolved from state, so it is unambiguous by construction. This is what
 *      #86 got wrong: the mapping is right, the name-keyed catalog it used to source it from was not.
 *   2. `{ kind: "group-type-role", groupType, role }` otherwise. The (groupTypeId, name) PAIR is
 *      unique in the common case (0 collisions across all 46 prod roles) — but NOT always, and when
 *      it collides there is no fix available in a shared config, which is precisely why (1) exists.
 *
 * Deliberately absent (the escape hatch — unknown vars are left untouched by {@link portablizeRuleset}):
 *   - `ctgroup.groupStatusId` — group statuses have NO REST catalog (#67; `/group/memberstatus` is a
 *     different dimension). Not a managed entity → never rewritten, stays a plain number.
 *   - `person.isArchived`, `person.dateOfDeath` — boolean/date literals, not entity refs.
 */
export const VAR_REF_KINDS: Readonly<Record<string, RefKind>> = {
  "ctgroup.id": "group",
  "ctgroup.campusId": "campus",
  "ctgroup.groupTypeId": "group-type",
  "ctgroup.groupStatusId": "group-status",
  "person.campusId": "campus",
};

/**
 * The ChurchQuery `var` whose id operands are group-type-scoped role ids (`groupTypeRoleId`), handled
 * by the {@link portablizeRuleset} role special case rather than the name-based {@link VAR_REF_KINDS}
 * table (see the comment there for why). The same rewrite also covers the OUT-of-query
 * `process.*.handleMembership.groupTypeRoleId` integer field (see {@link ROLE_FIELD_NAME}).
 */
const ROLE_VAR = "role.id";

/**
 * The `process.*.handleMembership.groupTypeRoleId` object field: the target role a query-result-only /
 * group-and-query-result membership is granted with. It is a groupTypeRoleId just like a `role.id`
 * operand, but sits OUTSIDE the query subtree, so the walk rewrites it by object-key match, not by a
 * sibling `{ var }` leaf. Rewritten through the SAME role catalog + group-type map (#76).
 */
const ROLE_FIELD_NAME = "groupTypeRoleId";

/**
 * Why an id could not be portablized (#101). ChurchTools treats a ruleset as opaque JSON and does
 * not validate the ids inside it, so a ruleset carrying prod's `ctgroup.id` applied to dev does not
 * error — the auto-group simply collects the wrong people, and `ct plan` stays green because the
 * ruleset round-trips byte-identically against the host it was written for. Naming the reason is what
 * turns that silent wrongness into a known risk.
 */
export type PortablizeReason =
  /** The dimension HAS a logical form, but no managed resource / catalog row carries this id. */
  | "unmanaged"
  /** A `role.id`/`groupTypeRoleId` whose row is absent from the `/group/roles` catalog. */
  | "role-unknown"
  /** A role resolved, but the group TYPE it belongs to is not managed, so no portable pair exists. */
  | "role-group-type-unmanaged"
  /** The dimension has no logical reference form at all (e.g. group statuses — no REST catalog). */
  | "no-ref-kind"
  /**
   * Reported by {@link scanUnportablized} only: the id sits in an entity position and is therefore
   * not portable, and that is ALL that was checked. The rewrite reasons above each assert a fact
   * about the host (this group is unmanaged / no such role row exists) that a positional scan with no
   * state, no catalogs and no network never established — claiming one of them here would print a
   * confident falsehood, and a remedy that fails, for an id whose group IS adopted.
   */
  | "left-numeric";

/** An id left numeric — collected, not thrown (the escape hatch), and reported with its reason (#101). */
export interface PortablizeWarning {
  var: string;
  id: number;
  reason: PortablizeReason;
  /** Human-readable explanation, ready to print. Never a bare restatement of {@link reason}. */
  detail: string;
}

/**
 * Entity-bearing ChurchQuery vars with NO logical reference form, and why (#101). These are reported
 * as left-numeric so a cross-host ruleset's real risk surface is complete — without them, adoption
 * would claim "everything portablized" while a `groupStatusId` sat frozen at prod's value.
 *
 * Deliberately a closed list rather than "every var we don't recognise": a `person.age > 18` operand
 * is a literal, not an id, and reporting it would bury the real findings in noise.
 */
const UNPORTABLE_ENTITY_VARS: Readonly<Record<string, string>> = {
  // #127. A ruleset that includes or excludes specific people by id is common — four of five
  // auto-group rulesets captured in one week did it — and it was the ONE entity var the audit never
  // mentioned, so the only way to find it was to read the captured JSON by hand. The absence of a
  // warning actively implied there was nothing to find.
  //
  // Unlike every other entry here, this one is not "pending a catalog": ct correctly does not manage
  // people, so there is no person catalog to resolve against and no `__ctRef` kind that could express
  // it. The ask is only that the tool SAY so, and the wording has to make clear it is unfixable
  // rather than not-yet-fixed — hence a remedy that is a decision ("remove the clause or accept the
  // divergence"), not a command to run.
  //
  // `person.id` 1 is the unluckiest case: it exists on every ChurchTools instance and is almost
  // always an administrator, so an exclusion clause aimed at one person on the source host lands on
  // someone real on the target host rather than harmlessly matching nothing.
  "person.id":
    "person ids are NEVER portable — ct does not manage people, so this ruleset names DIFFERENT " +
    "people on another host. Remove the clause or accept the divergence",
};

/**
 * The reason text for an id no logical key mapped to, per kind.
 *
 * Deliberately ID-FREE: {@link formatPortablizeWarnings} merges every id sharing a (var, reason) into
 * ONE line and prints the ids itself, so a detail naming one specific id would be stamped across all
 * of them — "12, 34, 56 left numeric — group #12 is not under management" reads as if the remedy for
 * #12 covers the other two.
 */
function unmanagedDetail(kind: RefKind): string {
  return kind === "group"
    ? "not under management — `ct adopt group <id>` for each (then re-adopt) makes them portable"
    : `no managed ${kind} on this host carries these ids`;
}

/** The scan-mode detail: says only what a positional scan can actually know. See "left-numeric". */
const LEFT_NUMERIC_DETAIL =
  "host-specific id(s) frozen into a cross-host ruleset — re-adopt the group with " +
  "`--with-dynamic` to rewrite them into logical references (it reports what, if anything, blocks each)";

export interface PortablizeOptions {
  /** Per-kind numeric-id → logical-key maps, supplied by the caller (from state/catalogs). Deterministic. */
  idToKeyByKind: Partial<Record<RefKind, Map<number, string>>>;
  /**
   * `/group/roles` catalog: groupTypeRoleId → {groupTypeId, name}, for rewriting `role.id` operands and
   * `handleMembership.groupTypeRoleId` fields (#76). Omit to leave every role id numeric (with a warning).
   */
  roleCatalog?: Map<number, RoleCatalogEntry>;
  /**
   * Managed group-type id → logical key, to reverse-map a role's `groupTypeId` to a portable group-type
   * key. A role whose group type is unmanaged (no key) is left numeric with a warning (escape hatch).
   */
  groupTypeIdToKey?: Map<number, string>;
  /**
   * Report-only mode ({@link scanUnportablized}): no maps are supplied, so every reason degrades to
   * the neutral `left-numeric` rather than asserting an unchecked one. Internal — callers that
   * actually rewrite never set it.
   */
  scanOnly?: boolean;
}

export interface PortablizeResult {
  ruleset: Record<string, unknown>;
  warnings: PortablizeWarning[];
}

/** A JSONLogic `{ var: "name" }` leaf — the sole shape that anchors an id operand to a known kind. */
function varNameOf(node: unknown): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  const obj = node as Record<string, unknown>;
  return Object.keys(obj).length === 1 && typeof obj.var === "string" ? obj.var : undefined;
}

/**
 * Rewrite the known-entity numeric ids a captured ruleset carries into logical `{ __ctRef }` markers,
 * so the same snapshot resolves per-host (#76 Stage 2). Pure and deterministic: the caller supplies the
 * id→key maps and the role catalog (from managed state / master-data catalogs) — no network, no mutation
 * of the input.
 *
 * Simple entity vars ({@link VAR_REF_KINDS}) rewrite off a sibling `{ var: <name> }` leaf: each numeric
 * id in the operand position becomes a `{ __ctRef, kind, key }` marker when it maps to a managed key,
 * else stays numeric and is reported in `warnings`. The `role.id` var and the out-of-query
 * `handleMembership.groupTypeRoleId` field are groupTypeRoleIds: each is looked up in `roleCatalog` to
 * recover its (groupTypeId, name), the groupTypeId is reverse-mapped to a managed group-type key, and a
 * `{ __ctRef, kind: "group-type-role", groupType, role }` marker is emitted (else numeric + warning).
 * Every other position — unknown vars (`groupStatusId`, `isArchived`, …), string labels, booleans —
 * passes through structurally unchanged. Expects a normalized ruleset (numeric-string ids already
 * coerced to numbers by src/engine/dynamic.ts `normalizeRuleset`, as the adopt path does).
 */
export function portablizeRuleset(
  ruleset: Record<string, unknown>,
  { idToKeyByKind, roleCatalog, groupTypeIdToKey, scanOnly }: PortablizeOptions,
): PortablizeResult {
  const warnings: PortablizeWarning[] = [];

  /** Push either the checked reason, or — in scan mode — the only one a positional scan earned. */
  const warnLeftNumeric = (
    varName: string,
    id: number,
    checked: () => Omit<PortablizeWarning, "var" | "id">,
  ) =>
    warnings.push({
      var: varName,
      id,
      ...(scanOnly ? { reason: "left-numeric" as const, detail: LEFT_NUMERIC_DETAIL } : checked()),
    });

  const marker = (kind: RefKind, key: string): SimpleRef => ({ __ctRef: true, kind, key }) as SimpleRef;

  /**
   * Does this role's (groupTypeId, slug(name)) pair match more than one catalog row — i.e. is the
   * `group-type-role` marker unable to name it? Counted once per call, over the whole catalog, using
   * the SAME key the resolver filters on (`resolveGroupTypeRole`), so the two agree by construction.
   */
  const pairCounts = new Map<string, number>();
  const pairKey = (e: RoleCatalogEntry): string => `${e.groupTypeId} ${slug(e.name)}`;
  if (roleCatalog) {
    for (const e of roleCatalog.values()) {
      const k = pairKey(e);
      pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
    }
  }
  const roleNameAmbiguous = (e: RoleCatalogEntry): boolean => (pairCounts.get(pairKey(e)) ?? 0) > 1;

  const mapScalar = (value: unknown, kind: RefKind, varName: string): unknown => {
    if (typeof value !== "number") return value; // booleans/strings/nulls are literals, never entity ids
    const key = idToKeyByKind[kind]?.get(value);
    if (key !== undefined) return marker(kind, key);
    warnLeftNumeric(varName, value, () => ({ reason: "unmanaged", detail: unmanagedDetail(kind) }));
    return value;
  };

  // A groupTypeRoleId → (group-type, role-name) marker, resolvable per host by the `group-type-role`
  // resolver. Leaves the id numeric (with a warning) when the role is unknown to the catalog or its
  // group type is unmanaged — the escape hatch, identical in spirit to mapScalar's.
  const mapRoleScalar = (value: unknown, varName: string): unknown => {
    if (typeof value !== "number") return value;
    const entry = roleCatalog?.get(value);
    const groupTypeKey = entry ? groupTypeIdToKey?.get(entry.groupTypeId) : undefined;

    // A MANAGED role-def wins over the (group-type, role-name) pair — but ONLY when that pair is
    // genuinely ambiguous (#125, narrowed).
    //
    // The pair is resolved by filtering `/group/roles` on (groupTypeId, slug(name)), so two rows
    // sharing a name on one group type are a hard error — and neither remedy the error suggests works
    // for a config shared across hosts. "Rename to disambiguate" means editing ChurchTools master
    // data to work around a config limitation, and in the observed case one of the two rows is CT's
    // own stock `leader`. "Pass a numeric id" cannot work at all: the roles have different ids per
    // host (#127 on one, #207 on the other) and `ConfigContext` deliberately exposes no env or host,
    // so there is nowhere to branch. A `role-def` ref carries a per-host id in managed state — the
    // same mechanism `group` and `campus` refs already use — so it makes that case fixable IN CONFIG,
    // by adopting the role under a shared key on both hosts.
    //
    // Why it must NOT win unconditionally: `role-def` is the WEAKER reference of the two off this
    // host. `Resolver.resolveSimple` falls back to `resolveFromCatalog`, which keys `/group/roles` by
    // slug(name) ALONE — the very mapping this module's header calls wrong for a `role.id`, and the
    // reason #76 reverted #86. So on a host where the role was never adopted under the shared key, a
    // name matching exactly one row resolves SILENTLY to a role on a different group type (only a
    // multi-row match errors), and the ruleset then matches the wrong role. The `group-type-role`
    // marker cannot fail that way: it resolves on the (groupTypeId, name) pair, which is unique by
    // construction. So the safe pair stays the safe pair, and `role-def` is reserved for the case
    // that has no safe pair to lose.
    const ambiguous = entry !== undefined && roleNameAmbiguous(entry);
    if (ambiguous || groupTypeKey === undefined) {
      const roleDefKey = idToKeyByKind["role-def"]?.get(value);
      if (roleDefKey !== undefined) {
        return marker("role-def", roleDefKey);
      }
    }
    if (entry && groupTypeKey !== undefined) {
      return {
        __ctRef: true,
        kind: "group-type-role",
        groupType: groupTypeKey,
        role: entry.name,
      } as GroupTypeRoleRef;
    }
    // Two genuinely different failures, kept apart: the role is unknown to `/group/roles` at all, or
    // it resolved but its group type is unmanaged. They need different fixes, so they get different
    // reasons rather than one "could not portablize".
    warnLeftNumeric(varName, value, () =>
      entry
        ? {
            reason: "role-group-type-unmanaged",
            detail:
              "the role's group type is not managed — adopt that group type to make the " +
              "(group-type, role) pair portable",
          }
        : {
            reason: "role-unknown",
            detail: "no /group/roles row on this host carries these groupTypeRoleIds",
          },
    );
    return value;
  };

  const mapOperand = (value: unknown, map: (v: unknown) => unknown): unknown =>
    Array.isArray(value) ? value.map(map) : map(value); // oneof id list vs `==` scalar

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const varIdx = node.findIndex((el) => varNameOf(el) !== undefined);
      if (varIdx >= 0) {
        const varName = varNameOf(node[varIdx])!;
        const kind = VAR_REF_KINDS[varName];
        if (kind !== undefined) {
          // Known simple entity var: keep the `{ var }` leaf, rewrite the sibling id operand(s).
          return node.map((el, i) =>
            i === varIdx ? el : mapOperand(el, (v) => mapScalar(v, kind, varName)),
          );
        }
        if (varName === ROLE_VAR) {
          // Group-type-scoped role var (#76): rewrite siblings through the role catalog, not VAR_REF_KINDS.
          return node.map((el, i) => (i === varIdx ? el : mapOperand(el, (v) => mapRoleScalar(v, ROLE_VAR))));
        }
        const unportable = UNPORTABLE_ENTITY_VARS[varName];
        if (unportable !== undefined) {
          // A known ENTITY var with no logical form: nothing to rewrite, but it is still a
          // host-specific id frozen into a cross-host file, so it is reported rather than swallowed.
          node.forEach((el, i) => {
            if (i === varIdx) return;
            for (const v of Array.isArray(el) ? el : [el]) {
              if (typeof v === "number") {
                warnings.push({ var: varName, id: v, reason: "no-ref-kind", detail: unportable });
              }
            }
          });
        }
        // Unknown var (escape hatch) — recurse structurally, leaving its numeric ids untouched.
      }
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // `handleMembership.groupTypeRoleId` sits outside the query, so it has no `{ var }` leaf to key
        // off — rewrite it by object-key match, through the same role catalog as the `role.id` operand.
        out[k] = k === ROLE_FIELD_NAME && typeof v === "number" ? mapRoleScalar(v, ROLE_FIELD_NAME) : walk(v);
      }
      return out;
    }
    return node;
  };

  return { ruleset: walk(ruleset) as Record<string, unknown>, warnings };
}

/**
 * Find every host-specific numeric id still sitting in an entity position of a ruleset (#101).
 *
 * This is {@link portablizeRuleset}'s reporting half without the rewrite: it takes a ruleset as
 * AUTHORED (logical `{ __ctRef }` markers still un-resolved, plain numbers still plain) and returns
 * what would not survive a move to another host. `ct plan` runs it over every declared dynamic group
 * so an un-portablized ruleset is a visible, recurring risk rather than a green plan that quietly
 * collects the wrong people on the wrong instance — the payload of an auto-group is group
 * membership, which in this domain is exactly what carries permission grants.
 *
 * It reports by POSITION, not by lookup: any number left in a known entity var's operand is
 * unportable by construction, because a portablized one would be a `{ __ctRef }` marker instead. So
 * it needs no catalogs, no state and no network, and is safe to run on every plan.
 */
export function scanUnportablized(ruleset: unknown): PortablizeWarning[] {
  const { warnings } = portablizeRuleset((ruleset ?? {}) as Record<string, unknown>, {
    // No id→key maps and no role catalog: every numeric entity id therefore fails to map and is
    // reported, while an already-portable `{ __ctRef }` marker is not a number and is never flagged.
    idToKeyByKind: {},
    // …which also means the "unmanaged" / "role-unknown" verdicts the rewrite path computes were
    // never actually checked here — `scanOnly` degrades them to `left-numeric` so this scan states
    // only what position proves. Without it, `ct plan` tells someone whose group IS adopted that it
    // is not under management, and hands them a `ct adopt` that fails.
    scanOnly: true,
  });
  return warnings;
}

/**
 * One line per (var, reason), naming the ids — the shape both `ct adopt --with-dynamic` and
 * `ct plan` print (#101). Grouped so a ruleset with 30 unmanaged group ids is one readable line, not
 * thirty; ids are sorted so the output is stable across runs and diffable in CI logs.
 *
 * The `detail` is part of the grouping key, not just the reason: merging ids under ONE detail is only
 * honest while that detail holds for all of them, so a detail that ever names a specific id splits
 * into its own line instead of being stamped across the group (details are kept id-free above).
 */
export function formatPortablizeWarnings(warnings: readonly PortablizeWarning[]): string[] {
  const grouped = new Map<string, { var: string; detail: string; ids: number[] }>();
  for (const w of warnings) {
    const k = `${w.var} ${w.reason} ${w.detail}`;
    const hit = grouped.get(k);
    if (hit) {
      if (!hit.ids.includes(w.id)) hit.ids.push(w.id);
    } else {
      grouped.set(k, { var: w.var, detail: w.detail, ids: [w.id] });
    }
  }
  return [...grouped.values()].map(
    (g) => `${g.var}: ${g.ids.sort((a, b) => a - b).join(", ")} left numeric — ${g.detail}`,
  );
}
