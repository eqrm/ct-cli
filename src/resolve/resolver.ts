/**
 * The per-host reference resolver (#20). Turns logical {@link Ref}s into numeric
 * ChurchTools ids, sourced (in order) from:
 *
 *  1. Managed desired ∪ state, by logical key. A key that names a managed resource
 *     in state resolves to its id; a key declared in this config but not yet in
 *     state resolves to a {@link PendingRef} (its id is only known after the
 *     resource tier applies — re-resolved at apply time, mirroring the permission
 *     scope pattern in src/permissions/scope.ts).
 *  2. Live catalog master data, matched by `slug(name) === key` with an exact-name
 *     secondary: campus → /campuses, group-type → /group/grouptypes, role-def → /group/roles.
 *     Each catalog is fetched at most once per run and cached by a `Map<RefKind, Promise>`,
 *     so the resolver is safe to share across `buildPlan` and `buildPermissionPlan` running
 *     concurrently (both await the same in-flight promise). group-status ("group-status" /
 *     `ref.status`) has NO catalog here — ChurchTools exposes no REST list endpoint for group
 *     statuses at all (live-verified 2026-07-10 on eqrm prod; see the note by `CATALOG_PATH`
 *     below and #67). A declared `status:` field fails fast at eval time (src/config/context.ts)
 *     before it ever reaches this resolver — but a `groupStatusId: ref.status(...)` value skips
 *     that guard (the id-field escape hatch accepts any Ref) and lands on step 3 below, where
 *     `notFound` special-cases "group-status" to give the same actionable message instead of
 *     the generic "declare/adopt it" advice, which would be wrong (no such resource, no catalog).
 *  3. Hard error naming the kind, key, referencing site, and host.
 *
 * Unknown / ambiguous references THROW (a config error — distinct from the
 * degrade-and-continue fetchErrors path). Resolved ids are never written back to
 * config; only state carries ids.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource } from "../engine/types.js";
import { slug } from "../resources/registry.js";
import {
  collectRefs,
  deepMapRefs,
  GROUP_STATUS_NO_CATALOG,
  isPendingRef,
  isRef,
  pendingRef,
  refKey,
  refLabel,
  type GroupRoleRef,
  type GroupTypeRoleRef,
  type PendingRef,
  type Ref,
  type RefKind,
  type SimpleRef,
} from "./refs.js";

/** ref kind → managed resource type (state/desired). group-status has neither: no catalog and never managed (#67). */
const REF_KIND_TYPE: Partial<Record<RefKind, string>> = {
  campus: "campus",
  "group-type": "group-type",
  // Person statuses became an adoptable resource in #96, so a `personStatus: "…"` domain now
  // resolves from managed state / this run's declarations FIRST and only falls through to the
  // `/statuses` catalog for a status this config does not own. That ordering is what makes a
  // status declared in the same config usable as a permission domain (it resolves to a PendingRef,
  // which buildPermissionPlan carries as a pending domain, #69).
  "person-status": "person-status",
  "role-def": "group-role",
  group: "group",
};

/**
 * ref kind → live catalog path. `group` has no catalog (managed-only); `group-role` is gated.
 *
 * `group-status` is deliberately ABSENT (#67, disproving the prior assumption documented here):
 * `GET /group/memberstatus` is NOT a group-status catalog — live-verified 2026-07-10 on eqrm prod,
 * it returns MEMBER statuses (`{id: "active", name: "Active"}, {id: "requested", ...}`, STRING ids),
 * a completely different dimension from `groupStatusId` (numeric — e.g. 1 = active, 4 = archived on
 * that instance). Further probing found no REST list endpoint for group statuses at all
 * (`/groups/statuses` parses as `/groups/{groupId}`, `/group/statuses` and `/groupstatuses` 404) —
 * neither read nor write. So `status:` sugar fails fast at eval time instead (src/config/context.ts)
 * rather than reaching this resolver and either resolving against the wrong dimension or landing
 * here as an unconditional hard error. If CT ever ships a real group-status endpoint, add it back
 * here and restore the `status` entry to `ID_SUGAR` in context.ts.
 */
