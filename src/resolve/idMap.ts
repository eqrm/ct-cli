/**
 * The OpenTofu id map: a committed, per-host `key -> id` table for resources ct no longer declares
 * (#181).
 *
 * ## The blocker this exists for
 *
 * The tier-0 cutover moves campuses, group types, departments, person statuses and comment viewers
 * to `terraform-provider-churchtools`, which means their tables leave `ct.config.ts` AND their
 * entries leave `ct-state.<env>.json`. Hundreds of REFERENCES stay behind (`campus: "mainz"`,
 * `personStatus: "status_unbekannt"`), and those still have to resolve.
 *
 * `verify` calls them "logical ref, resolved live — not compared", which is true but only as a
 * FALLBACK: while the object was in ct's state, the key resolved from state; with the state entry
 * gone, resolution falls back to matching the key against the live object's NAME. ct's tier-0 keys
 * were never name-derived, so that fallback cannot work for them — structurally, not by accident:
 *
 *   key                     live name
 *   status_unbekannt        Unbekannt
 *   status_5_core           5 - Core
 *   egc                     Equippers Germany Central
 *
 * No slug of those names produces those keys. And a literal id is not an option either: one config
 * serves two hosts, and 39 of 43 tier-0 ids differ between them.
 *
 * ## Why a committed file rather than reading tofu's remote state
 *
 * After the cutover, tofu's state IS the authoritative key→id map, and it keys on exactly the
 * logical names the config already uses (`churchtools_person_status.status_unbekannt` came from
 * `status_unbekannt`). Reading it directly, though, would put an S3 backend — credentials, a network
 * dependency, one AWS SDK — inside a CLI whose other reads are all ChurchTools. So the map is a
 * file: written by `ct export tf` from the state it is exporting, refreshed from a `tofu state pull`
 * by `ct ids sync`, and committed per host so portability survives.
 *
 * ## Where it sits in resolution
 *
 * AFTER ct's own managed state (ct never stops trusting what it owns) and BEFORE the live catalog
 * (the map is exact, the catalog match is a name guess). See `Resolver.resolve`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_DIR, hostSlug } from "../permissions/catalog-store.js";

/** One resolvable resource: its ct key, its id on this host, and the HCL label tofu knows it by. */
export interface IdMapEntry {
  type: string;
  key: string;
  id: number;
  /**
   * The HCL label the exporter gave it, when that differs from the key (`3_groupactive` →
   * `g_3_groupactive`). Retained so `ct ids sync` can map a tofu resource address BACK to the ct key
   * it came from — the relabelling is many-to-one, so it cannot be re-derived from the label alone.
   */
  label?: string;
}

export interface IdMapMeta {
  host: string;
  source: string;
  generatedAt: string;
  entries: number;
  [k: string]: unknown;
}

/** The map as the resolver consumes it: exact lookups, plus the label index `ids sync` needs. */
export interface IdMap {
  path: string;
  meta: IdMapMeta | null;
  entries: IdMapEntry[];
  /** `type\0key` → id. */
  ids: ReadonlyMap<string, number>;
  /** `type\0label` → ct key, for reading a tofu state back. */
  keysByLabel: ReadonlyMap<string, string>;
}

function entryKey(type: string, key: string): string {
  return `${type}\u0000${key}`;
}

export function idMapPath(host: string, dir: string = CATALOG_DIR): string {
  return join(dir, `ids.${hostSlug(host)}.json`);
}

/**
 * The file shape: `$meta` plus one object per resource type, exactly like the permission catalog's
 * layout, so the two committed artefacts read the same way in a diff.
 *
 *   { "$meta": {...}, "campus": { "mainz": { "id": 0 } }, "person-status": { "status_5_core": { "id": 6 } } }
 */
export function renderIdMap(host: string, entries: readonly IdMapEntry[], source: string): string {
  const byType: Record<string, Record<string, { id: number; label?: string }>> = {};
  // Sorted by type then key: a committed file has to be byte-stable across runs, or every export
  // shows up as a diff (same reason the HCL export sorts).
  for (const entry of [...entries].sort((a, b) =>
    entryKey(a.type, a.key) < entryKey(b.type, b.key) ? -1 : 1,
  )) {
    (byType[entry.type] ??= {})[entry.key] =
      entry.label !== undefined && entry.label !== entry.key
        ? { id: entry.id, label: entry.label }
        : { id: entry.id };
  }
  const meta: IdMapMeta = {
    host,
    source,
    generatedAt: new Date().toISOString().slice(0, 10),
    entries: entries.length,
  };
  return `${JSON.stringify({ $meta: meta, ...byType }, null, 1)}\n`;
}

export function parseIdMap(raw: string, path: string, host: string): IdMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed id map ${path}: not valid JSON (${(err as Error).message}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed id map ${path}: expected a JSON object at the top level.`);
  }
  const { $meta, ...types } = parsed as { $meta?: IdMapMeta } & Record<string, unknown>;
  // Host-checked like the session cache (#30) and asserted like the state file: a map applied to the
  // wrong instance would resolve every reference to a plausible id on the wrong host, which is worse
  // than not resolving at all — nothing downstream could tell.
  if ($meta && typeof $meta.host === "string" && hostSlug($meta.host) !== hostSlug(host)) {
    throw new Error(
      `Id map ${path} was generated for ${$meta.host}, but the resolved host is ${host}. ` +
        `Re-generate it for this host (\`ct export tf --env <name>\`) — applying another host's ids ` +
        `would resolve every reference to the wrong resource.`,
    );
  }
  const entries: IdMapEntry[] = [];
  for (const [type, rows] of Object.entries(types)) {
    if (typeof rows !== "object" || rows === null || Array.isArray(rows)) {
      throw new Error(`Malformed id map ${path}: "${type}" is not an object of key → { id }.`);
    }
    for (const [key, value] of Object.entries(rows as Record<string, unknown>)) {
      const row = value as { id?: unknown; label?: unknown };
      if (typeof row?.id !== "number" || !Number.isFinite(row.id)) {
        throw new Error(`Malformed id map ${path}: ${type} "${key}" has no numeric id.`);
      }
      entries.push({
        type,
        key,
        id: row.id,
        ...(typeof row.label === "string" ? { label: row.label } : {}),
      });
    }
  }
  return {
    path,
    meta: $meta ?? null,
    entries,
    ids: new Map(entries.map((e) => [entryKey(e.type, e.key), e.id])),
    keysByLabel: new Map(entries.map((e) => [entryKey(e.type, e.label ?? e.key), e.key])),
  };
}

/**
 * Load this host's map, or `null` when there is none (every reference then resolves exactly as it
 * does today). A malformed or foreign map THROWS rather than being skipped: a repo that committed
 * one is relying on it, and silently resolving without it is how the cutover breaks unnoticed.
 */
export async function loadIdMap(host: string, dir: string = CATALOG_DIR): Promise<IdMap | null> {
  const path = idMapPath(host, dir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  return parseIdMap(raw, path, host);
}

export async function writeIdMap(
  host: string,
  entries: readonly IdMapEntry[],
  dir: string = CATALOG_DIR,
  source = "ct export tf",
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = idMapPath(host, dir);
  await writeFile(path, renderIdMap(host, entries, source), "utf8");
  return path;
}
