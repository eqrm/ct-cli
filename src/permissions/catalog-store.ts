/**
 * The per-instance permission catalog (#105).
 *
 * The name↔authId catalog is not exposed by the REST API, so it ships as a JSON snapshot captured
 * from ONE ChurchTools version. Every plan against an instance on a different version printed:
 *
 *   ! Permission catalog was captured from ChurchTools 3.134.0 but this instance runs 3.135.2.
 *     … regenerate it with `npm run regenerate:permission-catalog`
 *
 * …naming a script that lives in the ct-cli repo. A consumer repo could not act on it short of
 * opening a PR here and waiting for a release, so the warning was unactionable exactly where it was
 * printed, and it printed on every single plan — which trains people to ignore it, including on the
 * plans where a stale authId would actually matter.
 *
 * The fix is to let a consumer repo capture the catalog for ITS OWN host and commit the result:
 * `ct permissions catalog --refresh` writes `.ct/permission-catalog.<host>.json`, and every
 * plan/apply against that host loads it in preference to the bundled snapshot. The bundled catalog
 * stays the fallback, so nothing changes for a repo that never runs the refresh.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CtClient } from "../api/ctClient.js";
import { useCatalog, type CatalogEntry } from "./catalog.js";
import { fetchChurchAuthMasterData, permissionRightDefinitions } from "./masterdata.js";

/** Directory a consumer repo commits its per-instance captures into, beside the config/state files. */
export const CATALOG_DIR = ".ct";

/** Host → filename component. Keeps one file per instance, so dev and prod captures coexist. */
export function hostSlug(host: string): string {
  return host
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function hostCatalogPath(host: string, dir: string = CATALOG_DIR): string {
  return join(dir, `permission-catalog.${hostSlug(host)}.json`);
}

/**
 * Load the per-instance catalog for `host`, if one has been committed, and make it the active one.
 * Returns the path it loaded, or `null` when there is none (the bundled catalog stays active).
 *
 * A malformed file THROWS rather than silently falling back: a repo that committed a capture is
 * relying on it, and quietly planning against a different catalog than the author thinks is in use is
 * the failure mode this whole feature exists to remove.
 */
export async function loadHostCatalog(host: string, dir: string = CATALOG_DIR): Promise<string | null> {
  const path = hostCatalogPath(host, dir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed permission catalog ${path}: not valid JSON (${(err as Error).message}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed permission catalog ${path}: expected a JSON object at the top level.`);
  }
  assertCatalogShape(parsed as Record<string, unknown>, path);
  useCatalog(parsed, { perInstance: true });
  return path;
}

/**
 * Check every right entry, not just the top level. "It parsed as an object" is far too weak a gate
 * for a file that decides what a permission NAME means: an entry missing its `authId` still resolves
 * truthily, so `resolveAuthId` hands back `{ authId: undefined }`, the tuple matches no actual, and
 * `ct apply` PUTs a permission row with `authId: undefined`. A hand-edited, half-merged or
 * future-shaped capture must fail here, loudly, rather than three layers downstream on a write.
 */
function assertCatalogShape(parsed: Record<string, unknown>, path: string): void {
  for (const [name, value] of Object.entries(parsed)) {
    if (name === "$meta") continue; // reserved provenance key — not a right (see catalog.ts)
    const bad = (why: string): never => {
      throw new Error(`Malformed permission catalog ${path}: right "${name}" ${why}.`);
    };
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      bad("is not an object");
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.authId !== "number" || !Number.isFinite(entry.authId)) {
      bad("has no numeric authId");
    }
    if (entry.scopeField !== null && typeof entry.scopeField !== "string") {
      bad("has a scopeField that is neither a string nor null");
    }
  }
}

/**
 * Capture the catalog from a live instance and return it in `catalog.json`'s exact schema.
 *
 * The data comes from the legacy AJAX endpoint the permission editor itself uses — the catalog is
 * genuinely absent from the REST API, so there is no cleaner source. Any authenticated session that
 * can open Settings → Permissions can call it, which is why a consumer repo can now do this for
 * itself. One read; it never writes to the instance.
 */
export async function capturePermissionCatalog(
  client: Pick<CtClient, "legacyPostForm" | "host" | "version">,
): Promise<Record<string, unknown>> {
  const master = await fetchChurchAuthMasterData(client);
  const rights: Record<string, CatalogEntry> = {};
  for (const definition of permissionRightDefinitions(master)) {
    rights[`${definition.module}:${definition.technicalName}`] = {
      authId: definition.authId,
      scopeField: definition.scopeField,
      revocable: definition.revocable,
      desc: definition.description,
    };
  }
  const host = client.host.replace(/^https?:\/\//, "");
  return {
    // Reserved provenance key, split off by catalog.ts and never seen as a right.
    $meta: {
      capturedFrom: host,
      ctVersion: client.version ?? "unknown",
      capturedAt: new Date().toISOString().slice(0, 10),
      rightCount: Object.keys(rights).length,
      source: "POST /index.php?q=churchauth/ajax  func=getMasterData",
      regenerate: `ct permissions catalog --refresh (writes ${hostCatalogPath(client.host)})`,
    },
    ...rights,
  };
}

/** Write a capture to this host's per-instance path, creating `.ct/` if needed. Returns the path. */
export async function writeHostCatalog(
  host: string,
  catalog: Record<string, unknown>,
  dir: string = CATALOG_DIR,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = hostCatalogPath(host, dir);
  await writeFile(path, `${JSON.stringify(catalog, null, 1)}\n`, "utf8");
  return path;
}