const CATALOG_PATH: Partial<Record<RefKind, string>> = {
  campus: "/campuses",
  // Bereiche/departments — the `cdb_bereich` permission scope dimension (#98). Catalog-ONLY, with no
  // REF_KIND_TYPE entry above: `GET /departments` exists but no POST/PUT/DELETE does (live-probed on
  // eqrm prod, CT 3.135.2, 2026-08-13), so a department is resolvable by name on every host yet can
  // never be declared, adopted or created. Rows carry {id, name, nameTranslated, sortKey, shorty}.
  department: "/departments",
  "group-type": "/group/grouptypes",
  // PERSON statuses — the domain of a `status` permission declaration (#90). Unlike GROUP statuses
  // (see the note above), these DO have a flat REST catalog: `GET /statuses` returns
  // `[{id, name, shorty, …}]` — live-verified 2026-08-10 on eqrm prod. (`/person/masterdata` carries
  // the same rows under a `statuses` key, but nested; this catalog reader expects a top-level array.)
  "person-status": "/statuses",
  "role-def": "/group/roles",
};

interface CatalogRecord {
  id: number;
  name?: string;
  [k: string]: unknown;
}

export interface ResolverDeps {
  client: Pick<CtClient, "get">;
  state: State;
  desired: DesiredResource[];
  /** Host label for error messages. Defaults to `state.host`. */
  host?: string;
}

/**
 * VERIFIED LIVE (2026-08-13, eqrm prod, CT 3.135.2) — the model for a `group_role` domain (#25):
 *
 *   1. A `group_role` domain is keyed by CT's internal (group, role) PAIRING id — one id per
 *      (this specific group, this specific role). It is NEITHER the group's id NOR the shared
 *      role-definition id (docs/handbuch/permissions.md "domainId semantics").
 *   2. That pairing id is exposed on the group's OWN role list, `GET /groups/{groupId}/roles`, as
 *      each row's {@link GROUP_ROLE_PAIRING_FIELD} (`id`), and rows carry a `name` we match the
 *      declared role against (slug-primary, exact-name secondary — same as every master-data catalog).
 *
 * Evidence (two anchors on DIFFERENT group types, each a group whose type has many members, so the
 * per-group `id` and the type-level `groupTypeRoleId` are guaranteed to differ):
 *   - For both, the role row's `id` appears in `GET /permissions/group_role` as a live `domainId`
 *     carrying that role's authored grants (1 row on one anchor, 35 on the other).
 *   - For both, the row's `groupTypeRoleId` appears NOWHERE in the whole domainId set — decisive,
 *     because a type-level key would have to appear if the domain were type-scoped.
 *   - On one anchor, the two roles with no authored rights have no domain at all, which is exactly
 *     what a per-(group, role) pairing predicts (a domain exists only where rights were written).
 *
 * A prior, cruder probe saw `groupTypeRoleId` values that also occur in the domainId set; those are
 * numeric COLLISIONS with the low `id`s of long-existing role rows, not evidence of a type-level key.
 *
 * If a future CT release moves the pairing id to another field or endpoint, change the two constants
 * below — call sites do not change. The numeric `id:` escape hatch on `ct.groupRole` remains supported.
 */
const GROUP_ROLE_ENDPOINT = (groupId: number): string => `/groups/${groupId}/roles`;
const GROUP_ROLE_PAIRING_FIELD = "id";

export class Resolver {
  private readonly client: Pick<CtClient, "get">;
  private readonly state: State;
  private readonly host: string;
  private readonly catalogs = new Map<RefKind, Promise<CatalogRecord[]>>();
  /** Per-group role list cache (group_role domain resolution), keyed by group id, fetched at most once. */
  private readonly groupRoleLists = new Map<number, Promise<CatalogRecord[]>>();
  /** Declared logical keys indexed by resource type — a same-run target that resolves to pending. */
  private readonly declaredByType = new Map<string, Set<string>>();

  constructor(deps: ResolverDeps) {
    this.client = deps.client;
    this.state = deps.state;
    this.host = deps.host ?? deps.state.host;
    for (const d of deps.desired) {
      let set = this.declaredByType.get(d.type);
      if (!set) {
        set = new Set();
        this.declaredByType.set(d.type, set);
      }
      set.add(d.key);
    }
  }

