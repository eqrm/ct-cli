import type { State } from "../state/state.js";
import type { GrantTuple } from "./grants.js";
import type { DesiredPermission, ScopeEntry } from "./types.js";
import type { Resolver } from "../resolve/resolver.js";
import {
  isPendingRef,
  isRef,
  ref,
  refKey,
  refLabel,
  type Ref,
  type RefKind,
  type SimpleRef,
} from "../resolve/refs.js";
import { resolveAuthId } from "./catalog.js";

/**
 * One resolved scope entry: `id` is the concrete ChurchTools dataId, or `null` when it names a
 * resource declared in the config but not yet created (pending). `numeric` marks an entry that has
 * no state-backed identity to re-resolve — either a raw numeric scope literal (the #49 escape hatch)
 * or a logical ref that resolved through a live master-data catalog rather than managed state — so
 * it carries only its already-known id (see {@link reresolveTuple}, which passes a tuple through
 * unchanged when it has no `scopeKey`). `type` is the MANAGED RESOURCE TYPE behind `key` (#98):
 * "group" for the historical group dimension, "campus"/"group-type" for a typed logical scope ref.
 */
export interface ScopeResolution {
  key: string;
  id: number | null;
  numeric?: boolean;
  type?: string;
}

/**
 * ChurchTools' "every value of this dimension" dataId. CT both accepts it on write and reads it back
 * verbatim, expanding it only in the derived `/permissions/global` view — so a declared `-1` diffs
 * against a live `-1` and stays a clean no-op.
 */
export const ALL_SCOPE_SENTINEL = -1;

/**
 * Per-dimension dataIds that are BUILT IN to every ChurchTools instance, and therefore already
 * portable — a config may write the number and mean the same thing on every host.
 *
 * Unlike {@link ALL_SCOPE_SENTINEL} these are REAL rows: `cdb_comment_viewer` `0` is the "Alle"
 * comment viewer, which CT ships on every instance (verified live on two hosts of the same
 * deployment, 2026-08-26). That difference matters — a built-in row can be renamed or deleted by an
 * admin, so it is emitted as its NUMBER (exact, and immune to a rename) rather than resolved to a
 * name, and it is never counted as an unmanaged host-specific id.
 *
 * Adopting one would be actively harmful, which is why this table exists: `ct adopt comment-viewer 0`
 * yields `ct.commentViewer({ key: "alle", name: "Alle" })`, and replaying THAT config on a second
 * host with a fresh state file finds no state entry, POSTs a SECOND "Alle" (CT mints a fresh id),
 * scopes the grant to the duplicate instead of the built-in — the exact host-specific misgrant #151
 * exists to prevent — and leaves a catalog with two "Alle" rows, which makes `{ commentViewer: "alle" }`
 * fail `resolveFromCatalog`'s ambiguity check from then on.
 *
 * Deliberately keyed BY DIMENSION, not a blanket "`0` is portable" rule: on any other scope field `0`
 * is an ordinary host-specific id, and a global rule would silently stop flagging it.
 */
const BUILTIN_SCOPE_IDS: Readonly<Record<string, readonly number[]>> = {
  cdb_comment_viewer: [0], // "Alle"
};

/** Whether `id` on `scopeField` is a built-in row present on every host — see {@link BUILTIN_SCOPE_IDS}. */
export function isBuiltinScopeId(scopeField: string, id: number): boolean {
  return BUILTIN_SCOPE_IDS[scopeField]?.includes(id) ?? false;
}

/** The human name of a built-in scope id, for the note the adopter emits next to the number. */
export function builtinScopeIdName(scopeField: string, id: number): string | null {
  return scopeField === "cdb_comment_viewer" && id === 0 ? "Alle" : null;
}

/**
 * The catalog `scopeField` naming the GROUP dimension. The only dimension a bare string scope entry
 * may address — every other one needs a typed ref (see {@link SCOPE_REF_KIND}) or a numeric dataId.
 */
export const GROUP_SCOPE_FIELD = "cdb_gruppe";

