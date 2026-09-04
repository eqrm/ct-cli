/**
 * Reverse reference resolution for `ct adopt` (#52 item A): turn the numeric ChurchTools ids a
 * fetched resource carries (`campusId`, `groupTypeId`) into the logical sugar the DSL already
 * accepts (`campus`/`groupType`), so an adopted snippet is portable and reads like something a
 * human would author — not a wall of instance-specific integers. Group statuses are read from the
 * nested `groupStatuses` catalog returned by `/person/masterdata` (#157).
 *
 * This is the mirror image of the forward {@link Resolver} (src/resolve/resolver.ts): it reads the
 * SAME master-data catalogs, matched here BY ID instead of by name, and emits `slug(name)` — exactly
 * the key the forward resolver's slug-primary match will map back to the same id on any host. Each
 * catalog is fetched at most once and cached; a fetch that fails (endpoint unreachable, non-array
 * body) degrades to "no catalog", so adopt never fails just because a lookup could not be resolved —
 * the caller keeps the numeric id and flags it with a `// TODO: no logical match` comment.
 */
import type { CtClient } from "../api/ctClient.js";
import type { RefKind } from "./refs.js";
import { slug } from "../resources/registry.js";

/**
 * The numeric id fields adopt can reverse-sugar, each mapped to its catalog path and the logical DSL
 * field it sugars into. Mirrors context.ts `ID_SUGAR` (sugar → idField) and resolver.ts `CATALOG_PATH`
 * (kind → path); kept explicit (two entries) rather than derived, with this comment as the sync note.
 * `groupStatusId` is deliberately absent — see the file-level comment above (#67).
 */
const REVERSE_ID_FIELDS: Record<string, { catalog: string; sugar: string }> = {
  campusId: { catalog: "/campuses", sugar: "campus" },
  groupTypeId: { catalog: "/group/grouptypes", sugar: "groupType" },
  groupStatusId: { catalog: "/person/masterdata#groupStatuses", sugar: "status" },
};

/**
 * RefKind → master-data catalog path, for portablizing captured ruleset ids (#76). Mirrors the
 * forward resolver's CATALOG_PATH (src/resolve/resolver.ts) so the id→key map here inverts exactly
 * what the resolver's slug-primary lookup maps back on any host. `group` is deliberately absent — it
 * has no catalog (managed-only); its id→key map comes from managed state, supplied by the caller.
 */
const PORTABLE_CATALOG_PATHS: Partial<Record<RefKind, string>> = {
  campus: "/campuses",
  "group-type": "/group/grouptypes",
  "group-status": "/person/masterdata#groupStatuses",
  "role-def": "/group/roles",
};

interface CatalogRecord {
  id: number;
  name?: string;
  [k: string]: unknown;
}

/** A `/group/roles` entry decoded for portablizing a `role.id` / `groupTypeRoleId` (#76). */
export interface RoleCatalogEntry {
  /** The group TYPE this role is scoped to — the disambiguator that makes (groupTypeId, name) unique. */
  groupTypeId: number;
  /** The role's display name (used to build the portable (group-type, role-name) marker). */
  name: string;
}

export class ReverseResolver {
  private readonly client: Pick<CtClient, "get" | "getAll">;
  /** id → logical key, per catalog path, fetched at most once. A failed fetch caches an empty map. */
  private readonly catalogs = new Map<string, Promise<Map<number, string>>>();
  /** groupTypeRoleId → {groupTypeId, name} from `/group/roles`, fetched at most once (#76). */
  private roleCatalog?: Promise<Map<number, RoleCatalogEntry>>;

  constructor(client: Pick<CtClient, "get" | "getAll">) {
    this.client = client;
  }