  /** Resolve one Ref to a numeric id, or a {@link PendingRef} for a same-run-created managed target. */
  async resolve(r: Ref, site: string): Promise<number | PendingRef> {
    if (r.kind === "group-role") return this.resolveGroupRole(r, site);
    if (r.kind === "group-type-role") return this.resolveGroupTypeRole(r, site);
    // (1) managed desired ∪ state by logical key
    const type = REF_KIND_TYPE[r.kind];
    if (type !== undefined) {
      const managed = this.state.resources[r.key];
      if (managed && managed.type === type) return managed.id;
      if (this.declaredByType.get(type)?.has(r.key)) return pendingRef(r);
    }
    // (2) live catalog
    if (CATALOG_PATH[r.kind] !== undefined) return this.resolveFromCatalog(r, site);
    // (3) hard error
    throw this.notFound(r, site);
  }

  /**
   * Deep-rewrite every Ref embedded in `value` to its resolved id / pending marker. Returns the
   * original reference unchanged when it holds no Refs (numbers pass through untouched — the numeric
   * escape hatch — so a fully-numeric field bag is never rebuilt and diffs number↔number).
   */
  async resolveValue(value: unknown, site: string): Promise<unknown> {
    const refs = collectRefs(value);
    if (refs.length === 0) return value;
    const byKey = new Map<string, number | PendingRef>();
    for (const r of refs) {
      const k = refKey(r);
      if (!byKey.has(k)) byKey.set(k, await this.resolve(r, site));
    }
    return deepMapRefs(value, (r) => byKey.get(refKey(r)));
  }

  private catalog(kind: RefKind): Promise<CatalogRecord[]> {
    let p = this.catalogs.get(kind);
    if (!p) {
      const path = CATALOG_PATH[kind]!;
      p = this.client.get<CatalogRecord[]>(path).then((rows) => (Array.isArray(rows) ? rows : []));
      this.catalogs.set(kind, p);
    }
    return p;
  }

  private async resolveFromCatalog(r: SimpleRef, site: string): Promise<number> {
    const rows = await this.catalog(r.kind);
    const pick = (candidates: CatalogRecord[]): number => {
      if (candidates.length > 1) throw this.ambiguous(r, site, candidates);
      return candidates[0]!.id;
    };
    // Primary: slugified name. Secondary: exact (case-sensitive) name — covers a name that does not
    // survive slugging cleanly. Ambiguity in either bucket is a hard error listing the candidates.
    const bySlug = rows.filter((row) => typeof row.name === "string" && slug(row.name) === r.key);
    if (bySlug.length >= 1) return pick(bySlug);
    const byExact = rows.filter((row) => row.name === r.key);
    if (byExact.length >= 1) return pick(byExact);
    throw this.notFound(r, site);
  }