/**
 * Catalog `scopeField` → the {@link RefKind} a typed logical scope ref must carry for that dimension,
 * and the managed resource type it resolves against (#98).
 *
 * Only dimensions whose values this tool can address by a HOST-INDEPENDENT name are listed:
 *
 *  - `cdb_gruppe`      → groups      (managed-only; the historical string-key form is the same dimension)
 *  - `cdb_station`     → campuses    (`/campuses`) — the motivating case: campus ids are host-specific
 *                        (dev Mainz = 6, prod Mainz = 0), so a numeric literal is a cross-environment
 *                        misgrant waiting to happen
 *  - `cdb_gruppentyp`  → group types (`/group/grouptypes`)
 *  - `cdb_bereich`     → departments (`/departments`) — Bereiche, e.g. `churchdb:view alldata`
 *                        ("Personen eines Bereiches sehen")
 *  - `cc_securitylevel` → security levels (`/securitylevels`, #110) — e.g. `churchdb:+see persons`
 *  - `cdb_comment_viewer` → comment viewers (`/person/commentviewers`, #102) — `churchdb:view comments`
 *
 * `managed` separates the MANAGED resource kinds from the read-only catalogs. For a managed kind a
 * scope target can be declared in the same config (resolving pending, then re-resolved at apply time)
 * and a state-backed id is worth re-resolving. For a catalog kind the reference always resolves by
 * NAME against the live catalog and hard-errors when the name is absent — strictly better than a
 * silent numeric misgrant, but never a create.
 *
 * Every dimension listed here is managed today: departments joined in #108 (writes go through the
 * legacy master-data endpoint), security levels in #110, and comment viewers in #151 — the last one
 * a config could not express portably at all, because a `churchdb:view comments` grant had no choice
 * but a raw host-specific `dataId`.
 *
 * The remaining scoped dimensions (`ccm_data_category`, `oauth_client`, `cc_calcategory`, …) stay
 * numeric-only because this tool has no way to address their values by a host-independent name today —
 * an omission to revisit, not a proof that they are "not resources". Most of them belong to modules
 * outside this tool's mandate (calendars, resources, services, wiki, finance), which is the real
 * reason none has a ref kind, and a better thing to say than that they are "not resources at all".
 */
export const SCOPE_REF_KIND: Readonly<Record<string, { kind: RefKind; type: string; managed: boolean }>> = {
  [GROUP_SCOPE_FIELD]: { kind: "group", type: "group", managed: true },
  cdb_station: { kind: "campus", type: "campus", managed: true },
  cdb_gruppentyp: { kind: "group-type", type: "group-type", managed: true },
  cdb_bereich: { kind: "department", type: "department", managed: true },
  cc_securitylevel: { kind: "security-level", type: "security-level", managed: true },
  cdb_comment_viewer: { kind: "comment-viewer", type: "comment-viewer", managed: true },
};

/** The DSL's object sugar for a typed scope ref: exactly one dimension field, e.g. `{ campus: "koblenz" }`. */
const SCOPE_SUGAR: Readonly<Record<string, (key: string) => Ref>> = {
  group: ref.group,
  campus: ref.campus,
  groupType: ref.groupType,
  department: ref.department,
  securityLevel: ref.securityLevel,
  commentViewer: ref.commentViewer,
};

/**
 * Normalise one authored scope entry into the three forms the resolver/planner speak: a bare string
 * (logical group key), a number (raw dataId), or a {@link Ref}. The object sugar `{ campus: "koblenz" }`
 * compiles to `ref.campus("koblenz")` here — the same eval-time sugar→Ref move `ID_SUGAR` makes for
 * declaration id fields (src/config/context.ts), so both authoring forms converge before any host is
 * involved. Shared by the config DSL and the planner so a programmatically built `DesiredPermission`
 * behaves identically to an authored one.
 */
