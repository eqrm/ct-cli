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
  groupScopedRows,
  matchesLocalKey,
  memberFieldRowId,
  memberFieldsReadPath,
} from "../engine/member-fields.js";
import {
  collectRefs,
  deepMapRefs,
  GROUP_STATUS_NO_CATALOG,
  isPendingRef,
  isRef,
  pendingRef,
  refKey,
  refLabel,
  type GroupMemberFieldRef,
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
  // Bereiche became a managed resource in #108 (writes go through the legacy master-data endpoint,
  // reads stay `GET /departments`), so a `{ department: "…" }` ref resolves from managed state first
  // and only falls back to the catalog for a Bereich this config does not own.
  department: "department",
  // Security levels became a managed resource in #110, so — exactly like person statuses above — a
  // `{ securityLevel: "…" }` ref resolves from managed state / this run's declarations FIRST and only
  // falls through to the `/securitylevels` catalog for a level this config does not own. That
  // ordering is what lets a config declare a level and scope a grant to it in the same run (the ref
  // resolves to a PendingRef, carried as a pending scope).
  "security-level": "security-level",
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
  // Security levels — the `cc_securitylevel` scope dimension (#110). `GET /securitylevels` returns a
  // flat `[{id, name, sortKey}]` array ("Stufe 1 (Niedrig)" … "Stufe 4 (Sehr hoch)"), live-verified on
  // eqrm prod (CT 3.135.2, 2026-08-13) and eqrm-dev (2026-08-14). Unlike `department` this kind ALSO
  // has a REF_KIND_TYPE entry: levels are a managed resource, so this catalog is the fallback for a
  // level the config does not own, not the only source. Reading it by name matters because the ids
  // are not a protocol constant — an editable table with an auto-increment id and a supported
  // reorder, so a hard-coded `scope: [1, 2, 3]` is portable only by convention.
  "security-level": "/securitylevels",
  // Comment viewers — the `cdb_comment_viewer` scope dimension (#102). `[{id, name, sortKey}]`,
  // live-verified on eqrm-dev CT 3.135.2, 2026-08-14. NB `id: 0` is a real row here ("Alle"), which
  // is why nothing in the resolve path may treat a falsy id as "missing".
  "comment-viewer": "/person/commentviewers",
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
  /**
   * `getAll` is what the catalogs below are actually read with (#99 review): CT's list endpoints
   * return only their default first page (10 rows) for a plain `get`, which would make a campus,
   * group type or department past that page unresolvable by name on any real instance — exactly the
   * portability #98 exists to give. It is optional so the many `{ get }` test doubles keep working;
   * the real {@link CtClient} always provides it.
   */
  client: Pick<CtClient, "get"> & Partial<Pick<CtClient, "getAll">>;
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

/** Options for one {@link Resolver.resolve} call — what the CALLING POSITION can cope with. */
export interface ResolveOptions {
  /**
   * Allow a `group-role` ref whose group is declared-but-not-yet-created to resolve to a
   * {@link PendingRef} instead of hard-erroring (#106).
   *
   * Off by default, and deliberately opt-in per call site rather than global: a pending group-role
   * cannot be finished by {@link reresolvePendingValue} the way every other pending ref can — the
   * pairing id lives on `GET /groups/{id}/roles`, so completing it needs a LIVE FETCH after the group
   * exists. Only the permission-domain position can do that (`applyPermissionPlan` runs after
   * `executePlan` and holds a client), so only `resolveDomainIds` passes this. Every other position
   * (resource id fields, query `var` values) keeps the old fail-fast error, which is still the right
   * answer there.
   */
  pendingGroupRole?: boolean;
}

export class Resolver {
  private readonly client: Pick<CtClient, "get"> & Partial<Pick<CtClient, "getAll">>;
  private readonly state: State;
  private readonly host: string;
  private readonly catalogs = new Map<RefKind, Promise<CatalogRecord[]>>();
  /** Per-group role list cache (group_role domain resolution), keyed by group id, fetched at most once. */
  private readonly groupRoleLists = new Map<number, Promise<CatalogRecord[]>>();
  /** Declared logical keys indexed by resource type — a same-run target that resolves to pending. */
  private readonly declaredByType = new Map<string, Set<string>>();
  /**
   * Slugged NAMES of the `roleDefinition`s this config declares (#120). A `ct.groupRole` names its
   * role by name, not by logical key, so the pending check has to match on the name — which is why
   * this is a separate index from {@link declaredByType}.
   */
  private readonly declaredRoleDefNames = new Set<string>();
  /**
   * Slugged roleDefinition name → the group-type id(s) this config declares it on (#120, review).
   * A role NAME is not unique across group types — see {@link resolveGroupTypeRole}'s note (3 "Leiter",
   * 6 "Organisator", 6 "Mitglied" on live prod) — so the name alone cannot answer "will this role
   * appear on THIS group?". The value is whatever the declaration carries: a raw id, or a `group-type`
   * Ref resolved lazily at check time.
   */
  private readonly declaredRoleDefTypes = new Map<string, (number | Ref)[]>();
  /**
   * Group key → the slugged LOCAL member-field keys that group declares (#135). A member field is
   * group-scoped, so "does this config declare it?" can only be answered per group — the same local
   * key on two groups is two independent fields. Drives the pending decision below.
   */
  private readonly declaredMemberFields = new Map<string, Set<string>>();
  /** Per-group member-field list cache, keyed by group id, fetched at most once per run. */
  private readonly memberFieldLists = new Map<number, Promise<Record<string, unknown>[]>>();

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
      if (d.type === "group-role" && typeof d.fields.name === "string") {
        const name = slug(d.fields.name);
        this.declaredRoleDefNames.add(name);
        const gt = d.fields.groupTypeId;
        if (typeof gt === "number" || isRef(gt)) {
          const list = this.declaredRoleDefTypes.get(name);
          if (list) list.push(gt);
          else this.declaredRoleDefTypes.set(name, [gt]);
        }
      }
      if (d.type === "group" && d.memberFields !== undefined) {
        this.declaredMemberFields.set(d.key, new Set(d.memberFields.map((f) => slug(f.key))));
      }
    }
  }

  /** Resolve one Ref to a numeric id, or a {@link PendingRef} for a same-run-created managed target. */
  async resolve(r: Ref, site: string, opts: ResolveOptions = {}): Promise<number | PendingRef> {
    if (r.kind === "group-role") return this.resolveGroupRole(r, site, opts);
    if (r.kind === "group-type-role") return this.resolveGroupTypeRole(r, site);
    if (r.kind === "group-member-field") return this.resolveGroupMemberField(r, site);
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

  /**
   * Fetch one master-data catalog, ONCE per run, paginated.
   *
   * Paginated deliberately (#99 review): a plain `GET /campuses` returns CT's default first page —
   * 10 rows — so on an instance with more campuses/group types/departments than that, every ref
   * naming a row on page 2+ would hard-error with "no live … matches key", and a `ct get campuses`
   * (which pages) would list the very row this resolver claims does not exist. `getAll` is optional
   * on the deps only so `{ get }` test doubles stay usable; the real client always has it.
   */
  private catalog(kind: RefKind): Promise<CatalogRecord[]> {
    let p = this.catalogs.get(kind);
    if (!p) {
      const path = CATALOG_PATH[kind]!;
      const rows = this.client.getAll
        ? this.client.getAll<CatalogRecord>(path).then((page) => page.data)
        : this.client.get<CatalogRecord[]>(path);
      p = rows.then((r) => (Array.isArray(r) ? r : []));
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
   * implements and the evidence for it.
   *
   * Returns a number, EXCEPT when the group is declared in this config but not yet created AND the
   * call site opted into {@link ResolveOptions.pendingGroupRole} (#106): then it returns a
   * {@link PendingRef}, because the pairing id only exists once the group does. The permission-domain
   * position takes that path — `applyPermissionPlan` finishes it with a live fetch after `executePlan`
   * (see {@link resolvePendingGroupRoleDomain}). Everywhere else a same-run group stays a hard error,
   * telling the author to apply the group first or pass a numeric id.
   */
  private async resolveGroupRole(
    r: GroupRoleRef,
    site: string,
    opts: ResolveOptions = {},
  ): Promise<number | PendingRef> {
    const groupId = this.groupIdForRole(r, site, opts);
    if (typeof groupId !== "number") return groupId;
    const rows = await this.groupRoleList(groupId);
    // #106 made a same-run GROUP resolve as pending. #120: the ROLE half needs the same treatment.
    // Role definitions are per group type and drift easily between two hosts of one instance, so a
    // `groupRole` naming a custom role hard-errored on the host that lacks it — with a message
    // ("Fix the role name, or pass a numeric id") whose two remedies are both wrong when the role is
    // declared three lines up. Roles created this run land on the group's role list once the
    // role-def create (tier 3) has run, which is before permissions — so the same post-apply
    // completion that finishes a pending group finishes this too.
    if ((await this.declaresRoleForGroup(r, site)) && !hasRoleNamed(rows, r.role)) {
      if (opts.pendingGroupRole) return pendingRef(r);
      throw new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: "${r.role}" is declared ` +
          `as a roleDefinition in this config but does not exist on this host yet. Apply the master ` +
          `data first, then declare the grants — or pass a numeric id.`,
      );
    }
    return pickGroupRolePairingId(rows, r, groupId, site, this.host);
  }

  /** Does this config declare a `roleDefinition` whose name matches `role` (slug-insensitive)? */
  private declaresRoleNamed(role: string): boolean {
    return this.declaredRoleDefNames.has(slug(role));
  }

  /**
   * Will a `roleDefinition` this config declares actually land on THIS group — i.e. is the missing
   * role plausibly a same-run creation rather than a config error?
   *
   * The name alone must not decide it. Role names repeat across group types, so a config declaring
   * `roleDefinition({ name: "Mitglied", groupType: "kleingruppe" })` next to a `ct.groupRole` on a
   * group of a DIFFERENT type — one that genuinely has no such role — would otherwise be read as
   * "pending", deferring a plain config error past `executePlan` to the post-apply live fetch. It
   * fails there with the same message, but only after the resource tier has already written. Matching
   * the group's own type restores the plan-time failure.
   *
   * Lenient wherever the answer is not knowable offline — an unqualified declaration, or a group whose
   * state entry predates `groupTypeId` being recorded. Those keep #120's behaviour exactly; the check
   * only ever turns a would-be pending back into the hard error it used to be, and only on evidence.
   */
  private async declaresRoleForGroup(r: GroupRoleRef, site: string): Promise<boolean> {
    if (!this.declaresRoleNamed(r.role)) return false;
    const declaredTypes = this.declaredRoleDefTypes.get(slug(r.role));
    if (declaredTypes === undefined) return true; // declared, but on no stated group type
    const groupTypeId = this.state.resources[r.group]?.fields.groupTypeId;
    if (typeof groupTypeId !== "number") return true; // this host's state cannot say — stay lenient
    for (const t of declaredTypes) {
      // A group-type Ref that is itself pending cannot be this existing group's type, so a non-number
      // simply does not match — no need to distinguish it from a mismatch.
      const id = typeof t === "number" ? t : await this.resolve(t, site);
      if (id === groupTypeId) return true;
    }
    return false;
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
      // #125: the old message offered "rename to disambiguate, or pass a numeric id", and BOTH are
      // dead ends for a config shared across hosts — a rename edits ChurchTools master data (often
      // CT's own stock role) to work around a config limitation, and the roles have different ids per
      // host with no env to branch on. Adopting the role is the remedy that actually works, and it is
      // the same "adopt the target to portablize it" move groups and campuses already use.
      const adopts = matches.map((c) => `\`ct adopt group-role ${c.id} -k <shared-key>\``).join(" / ");
      throw new Error(
        `Ambiguous ${refLabel(r)} referenced at ${site} on ${this.host}: ${matches.length} roles on group ` +
          `type #${groupTypeId} match — ${list}. Adopt the one you mean under a logical key, on EVERY ` +
          `host, and reference it as { kind: "role-def", key: "<shared-key>" } — ${adopts}. ` +
          `(Renaming in ChurchTools and passing a numeric id both work on one host only.)`,
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

  /**
   * Resolve the group half of a group_role ref to a managed group id (state ∪ declared). A group
   * declared in this run resolves to a {@link PendingRef} when the call site can finish it later
   * (#106) and stays a hard error otherwise.
   */
  private groupIdForRole(r: GroupRoleRef, site: string, opts: ResolveOptions): number | PendingRef {
    const managed = this.state.resources[r.group];
    if (managed && managed.type === "group") return managed.id;
    if (this.declaredByType.get("group")?.has(r.group)) {
      if (opts.pendingGroupRole) return pendingRef(r);
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

  /**
   * Resolve a group-scoped member field (#135) by its portable `(group, field)` pair to this host's
   * numeric field id — the reference a dynamic-group ruleset uses so it never freezes one host's
   * field id into a file that is applied elsewhere.
   *
   * Three outcomes, in order:
   *  1. The owning group is managed AND the live `GET /groups/{id}/memberfields` carries the field →
   *     its numeric id. (>1 match is a hard error: the local key would be ambiguous on this host.)
   *  2. The field is DECLARED by this config for that group but does not exist on this host yet →
   *     a {@link PendingRef}. Fields are created by the owning group's own apply item, before that
   *     group's dynamic ruleset is installed, so the pending marker is completed from state during
   *     apply (see `pendingIdFromState` and engine/synthetic.ts).
   *  3. Neither → a hard error naming the portable identity. This is the check #135 asks for: a
   *     ruleset naming a field that does not exist and is not declared FAILS AT PLAN TIME, before
   *     anything is written.
   */
  private async resolveGroupMemberField(r: GroupMemberFieldRef, site: string): Promise<number | PendingRef> {
    const declaresField = this.declaredMemberFields.get(r.group)?.has(slug(r.field)) === true;
    const managed = this.state.resources[r.group];
    if (!managed || managed.type !== "group") {
      if (declaresField) return pendingRef(r);
      const declaresGroup = this.declaredByType.get("group")?.has(r.group) === true;
      throw new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: ` +
          (declaresGroup
            ? `group "${r.group}" is declared but does not declare a member field "${r.field}". ` +
              `Add it to that group's "memberFields" — a member field belongs to exactly one group, ` +
              `so it can only be named through the group that owns it.`
            : `no managed group named "${r.group}" is declared or adopted. Declare/adopt it, or fix the key.`),
      );
    }
    const rows = await this.memberFieldList(managed.id);
    const matches = rows.filter((row) => matchesLocalKey(row, r.field));
    if (matches.length > 1) {
      const list = matches
        .map((row) => `${JSON.stringify(row.name ?? row.referenceName)} (#${String(memberFieldRowId(row))})`)
        .join(", ");
      throw new Error(
        `Ambiguous ${refLabel(r)} referenced at ${site} on ${this.host}: ${matches.length} member ` +
          `fields on group #${managed.id} match — ${list}. Rename one in ChurchTools so the local key ` +
          `is unique within the group.`,
      );
    }
    if (matches.length === 1) {
      const id = memberFieldRowId(matches[0]!);
      if (id === undefined) {
        throw new Error(
          `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: the matched member ` +
            `field row carries no numeric id.`,
        );
      }
      return id;
    }
    if (declaresField) return pendingRef(r);
    const available = rows
      .map((row) => (typeof row.name === "string" ? JSON.stringify(row.name) : "?"))
      .join(", ");
    throw new Error(
      `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: group #${managed.id} has ` +
        `no member field "${r.field}"${available ? ` (available: ${available})` : ""}, and this config ` +
        `does not declare one. Declare it in that group's "memberFields", or fix the key.`,
    );
  }

  /** One group's member-field list, fetched at most once per run (several refs may name one group). */
  private memberFieldList(groupId: number): Promise<Record<string, unknown>[]> {
    let p = this.memberFieldLists.get(groupId);
    if (!p) {
      p = this.client
        .get<unknown>(memberFieldsReadPath(groupId))
        .then((raw) => groupScopedRows(raw)) as Promise<Record<string, unknown>[]>;
      this.memberFieldLists.set(groupId, p);
    }
    return p;
  }

  private groupRoleList(groupId: number): Promise<CatalogRecord[]> {
    let p = this.groupRoleLists.get(groupId);
    if (!p) {
      p = fetchGroupRoleRows(this.client, groupId);
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
    // cannot honour (#96's exact complaint about the old person-status message). The message says
    // what `ct` does — reads this catalog, never writes it — rather than claiming ChurchTools makes
    // it impossible: departments and security levels ARE writable through the legacy master-data
    // endpoint the admin UI uses, just not through anything `ct` drives today (#108/#109/#111).
    if (catalog && REF_KIND_TYPE[r.kind] === undefined) {
      return new Error(
        `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: no live ${r.kind} at ` +
          `${catalog} matches key "${r.key}". ct reads ${r.kind}s but does not manage them, so it cannot ` +
          `create this one — fix the key/name (list them with \`ct get ${r.kind}s\`), create it in the ` +
          `ChurchTools admin UI, or use a numeric id.`,
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

/** The client shape both the plan-time resolver and the apply-time group-role completion need. */
type RoleListReader = Pick<CtClient, "get"> & Partial<Pick<CtClient, "getAll">>;

/** Per-group role-list cache, so several pending group_role domains on one group share one fetch. */
export type GroupRoleRowCache = Map<number, Promise<CatalogRecord[]>>;

/**
 * Read one group's role list. Paginated for the same reason as `Resolver.catalog()`: a group with
 * more than CT's default page of roles would otherwise hide its later ones behind "group #N has no
 * role named …". `getAll` is optional only so `{ get }` test doubles stay usable.
 */
function fetchGroupRoleRows(client: RoleListReader, groupId: number): Promise<CatalogRecord[]> {
  const path = GROUP_ROLE_ENDPOINT(groupId);
  const rows = client.getAll
    ? client.getAll<CatalogRecord>(path).then((page) => page.data)
    : client.get<CatalogRecord[]>(path);
  return rows.then((r) => (Array.isArray(r) ? r : []));
}

/**
 * Pick the (group, role) pairing domainId out of a group's role list. Shared by the plan-time path
 * (group already exists) and the apply-time path (#106: group created in this run), so the matching
 * rules and — importantly — the error messages are identical whichever side a config lands on.
 * slug-primary, exact-name secondary, matching every other catalog lookup in this file.
 */
/**
 * The role rows on a group matching a ref's role name — slug-primary, exact-name secondary, the same
 * two-step every other catalog lookup uses. Shared with the pending check (#120) so "is this role
 * missing?" and "which row is it?" can never answer differently.
 */
function matchRoleRows(rows: CatalogRecord[], role: string): CatalogRecord[] {
  const bySlug = rows.filter((row) => typeof row.name === "string" && slug(row.name) === slug(role));
  return bySlug.length >= 1 ? bySlug : rows.filter((row) => row.name === role);
}

/** Whether the group's live role list already holds a role by this name. */
function hasRoleNamed(rows: CatalogRecord[], role: string): boolean {
  return matchRoleRows(rows, role).length > 0;
}

function pickGroupRolePairingId(
  rows: CatalogRecord[],
  r: GroupRoleRef,
  groupId: number,
  site: string,
  host: string,
): number {
  const matches = matchRoleRows(rows, r.role);
  if (matches.length === 0) {
    const available = rows
      .map((row) => (typeof row.name === "string" ? JSON.stringify(row.name) : `#${row.id}`))
      .join(", ");
    throw new Error(
      `Cannot resolve ${refLabel(r)} referenced at ${site} on ${host}: group #${groupId} has ` +
        `no role named "${r.role}"${available ? ` (available: ${available})` : ""}. Fix the role name, ` +
        `or pass a numeric id.`,
    );
  }
  if (matches.length > 1) {
    const list = matches.map((c) => `${JSON.stringify(c.name)} (#${c.id})`).join(", ");
    throw new Error(
      `Ambiguous ${refLabel(r)} referenced at ${site} on ${host}: ${matches.length} roles on ` +
        `group #${groupId} match — ${list}. Rename to disambiguate, or pass a numeric id.`,
    );
  }
  const domainId = matches[0]![GROUP_ROLE_PAIRING_FIELD];
  if (typeof domainId !== "number") {
    throw new Error(
      `Cannot resolve ${refLabel(r)} referenced at ${site} on ${host}: the matched role row ` +
        `carries no numeric "${GROUP_ROLE_PAIRING_FIELD}" (the assumed pairing domainId — see #25). ` +
        `Pass a numeric id.`,
    );
  }
  return domainId;
}

/**
 * Finish a PENDING `group_role` domain at apply time (#106).
 *
 * This is the one pending ref {@link reresolvePendingValue} cannot complete from state alone: the
 * (group, role) pairing id is not the group's id, it lives on `GET /groups/{id}/roles` and only
 * exists once ChurchTools has created the group. So completion is a two-step — look the freshly
 * created group up in POST-execute state, then fetch ITS role list and match the declared role name —
 * and it is necessarily async, which is why it sits here rather than in `reresolvePendingValue`.
 *
 * A role name the created group does not have is a hard error listing the available roles, exactly as
 * at plan time (shared {@link pickGroupRolePairingId}). `cache` dedupes the fetch when several pending
 * domains name the same group.
 */
export async function resolvePendingGroupRoleDomain(
  r: GroupRoleRef,
  state: State,
  client: RoleListReader,
  site: string,
  cache?: GroupRoleRowCache,
): Promise<number> {
  const managed = state.resources[r.group];
  if (!managed || managed.type !== "group") {
    throw new Error(
      `Pending ${refLabel(r)} did not resolve after apply — "${r.group}" is not a managed group in ` +
        `state. The resource tier creates groups before permissions are applied, so this usually means ` +
        `the group's create failed earlier in this run.`,
    );
  }
  let rows = cache?.get(managed.id);
  if (!rows) {
    rows = fetchGroupRoleRows(client, managed.id);
    cache?.set(managed.id, rows);
  }
  return pickGroupRolePairingId(await rows, r, managed.id, site, state.host);
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = reresolvePendingValue(v, state);
    return out;
  }
  return value;
}

function pendingIdFromState(r: Ref, state: State): number {
  if (r.kind === "group-role") {
    // A pending group_role IS legal now (#106), but it cannot be completed from state alone: the
    // pairing id lives on GET /groups/{id}/roles, so it needs a live fetch. `applyPermissionPlan`
    // routes it through `resolvePendingGroupRoleDomain` instead. Reaching HERE means a pending
    // group-role turned up in a value-shaped position (a resource id field, a query var), which the
    // resolver only ever produces for the permission-domain call site — so it is a wiring bug.
    throw new Error(
      `Pending ${refLabel(r)} reached the state-only re-resolver — a group_role pairing id needs a ` +
        `live /groups/{id}/roles fetch, so it can only be completed by applyPermissionPlan (#106).`,
    );
  }
  if (r.kind === "group-member-field") {
    // Completed from the OWNING GROUP's state entry (#135): the member-field apply records each
    // field's freshly minted id under `memberFields` there, and it runs before the same group's
    // dynamic ruleset (engine/synthetic.ts orders the pseudo-fields ahead of `dynamic`, and
    // `applySyntheticFields` re-resolves each change immediately before applying it). So by the time
    // a ruleset carrying this marker is written, the id is already in state.
    const group = state.resources[r.group];
    const id = group?.memberFields?.[r.field];
    if (typeof id !== "number") {
      throw new Error(
        `Pending ${refLabel(r)} did not resolve after its group applied — no member field "${r.field}" ` +
          `was created for group "${r.group}" in this run. This usually means the group's create, or ` +
          `that field's create, failed earlier.`,
      );
    }
    return id;
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