  /**
   * Resolve a `group_role` domain by its (group, role) pair to the numeric pairing domainId (#25).
   * See the VERIFIED LIVE block above the {@link GROUP_ROLE_ENDPOINT} constant for the model this
   * implements and the evidence for it. Returns a number — never a {@link PendingRef}: the pairing id only exists
   * once the group does, so a same-run-declared (not-yet-created) group is a hard error here (its id
   * cannot be known at plan time), telling the author to apply the group first or pass a numeric id.
   */
  private async resolveGroupRole(r: GroupRoleRef, site: string): Promise<number> {
    const groupId = this.groupIdForRole(r, site);
    const rows = await this.groupRoleList(groupId);
    // slug-primary, exact-name secondary — identical matching to resolveFromCatalog, so a role named
    // e.g. "Leiter" resolves whether the author writes "leiter" (slug) or "Leiter" (exact).
    const bySlug = rows.filter((row) => typeof row.name === "string" && slug(row.name) === slug(r.role));
    const matches = bySlug.length >= 1 ? bySlug : rows.filter((row) => row.name === r.role);
    if (matches.length === 0) {
      const available = rows
        .map((row) => (typeof row.name === "string" ? JSON.stringify(row.name) : `#${row.id}`))
        .join(", ");
      throw new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: group #${groupId} has ` +
          `no role named "${r.role}"${available ? ` (available: ${available})` : ""}. Fix the role name, ` +
          `or pass a numeric id.`,
      );
    }
    if (matches.length > 1) {
      const list = matches.map((c) => `${JSON.stringify(c.name)} (#${c.id})`).join(", ");
      throw new Error(
        `Ambiguous ${refLabel(r)} referenced at ${site} on ${this.host}: ${matches.length} roles on ` +
          `group #${groupId} match — ${list}. Rename to disambiguate, or pass a numeric id.`,
      );
    }
    const domainId = matches[0]![GROUP_ROLE_PAIRING_FIELD];
    if (typeof domainId !== "number") {
      throw new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: the matched role row ` +
          `carries no numeric "${GROUP_ROLE_PAIRING_FIELD}" (the assumed pairing domainId — see #25). ` +
          `Pass a numeric id.`,
      );
    }
    return domainId;
  }

  /**
   * Resolve a group-type-scoped role (`groupTypeRoleId`) by its (group-type, role) pair to this host's
   * numeric id (#76). Role names are NOT globally unique across group types (live prod, 2026-07-11: 3
   * "Leiter", 6 "Organisator", 6 "Mitglied" — each on a different group type), which is exactly why a
   * lone `role-def` name is ambiguous; the (groupTypeId, name) PAIR is unique (0 collisions across all
   * 46 prod roles). So: resolve the group-type key to this host's group-type id (managed state ∪ the
   * `/group/grouptypes` catalog — reusing the normal group-type resolution), then pick the ONE
   * `/group/roles` row whose `groupTypeId` matches AND whose name slugs to `role`. Exactly one match by
   * construction; 0 or >1 is a hard error listing candidates (mirrors resolveGroupRole's error style).
   * Returns a number — never a PendingRef (the catalog id exists independently of any same-run apply).
   */
  private async resolveGroupTypeRole(r: GroupTypeRoleRef, site: string): Promise<number> {
    const groupTypeId = await this.groupTypeIdForRole(r, site);
    const rows = await this.catalog("role-def"); // /group/roles — same cached catalog as role-def
    const inType = rows.filter((row) => Number(row.groupTypeId) === groupTypeId);
    // slug-primary, exact-name secondary — identical matching to every other catalog lookup.
    const bySlug = inType.filter((row) => typeof row.name === "string" && slug(row.name) === slug(r.role));
    const matches = bySlug.length >= 1 ? bySlug : inType.filter((row) => row.name === r.role);
    if (matches.length === 0) {
      const available = inType
        .map((row) => (typeof row.name === "string" ? JSON.stringify(row.name) : `#${row.id}`))
        .join(", ");
      throw new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: group type #${groupTypeId} ` +
          `has no role named "${r.role}"${available ? ` (available: ${available})` : ""}. Fix the role ` +
          `name, or pass a numeric id.`,
      );
    }
    if (matches.length > 1) {
      const list = matches.map((c) => `${JSON.stringify(c.name)} (#${c.id})`).join(", ");
      throw new Error(
        `Ambiguous ${refLabel(r)} referenced at ${site} on ${this.host}: ${matches.length} roles on group ` +
          `type #${groupTypeId} match — ${list}. Rename to disambiguate, or pass a numeric id.`,
      );
    }
    return matches[0]!.id;
  }

  /**
   * Resolve the group-type half of a group-type-role ref to a concrete numeric id, reusing the normal
   * group-type resolution (managed state ∪ `/group/grouptypes` catalog). A same-run-declared group type
   * would resolve to a PendingRef here — reject it, since the role catalog can't be filtered without a
   * concrete id (its message tells the author to apply the group type first or pass a numeric role id).
   */
  private async groupTypeIdForRole(r: GroupTypeRoleRef, site: string): Promise<number> {
    const gtRef: SimpleRef = { __ctRef: true, kind: "group-type", key: r.groupType };
    const resolved = await this.resolve(gtRef, site);
    if (typeof resolved !== "number") {
      throw new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: group type "${r.groupType}" ` +
          `is declared in this config but not yet created — a group-type-scoped role id only exists once ` +
          `the group type does. Apply the group type first, then re-run, or pass a numeric id.`,
      );
    }
    return resolved;
  }

  /** Resolve the group half of a group_role ref to a managed group id (state ∪ declared). */
  private groupIdForRole(r: GroupRoleRef, site: string): number {
    const managed = this.state.resources[r.group];
    if (managed && managed.type === "group") return managed.id;
    if (this.declaredByType.get("group")?.has(r.group)) {
      throw new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: group "${r.group}" is ` +
          `declared in this config but not yet created — its (group, role) pairing id only exists once ` +
          `the group does. Apply the group first, then re-run, or pass a numeric id.`,
      );
    }
    throw new Error(
      `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: no managed group named ` +
        `"${r.group}" is declared or adopted. Declare/adopt it, fix the key, or pass a numeric id.`,
    );
  }

  private groupRoleList(groupId: number): Promise<CatalogRecord[]> {
    let p = this.groupRoleLists.get(groupId);
    if (!p) {
      p = this.client
        .get<CatalogRecord[]>(GROUP_ROLE_ENDPOINT(groupId))
        .then((rows) => (Array.isArray(rows) ? rows : []));
      this.groupRoleLists.set(groupId, p);
    }
    return p;
  }

  private notFound(r: SimpleRef, site: string): Error {
    // group-status (#67, reviewer follow-up): a `groupStatusId: ref.status(...)` value bypasses the
    // eval-time guard in src/config/context.ts (the id-field escape hatch accepts any Ref) and lands
    // here. The generic "declare/adopt it, fix the key" advice below is actively wrong for
    // group-status — there is no such managed resource type and no catalog to adopt against — so
    // give the same actionable message the eval-time guard uses instead (shared constant so the two
    // sites can't drift).
    if (r.kind === "group-status") {
      return new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: ${GROUP_STATUS_NO_CATALOG}`,
      );
    }
    const catalog = CATALOG_PATH[r.kind];
    // A catalog-only kind has no managed resource type, so "Declare/adopt it" is advice the tool
    // cannot honour (#96's exact complaint about the old person-status message). Departments are
    // read-only in ChurchTools — GET /departments exists, no write verb does — so the only real
    // fixes are correcting the name or falling back to a numeric id.
    if (catalog && REF_KIND_TYPE[r.kind] === undefined) {
      return new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: no live ${r.kind} at ` +
          `${catalog} matches key "${r.key}". ${r.kind}s are a read-only catalog in ChurchTools — they ` +
          `cannot be declared or adopted, so fix the key/name (list them with \`ct get ${r.kind}s\`) or ` +
          `use a numeric id.`,
      );
    }
    const where = catalog
      ? `no managed resource and no live ${r.kind} at ${catalog} matches key "${r.key}"`
      : `no managed ${r.kind} named "${r.key}" is declared or adopted`;
    return new Error(
      `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: ${where}. ` +
        `Declare/adopt it, fix the key/name, or use a numeric id.`,
    );
  }

  private ambiguous(r: SimpleRef, site: string, candidates: CatalogRecord[]): Error {
    const list = candidates.map((c) => `${JSON.stringify(c.name)} (#${c.id})`).join(", ");
    return new Error(
      `Ambiguous ${refLabel(r)} referenced at ${site} on ${this.host}: ${candidates.length} live ` +
        `${r.kind}s match — ${list}. Rename to disambiguate, or use a numeric id.`,
    );
  }
}