export function normalizeScopeEntry(entry: unknown, where: string): string | number | Ref {
  if (typeof entry === "number") return entry;
  if (typeof entry === "string") {
    if (entry.length === 0) {
      throw new Error(`${where}: a string scope entry must be a non-empty logical group key.`);
    }
    return entry;
  }
  if (isRef(entry)) return entry;
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const fields = Object.entries(entry as Record<string, unknown>);
    const dims = Object.keys(SCOPE_SUGAR).join(", ");
    if (fields.length !== 1) {
      throw new Error(
        `${where}: a scope reference must name exactly one dimension (${dims}), got ${JSON.stringify(entry)}.`,
      );
    }
    const [dim, value] = fields[0]!;
    const make = SCOPE_SUGAR[dim];
    if (!make) {
      throw new Error(`${where}: unknown scope dimension "${dim}" — expected one of: ${dims}.`);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${where}: "${dim}" must be a non-empty logical key, got ${JSON.stringify(value)}.`);
    }
    return make(value);
  }
  throw new Error(
    `${where}: scope entries must be a non-empty string (logical group key), a number (raw dataId), ` +
      `or a logical reference such as { campus: "koblenz" }, got ${JSON.stringify(entry)}.`,
  );
}

/**
 * A typed scope ref resolved for THIS host. `id` is the concrete dataId, or `null` when the ref names
 * a resource declared in this config but not yet created. `managedKey`/`managedType` are set only when
 * the ref resolved against MANAGED state (or a same-run declaration) — i.e. when there is a
 * state-backed identity to re-resolve at apply time. A ref that resolved through a live master-data
 * catalog carries neither: its id is already final and host-correct.
 */
export interface ScopeRefResolution {
  id: number | null;
  managedKey?: string;
  managedType?: string;
}

/** Typed scope refs resolved for this host, keyed by {@link refKey}. */
export type ScopeRefMap = ReadonlyMap<string, ScopeRefResolution>;

/**
 * Pre-resolve every typed logical scope ref in `permissions` against this host (#98), and validate
 * each one's DIMENSION against the right it scopes.
 *
 * Scope resolution itself ({@link resolveScope}) is synchronous — it is a pure state lookup, called
 * per grant deep inside `desiredTuples`. Typed refs may need a live catalog fetch, so their
 * resolution is hoisted here into one async pass over the whole permission set, and the sync path
 * consumes the resulting map. Same shape as `resolveDomainIds` (src/permissions/plan.ts).
 *
 * Validation (all HARD errors at plan time, never a silently-guessed dataId):
 *  - a ref on a right that takes no scope, or on a dimension with no logical form → rejected with
 *    the dimension named, so the author reaches for the numeric escape hatch deliberately;
 *  - a ref whose kind does not match the right's `scopeField` dimension → rejected naming BOTH
 *    (a `{campus:…}` ref on a `cc_securitylevel` right is a config bug, not a runtime surprise);
 *  - a ref that cannot resolve at all → the resolver's own hard error propagates.
 *
 * A right the catalog does not know is skipped here so `desiredTuples` raises its own (better)
 * unknown-right error rather than being pre-empted by a less specific one.
 */
export async function resolveScopeRefs(
  permissions: readonly DesiredPermission[],
  resolver: Resolver,
  state: State,
): Promise<ScopeRefMap> {
  const out = new Map<string, ScopeRefResolution>();
  for (const p of permissions) {
    for (const g of p.grants) {
      if (typeof g === "string") continue;
      const where = `${p.domainType} "${p.key}" grant "${g.right}"`;
      let scopeField: string | null;
      try {
        scopeField = resolveAuthId(g.right).scopeField;
      } catch {
        continue; // unknown right — desiredTuples reports it with the catalog's own hint
      }
      for (const raw of g.scope) {
        const entry = normalizeScopeEntry(raw, where);
        if (!isRef(entry)) continue;
        const dimension = expectedDimension(entry, scopeField, where);
        const k = refKey(entry);
        if (out.has(k)) continue;
        const resolved = await resolver.resolve(entry, `${where} scope`);
        if (isPendingRef(resolved)) {
          out.set(k, { id: null, managedKey: dimension.ref.key, managedType: dimension.type });
          continue;
        }
        // Mirror the resolver's own precedence: it consults managed state BEFORE the live catalog, so
        // a key that names a managed resource of this type is exactly the case where the id came from
        // state — and only then is there a state-backed identity worth re-resolving at apply time.
        // A dimension whose `managed` flag is false would never take this path at all; none is left
        // today (#151 was the last), but the flag stays so a future read-only dimension is one entry.
        const managed = dimension.managed ? state.resources[dimension.ref.key] : undefined;
        out.set(
          k,
          managed && managed.type === dimension.type
            ? { id: resolved, managedKey: dimension.ref.key, managedType: dimension.type }
            : { id: resolved },
        );
      }
    }
  }
  return out;
}

/**
 * The dimension a typed scope ref must match, or a hard error naming both sides. Also narrows the ref
 * to the simple (single-`key`) kinds — the compound `group-role` / `group-type-role` refs address
 * permission DOMAINS, never scope values, so they can only ever be a dimension mismatch here — and
 * hands the narrowed ref back so callers can read its `key` without a cast.
 */
function expectedDimension(
  entry: Ref,
  scopeField: string | null,
  where: string,
): { kind: RefKind; type: string; managed: boolean; ref: SimpleRef } {
  if (scopeField == null) {
    throw new Error(
      `${where}: "${refLabel(entry)}" is a logical scope reference, but this right takes no scope ` +
        `(no scopeField in the permission catalog) — remove the scope, or use a scoped right.`,
    );
  }
  const dimension = SCOPE_REF_KIND[scopeField];
  if (!dimension) {
    const supported = Object.entries(SCOPE_REF_KIND)
      .map(([field, d]) => `${field} (${d.kind})`)
      .join(", ");
    throw new Error(
      `${where}: scope reference ${refLabel(entry)} cannot be used here — this right scopes by ` +
        `"${scopeField}", which has no logical reference form. Declare its scope as a numeric dataId. ` +
        `Dimensions with a logical form: ${supported}.`,
    );
  }
  if (entry.kind !== dimension.kind) {
    throw new Error(
      `${where}: scope reference ${refLabel(entry)} does not match this right's scope dimension ` +
        `"${scopeField}", which takes a ${dimension.kind} reference. Use a ${dimension.kind} reference, ` +
        `or a numeric dataId.`,
    );
  }
  // Every kind in SCOPE_REF_KIND is a simple, key-addressed one, so matching `dimension.kind` above
  // has already excluded the compound refs (which carry no `key`).
  return { ...dimension, ref: entry as SimpleRef };
}

