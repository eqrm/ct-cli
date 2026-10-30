/**
 * First lock of the read-only gateway proxy (#228): decide, from method + URL + body alone, whether a
 * local request may be forwarded at all. The gateway enforces its own (stricter) allowlist; this check
 * exists so a mistake on the laptop never even leaves it.
 *
 * Allowed: any GET under `/api/`, and exactly two legacy POSTs — `index.php?q=churchauth/ajax` and
 * `index.php?q=churchdb/ajax` with the body exactly `func=getMasterData`.
 */

export type FilterResult =
  | { ok: true; method: "GET" | "POST"; path: string; query: [string, string][] }
  | { ok: false; reason: string };

const LEGACY_QUERIES = new Set(["churchauth/ajax", "churchdb/ajax"]);
const MASTER_DATA_BODY = "func=getMasterData";

/** Query params that carry a credential and must never reach the gateway. */
const STRIPPED_PARAMS = new Set(["login_token"]);

function deny(reason: string): FilterResult {
  return { ok: false, reason };
}

/** `rawUrl` is the request target as received (`/api/groups/1?x=y`). `body` is only consulted for POST. */
export function checkRequest(method: string, rawUrl: string, body: string): FilterResult {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://localhost");
  } catch {
    return deny("malformed request URL");
  }
  const path = url.pathname;
  if (path.split("/").includes("..") || path.includes("//")) return deny("path is not normalized");
  const query = [...url.searchParams.entries()].filter(([k]) => !STRIPPED_PARAMS.has(k.toLowerCase()));

  if (method === "GET") {
    if (!path.startsWith("/api/")) return deny("only GET /api/... is forwarded");
    return { ok: true, method: "GET", path, query };
  }
  if (method === "POST") {
    if (path !== "/index.php")
      return deny("the only allowed POST is /index.php?q=<churchauth|churchdb>/ajax");
    if (query.length !== 1 || query[0]![0] !== "q" || !LEGACY_QUERIES.has(query[0]![1])) {
      return deny("the only allowed POST queries are q=churchauth/ajax and q=churchdb/ajax");
    }
    if (body !== MASTER_DATA_BODY) return deny("the only allowed POST body is func=getMasterData");
    return { ok: true, method: "POST", path, query };
  }
  return deny(`${method} is not allowed`);
}