  private index(path: string): Promise<Map<number, string>> {
    let p = this.catalogs.get(path);
    if (!p) {
      // `getAll`, never a plain `get` (#101): these catalogs are LIST endpoints, so a plain GET
      // returns only CT's default first page (10 rows). That silently truncated every reverse map —
      // on eqrm prod `/group/roles` has 46 rows, so 36 roles had no id→key entry and every ruleset
      // `role.id` pointing at one was left as a host-specific number with a vague warning. The
      // forward Resolver was fixed for exactly this; the reverse side had the same bug.
      const rows =
        path === "/person/masterdata#groupStatuses"
          ? this.client
              .get<{ groupStatuses?: CatalogRecord[] }>("/person/masterdata")
              .then((masterdata) => masterdata.groupStatuses ?? [])
          : this.client.getAll<CatalogRecord>(path).then(({ data }) => data);
      p = rows
        .then((rows) => {
          const map = new Map<number, string>();
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (typeof row?.id === "number" && typeof row.name === "string" && row.name.length > 0) {
                map.set(row.id, slug(row.name));
              }
            }
          }
          return map;
        })
        // Adopt must not fail because a catalog is unreachable — degrade to "no matches" (→ TODO).
        .catch(() => new Map<number, string>());
      this.catalogs.set(path, p);
    }
    return p;
  }

  /** The logical key for a numeric id in the given catalog, or `undefined` when unmatched. */
  private async keyForId(catalog: string, id: number): Promise<string | undefined> {
    return (await this.index(catalog)).get(id);
  }

  /**
   * id → logical-key map for a catalog-backed {@link RefKind}, for portablizing captured ruleset ids
   * (#76 Stage 3). Reuses the same cached master-data index as {@link sugarFields} (campus/group-type)
   * plus the global role catalog. A kind with no catalog (e.g. `group` — managed-only) yields an empty
   * map; the caller supplies those ids from managed state instead.
   */
  async idToKeyByKind(kind: RefKind): Promise<Map<number, string>> {
    const path = PORTABLE_CATALOG_PATHS[kind];
    return path ? this.index(path) : new Map<number, string>();
  }

  /**
   * groupTypeRoleId → {groupTypeId, name} for every `/group/roles` row (#76). Unlike
   * {@link idToKeyByKind}('role-def') — which keys by `slug(name)` alone and is WRONG for these ids
   * (role names are not globally unique across group types) — this preserves each role's `groupTypeId`,
   * so `portablizeRuleset` can reverse-map it to a managed group-type key and emit a (group-type,
   * role-name) marker. Fetched at most once; a failed/malformed fetch degrades to an empty map (adopt
   * then leaves the id numeric with a warning, the escape hatch).
   */
  async roleGroupTypeCatalog(): Promise<Map<number, RoleCatalogEntry>> {
    if (!this.roleCatalog) {
      this.roleCatalog = this.client
        .getAll<CatalogRecord>("/group/roles")
        .then(({ data: rows }) => {
          const map = new Map<number, RoleCatalogEntry>();
          if (Array.isArray(rows)) {
            for (const row of rows) {
              const groupTypeId = Number(row?.groupTypeId);
              if (
                typeof row?.id === "number" &&
                typeof row.name === "string" &&
                Number.isFinite(groupTypeId)
              ) {
                map.set(row.id, { groupTypeId, name: row.name });
              }
            }
          }
          return map;
        })
        .catch(() => new Map<number, RoleCatalogEntry>());
    }
    return this.roleCatalog;
  }

  /**
   * Reverse-sugar a managed-field bag for emission (#52 item A): each numeric id field with a catalog
   * match becomes its logical `campus`/`groupType`/`status` key (dropping the numeric field); an id
   * with NO match stays numeric and is named in `todos` so the emitter can flag it. Every other
   * field passes through untouched in its original position (and a `null` id — "no campus" — is
   * omitted by the emitter).
   */
  async sugarFields(
    fields: Record<string, unknown>,
  ): Promise<{ fields: Record<string, unknown>; todos: Set<string> }> {
    const out: Record<string, unknown> = {};
    const todos = new Set<string>();
    for (const [field, value] of Object.entries(fields)) {
      const rule = REVERSE_ID_FIELDS[field];
      if (rule && typeof value === "number") {
        const key = await this.keyForId(rule.catalog, value);
        if (key !== undefined) {
          out[rule.sugar] = key;
        } else {
          out[field] = value;
          todos.add(field);
        }
        continue;
      }
      out[field] = value;
    }
    return { fields: out, todos };
  }
}