/**
 * Resolve a scope array against DESIRED ∪ STATE. Each entry is one of:
 *
 * - a **logical group key** (`string`) — resolved against managed groups. Valid only on the group
 *   dimension (`cdb_gruppe`): a bare string on any other dimension is rejected, because it would
 *   otherwise be looked up among GROUPS and either hard-error confusingly or — worse — match an
 *   unrelated group that happens to carry that key and write a silent misgrant (#98).
 * - a **typed logical ref** ({@link Ref}, #98) — `{ campus: "koblenz" }` / `ref.campus("koblenz")`,
 *   pre-resolved for this host by {@link resolveScopeRefs} and read out of `refs` here. This is what
 *   makes a campus-scoped grant portable: campus ids differ per host (dev Mainz = 6, prod Mainz = 0).
 * - a **raw numeric dataId** (`number`, #49) — an escape hatch that passes straight through with no
 *   lookup at all. Still the only form for dimensions whose values this tool cannot yet address by a
 *   host-independent name (`ccm_data_category`, `oauth_client`, `cc_calcategory`, …).
 *
 * A logical key that names a managed resource in state resolves to its id. A logical key that names a
 * resource DECLARED in this config but not yet in state (`declaredGroupKeys` for the string form; the
 * resolver's pending marker for a typed ref) resolves to `null` (pending) — its id is only known after
 * the resource tier applies, so it is re-resolved at apply time (see {@link reresolveTuple}). This is
 * what lets a config declare a group AND a grant scoped to it and still plan/apply in one run (#29). A
 * logical key that is neither in state nor declared stays a hard error.
 *
 * Resolved (in-state, catalog or numeric) entries sort ascending by id — ChurchTools reads scoped
 * grants back one row per dataId, so a stable order keeps multi-scope grants idempotent. Pending keys
 * follow, sorted by key.
 */