/**
 * Re-resolve every {@link PendingRef} in a value against the POST-execute state, at apply time.
 * The referenced resource's tier applies before the referencing resource's (campus tier 0 < group
 * tier 1), so its id is guaranteed present in state by the time the referencing body is built —
 * analogous to the permission scope `reresolveTuple`. Passes non-pending values through untouched.
 */
export function reresolvePendingValue(value: unknown, state: State): unknown {
  if (isPendingRef(value)) return pendingIdFromState(value.__pendingRef, state);
  if (Array.isArray(value)) return value.map((v) => reresolvePendingValue(v, state));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = reresolvePendingValue(v, state);
    return out;
  }
  return value;
}

function pendingIdFromState(r: Ref, state: State): number {
  if (r.kind === "group-role") {
    // A group_role ref resolves to a concrete pairing id at plan time (never a PendingRef — a
    // same-run group is rejected up front), so a pending one should never reach apply.
    throw new Error(`Pending ${refLabel(r)} reached apply — group_role refs never go pending (#25).`);
  }
  if (r.kind === "group-type-role") {
    // A group-type-role ref resolves to a concrete /group/roles id at plan time (the catalog id exists
    // independently of any same-run apply), so a pending one should never reach apply either (#76).
    throw new Error(`Pending ${refLabel(r)} reached apply — group-type-role refs never go pending (#76).`);
  }
  const managed = state.resources[r.key];
  if (!managed) {
    throw new Error(
      `Pending reference ${refLabel(r)} did not resolve after apply — "${r.key}" is not in state. ` +
        `buildPlan orders the target before its referencer (injected dependency edge), so this ` +
        `usually means the target's create failed earlier in this run.`,
    );
  }
  return managed.id;
}

/** Re-export for callers that only need the guard without importing refs.ts directly. */
export { isRef };