export function resolveScope(
  scopeKeys: readonly ScopeEntry[],
  state: State,
  declaredGroupKeys: ReadonlySet<string> = new Set(),
  opts: { refs?: ScopeRefMap; scopeField?: string | null; where?: string } = {},
): ScopeResolution[] {
  const { refs, scopeField, where = "scope" } = opts;
  const resolved: ScopeResolution[] = [];
  const pending: ScopeResolution[] = [];
  for (const raw of scopeKeys) {
    const key = normalizeScopeEntry(raw, where);
    if (typeof key === "number") {
      // `-1` is ChurchTools' ALL sentinel (verified live 2026-08-10: `churchcore:login to external
      // system` with `dataId: -1` reads back through `/permissions/global` expanded to every external
      // system id). `0` is a real dataId on more than one dimension (campus "Mainz" is id 0 on eqrm
      // prod). So the floor is -1, not 1 — anything below that is a typo, not a sentinel.
      if (!Number.isInteger(key) || key < ALL_SCOPE_SENTINEL) {
        throw new Error(
          `Invalid numeric scope entry ${JSON.stringify(key)} — a numeric scope must be an integer dataId (>= 0), or ${ALL_SCOPE_SENTINEL} for ChurchTools' "all" sentinel.`,
        );
      }
      resolved.push({ key: String(key), id: key, numeric: true });
      continue;
    }
    if (isRef(key)) {
      const hit = refs?.get(refKey(key));
      if (!hit) {
        // resolveScopeRefs pre-resolves every ref in the permission set before any diffing, so a miss
        // here means a caller built tuples without that pass — an internal wiring bug, not a config error.
        throw new Error(
          `Scope reference ${refLabel(key)} was not pre-resolved for this host — build the plan through ` +
            `buildPermissionPlan (or pass the map from resolveScopeRefs) so logical scopes can resolve.`,
        );
      }
      if (hit.id === null) {
        pending.push({ key: hit.managedKey ?? refKey(key), id: null, type: hit.managedType });
      } else if (hit.managedKey !== undefined) {
        resolved.push({ key: hit.managedKey, id: hit.id, type: hit.managedType });
      } else {
        // Catalog-resolved: host-correct already and with no managed identity to re-resolve against,
        // so it behaves exactly like the numeric escape hatch from here on.
        resolved.push({ key: String(hit.id), id: hit.id, numeric: true });
      }
      continue;
    }
    if (scopeField != null && scopeField !== GROUP_SCOPE_FIELD) {
      const dimension = SCOPE_REF_KIND[scopeField];
      const hint = dimension
        ? `use a ${dimension.kind} reference (e.g. { ${sugarFieldFor(dimension.kind)}: "${key}" })`
        : "declare its scope as a numeric dataId";
      throw new Error(
        `${where}: scope entry "${key}" is a bare string, which names a managed GROUP — but this right ` +
          `scopes by "${scopeField}", not by group. A bare string here would silently grant on the wrong ` +
          `dimension, so ${hint}.`,
      );
    }
    const m = state.resources[key];
    if (m && m.type === "group") {
      resolved.push({ key, id: m.id, type: "group" });
    } else if (declaredGroupKeys.has(key)) {
      pending.push({ key, id: null, type: "group" });
    } else {
      throw new Error(
        `Scope key "${key}" does not resolve to a managed group. Declare/adopt it, use a group already under management, or pass a raw numeric dataId if this right's scope is not a group (see the catalog's scopeField).`,
      );
    }
  }
  resolved.sort((a, b) => (a.id as number) - (b.id as number));
  pending.sort((a, b) => a.key.localeCompare(b.key));
  return [...resolved, ...pending];
}

/** The DSL sugar field name for a scope {@link RefKind} — for error hints only. */
function sugarFieldFor(kind: RefKind): string {
  const hit = Object.entries(SCOPE_SUGAR).find(([, make]) => make("x").kind === kind);
  return hit?.[0] ?? kind;
}

/**
 * Re-resolve a scoped grant tuple's dataId against the current (post-execute) state, using the
 * symbolic scopeKey retained on the tuple. Fixes stale ids after a recreate and fills in the id of
 * a resource created in the same apply. Unscoped tuples, numeric scopes and catalog-resolved refs
 * (no `scopeKey`) pass through unchanged. `scopeType` names the managed resource type behind the key
 * — "group" for the historical group dimension, "campus"/"group-type" for a typed scope ref (#98).
 * Throws if the scope key no longer resolves to a managed resource of that type — which should be
 * impossible once the resource tier has applied, so it signals a real inconsistency rather than
 * being silently skipped.
 */
export function reresolveTuple(t: GrantTuple, state: State): GrantTuple {
  if (t.scopeKey == null) return t;
  const type = t.scopeType ?? "group";
  const m = state.resources[t.scopeKey];
  if (!m || m.type !== type) {
    throw new Error(
      `Scope key "${t.scopeKey}" did not resolve to a managed ${type} after apply — cannot write its grant with a valid dataId.`,
    );
  }
  return { ...t, dataId: [m.id], pending: false };
}
