/**
 * Layer 0 + Layer 1: authenticated ChurchTools API access.
 *
 * ChurchTools' personal login token authenticates via a session handshake, NOT
 * an `Authorization` header (which yields a null CSRF token for this token
 * class and breaks writes). The proven flow for this instance is:
 *
 *   1. GET /api/whoami?login_token=<token>  → sets the session cookie
 *   2. GET /api/csrftoken                   → returns the CSRF token
 *   3. every request sends the cookie; every write sends `CSRF-Token: <token>`
 *
 * Phase 0 (#2) confirms this handshake against a live token. Once the typed
 * client is generated (`npm run generate:client`), the hand-written `request`
 * here can be swapped for `openapi-fetch` while keeping this class's surface.
 */
import { type CtConfig } from "../config.js";
import { fetchWithRetry, parseRetryAfterMs } from "./http.js";
import { meetsMinVersion, MIN_CT_VERSION, type CtInfo } from "./version.js";

export interface WhoAmI {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export class CtApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CtApiError";
  }
}

// Write bodies are objects today; the union keeps array bodies representable for any future
// CT endpoint that wants one (the body is only ever JSON.stringify'd, never property-accessed).
type Json = Record<string, unknown> | unknown[];

/**
 * ChurchTools' list-endpoint pagination envelope, carried as `meta.pagination`
 * alongside `data`. Field names confirmed against the live API (#50): a page
 * is exhausted once `current >= lastPage`.
 */
export interface CtPagination {
  total?: number;
  current?: number;
  lastPage?: number;
  limit?: number;
  count?: number;
}

export interface CtMeta {
  pagination?: CtPagination;
  [key: string]: unknown;
}

export interface CtPage<T> {
  data: T[];
  meta?: CtMeta;
}

/** Hard stop so a malformed/adversarial pagination response can't loop forever. */
const MAX_PAGES = 1000;
const DEFAULT_PAGE_LIMIT = 100;

/**
 * A place to keep the session (cookie + CSRF token) BETWEEN `ct` invocations, so
 * a one-shot CLI does not have to re-run the login handshake — and trip
 * ChurchTools' login rate limit — on every single command (#145).
 *
 * The client only ever asks for a session for `host` and hands back one captured
 * against `host`, so the store cannot leak a session across instances (#30). The
 * implementation lives in `src/auth/sessionStore.ts`; it is injected rather than
 * imported so a client without one (tests, `ct auth status`' preflight) behaves
 * exactly as it always has.
 */
export interface SessionCache {
  load(host: string, token: string): Promise<{ cookie: string; csrfToken: string } | null>;
  save(host: string, token: string, session: { cookie: string; csrfToken: string }): Promise<void>;
  drop(host: string): Promise<void>;
}

export interface CtClientOptions {
  sessionCache?: SessionCache;
}

/** Human-readable "wait this long" for a 429, from `Retry-After` when the server sent one. */
function describeRetryAfter(res: Response): string {
  const ms = parseRetryAfterMs(res);
  if (ms === null) {
    return "about a minute";
  }
  const seconds = Math.ceil(ms / 1000);
  return seconds >= 120
    ? `about ${Math.ceil(seconds / 60)} minutes`
    : `about ${Math.max(seconds, 1)} seconds`;
}

export class CtClient {
  private cookie: string | null = null;
  private csrfToken: string | null = null;
  private ctVersion: string | null = null;
  /** Kept so an expired session can be re-bought without the caller having to notice (#145). */
  private loginToken: string | null = null;
  /** Re-entrancy guards: no self-heal while a login (or a resume probe) is already in flight. */
  private loggingIn = false;
  private resuming = false;
  /** At most ONE automatic re-login per process — a server that always 401s must not become a login storm. */
  private reauthAttempts = 0;

  constructor(
    private readonly config: CtConfig,
    private readonly options: CtClientOptions = {},
  ) {}

  get host(): string {
    return this.config.host;
  }

  /**
   * The ChurchTools release this client is talking to, once known (populated by
   * {@link assertMinVersion} / any `/info` read, which every command runs via
   * `authedSession`). `null` until then. Surfaced in the `--env` plan header so a
   * per-env version gate is visible (#22), and used for the permission-catalog
   * staleness warning (#25) — no extra `/info` fetch, since the version is
   * already cached.
   */
  get version(): string | null {
    return this.ctVersion;
  }

  /**
   * Hard-fail if the ChurchTools instance is below the minimum version the CLI
   * requires (group hierarchy / metadata CRUD need v3.96+). One `/info` GET,
   * cached so repeated calls in a session cost nothing. plan/apply/destroy call
   * this via {@link authedSession} — a half-applied structure from a stale
   * instance is exactly what the gate exists to prevent.
   */
  async assertMinVersion(min: string = MIN_CT_VERSION): Promise<void> {
    if (this.ctVersion === null) {
      const info = await this.get<CtInfo>("/info");
      this.ctVersion = info?.version ?? "";
    }
    const version = this.ctVersion;
    if (!version) {
      throw new CtApiError(
        `ChurchTools did not report a version (GET /info) — cannot verify the required minimum ${min}.`,
        0,
        null,
      );
    }
    if (!meetsMinVersion(version, min)) {
      throw new Error(
        `ChurchTools ${version} is below the required minimum ${min}. ` +
          `Upgrade ChurchTools before running plan/apply/destroy.`,
      );
    }
  }

  /**
   * Become an authenticated client — reusing the cached session for this host
   * when there is one, and only otherwise running the login handshake (#145).
   *
   * `fresh: true` forces the handshake (`ct auth login`, which exists precisely
   * to prove the credential works, must not be answered from a cache).
   */
  async authenticate(loginToken: string, opts: { fresh?: boolean } = {}): Promise<WhoAmI> {
    this.loginToken = loginToken;
    if (!opts.fresh) {
      const resumed = await this.resumeCachedSession(loginToken);
      if (resumed) {
        return resumed;
      }
    }
    return this.login(loginToken);
  }

  /**
   * Try the cached session: adopt the cookie + CSRF token and confirm them with
   * a plain `GET /whoami`.
   *
   * That GET carries no `login_token`, so it is an ordinary authenticated read —
   * it does NOT count against ChurchTools' *login* rate limit, which is the
   * whole point of the cache. It also keeps the identity honest: `me` still
   * comes from the server rather than from a stale local copy.
   *
   * A session the server no longer accepts (401/403) is dropped and `null` is
   * returned, so the caller falls through to a real handshake. Anything else
   * (network trouble, a 500) is a real failure and propagates.
   */
  private async resumeCachedSession(loginToken: string): Promise<WhoAmI | null> {
    const cache = this.options.sessionCache;
    if (!cache) {
      return null;
    }
    let cached: { cookie: string; csrfToken: string } | null = null;
    try {
      cached = await cache.load(this.config.host, loginToken);
    } catch {
      return null; // an unreadable cache is never a reason to fail a command
    }
    if (!cached) {
      return null;
    }
    this.cookie = cached.cookie;
    this.csrfToken = cached.csrfToken;
    this.resuming = true;
    try {
      return await this.get<WhoAmI>("/whoami");
    } catch (err) {
      if (!isSessionRejection(err)) {
        throw err;
      }
      this.cookie = null;
      this.csrfToken = null;
      await cache.drop(this.config.host).catch(() => {});
      return null;
    } finally {
      this.resuming = false;
    }
  }

  /** Run the login-token handshake and cache the session cookie + CSRF token. */
  private async login(loginToken: string): Promise<WhoAmI> {
    this.loggingIn = true;
    this.cookie = null;
    this.csrfToken = null;
    try {
      return await this.performLogin(loginToken);
    } finally {
      this.loggingIn = false;
    }
  }

  private async performLogin(loginToken: string): Promise<WhoAmI> {
    // The token rides as a URL query param (it lands in the server's access logs). This is
    // unavoidable for this token class: the handshake above is documented to require the
    // `login_token` query param — an `Authorization` header yields a null CSRF token and breaks
    // writes. The token↔host binding enforced in `authedSession` (issue #30) makes this safe by
    // guaranteeing the token is only ever sent to the host it was captured against.
    const url = `${this.config.host}/api/whoami?login_token=${encodeURIComponent(loginToken)}`;
    const res = await fetchWithRetry(
      url,
      { headers: { Accept: "application/json" } },
      { isIdempotent: true },
    );
    this.captureCookie(res);
    if (!res.ok) {
      if (res.status === 429) {
        // Not a credential problem, and saying "Login failed" reads like one. CT
        // throttles LOGINS per instance, so this fires after a burst of short `ct`
        // invocations — the very thing the session cache exists to stop.
        throw new CtApiError(
          `ChurchTools is rate-limiting logins on ${this.config.host} — your token was not rejected. ` +
            `Wait ${describeRetryAfter(res)} and try again.`,
          res.status,
          await safeBody(res),
        );
      }
      throw new CtApiError(`Login failed (whoami)`, res.status, await safeBody(res));
    }
    if (!this.cookie) {
      throw new CtApiError("Login succeeded but no session cookie was returned", res.status, null);
    }
    await this.refreshCsrfToken();
    // Keep the freshly bought session for the NEXT invocation. Best-effort: a store
    // that refuses (no Keychain, locked Keychain) must not fail the command.
    if (this.cookie && this.csrfToken) {
      await this.options.sessionCache
        ?.save(this.config.host, loginToken, { cookie: this.cookie, csrfToken: this.csrfToken })
        .catch(() => {});
    }
    // Same tolerant unwrap as request(): prefer `.data`, but fall back to the raw body if the
    // envelope is absent, so authenticate and request() agree on the shape.
    const body = (await res.json()) as { data?: WhoAmI };
    return (body.data ?? body) as WhoAmI;
  }

  /**
   * Recover from a 401 on a real request: drop the cached session, log in again,
   * and let the caller retry once. Returns false when re-authentication is not
   * available or not appropriate, in which case the 401 surfaces as usual.
   *
   * A 401 means the request was rejected before it was processed, so the retry is
   * safe for writes too.
   */
  private async reauthenticate(): Promise<boolean> {
    if (this.loginToken === null || this.loggingIn || this.resuming || this.reauthAttempts >= 1) {
      return false;
    }
    this.reauthAttempts++;
    await this.options.sessionCache?.drop(this.config.host).catch(() => {});
    await this.login(this.loginToken);
    return true;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async request<T = unknown>(method: string, path: string, body?: Json): Promise<T> {
    const parsed = await this.requestEnvelope(method, path, body);
    if (parsed === undefined) {
      return undefined as T;
    }
    const envelope = parsed as { data?: T };
    return (envelope.data ?? envelope) as T;
  }

  /**
   * Call ChurchTools' LEGACY AJAX interface — `POST /index.php?q=<module>/ajax`, form-encoded,
   * `{status, data}` envelope. Not REST, not in any OpenAPI spec (#111), and reached only where CT
   * exposes no REST equivalent.
   *
   * Today that is the master-data registry (`churchdb/ajax`), which is the only write path for
   * Bereiche (#108). The permission catalog reads the sibling `churchauth/ajax` through its own
   * script rather than this method, because that runs outside an authenticated session.
   *
   * Reuses the session this client already holds: the login-token handshake set the cookie, and the
   * legacy endpoint enforces the SAME `CSRF-Token` header as the REST writes (verified live — without
   * it, `churchdb/ajax` answers 401 "CSRF-Token is invalid" rather than redirecting to a login page).
   *
   * Unlike REST, a failure here is a 200 with `{"status":"error"}`, so the status code alone proves
   * nothing — the envelope is checked and a non-success is raised as a {@link CtApiError} carrying
   * CT's own message. (An unknown `func` returns exactly that, which is how the delete verb was
   * confirmed to exist rather than being silently ignored: `deleteMasterData` succeeded where a
   * made-up `delMasterData` came back "was not defined as Function!".)
   */
  async ajax<T = unknown>(module: string, params: Record<string, string>): Promise<T> {
    if (!this.cookie) {
      throw new CtApiError("Not authenticated — run `ct auth login` first", 401, null);
    }
    if (!this.csrfToken) {
      await this.refreshCsrfToken();
    }
    const url = `${this.config.host}/index.php?q=${module}/ajax`;
    const label = `POST ${module}/ajax ${params.func ?? ""}`.trim();
    // `redirect: "manual"` on purpose: an expired session makes this endpoint bounce through the
    // login page, and following that lands on a redirect loop whose eventual error names neither
    // the endpoint nor the real cause ("redirect count exceeded").
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Cookie: this.cookie,
          "CSRF-Token": this.csrfToken ?? "",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
        redirect: "manual",
      },
      { isIdempotent: false },
    );
    this.captureCookie(res);
    if (!res.ok) {
      throw new CtApiError(`${label} failed`, res.status, await safeBody(res));
    }
    const text = await res.text();
    let envelope: { status?: string; message?: string; data?: T };
    try {
      envelope = JSON.parse(text) as typeof envelope;
    } catch {
      throw new CtApiError(`${label} returned a non-JSON body`, res.status, text.slice(0, 500));
    }
    if (envelope.status !== "success") {
      throw new CtApiError(
        `${label} returned status "${envelope.status ?? "?"}"${envelope.message ? `: ${envelope.message}` : ""}`,
        res.status,
        envelope,
      );
    }
    return envelope.data as T;
  }

  /**
   * Fetch every page of a ChurchTools list endpoint and concatenate them, so
   * callers see the whole collection instead of just CT's default first page
   * (#50). CT caps `limit` at a per-endpoint maximum below 500 on real
   * instances, so this defaults to a conservative page size and pages via
   * `?page=N&limit=M` until `meta.pagination.current >= lastPage`. Endpoints
   * that don't return pagination meta (or return everything on page 1) fall
   * out after a single request.
   */
  async getAll<T = unknown>(path: string, options: { limit?: number } = {}): Promise<CtPage<T>> {
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    const items: T[] = [];
    let meta: CtMeta | undefined;
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const parsed = await this.requestEnvelope("GET", withPageParams(path, page, limit));
      if (parsed === undefined) {
        break;
      }
      const isArrayEnvelope = Array.isArray(parsed);
      const envelope = isArrayEnvelope ? undefined : (parsed as { data?: unknown; meta?: CtMeta });
      const pageData = isArrayEnvelope ? parsed : (envelope?.data ?? parsed);
      const pageItems = Array.isArray(pageData) ? (pageData as T[]) : [];
      items.push(...pageItems);
      const pageMeta = envelope?.meta;
      meta = pageMeta ?? meta;
      const pagination = pageMeta?.pagination;
      if (
        pageItems.length === 0 ||
        !pagination ||
        pagination.current === undefined ||
        pagination.lastPage === undefined
      ) {
        break;
      }
      if (pagination.current >= pagination.lastPage) {
        break;
      }
      page += 1;
    }
    return { data: items, meta };
  }

  /**
   * ONE request's raw envelope — the parsed `data` alongside the `meta` that carries CT's
   * pagination block (#100). {@link request} unwraps `data` and drops `meta`, which is exactly what
   * makes a single-page read indistinguishable from a complete one; `ct get raw` needs both to tell
   * "this endpoint returned everything" from "this endpoint returned CT's default first page".
   * `data` is the envelope's `data` when present, else the whole body (CT is inconsistent about the
   * envelope), so a single-object endpoint round-trips unchanged.
   */
  async getRaw<T = unknown>(path: string): Promise<{ data: T; meta?: CtMeta }> {
    const parsed = await this.requestEnvelope("GET", path);
    if (parsed === undefined) {
      return { data: undefined as T };
    }
    if (Array.isArray(parsed)) {
      return { data: parsed as T };
    }
    const envelope = parsed as { data?: T; meta?: CtMeta };
    return { data: (envelope.data ?? envelope) as T, meta: envelope.meta };
  }

  /**
   * Shared fetch + parse for {@link request} and {@link getAll}: performs the
   * HTTP call, throws a status/body-carrying {@link CtApiError} on failure,
   * and returns the raw parsed JSON envelope (still carrying `data`/`meta`) —
   * or `undefined` for an empty 2xx body. Kept private so `request()`'s
   * `.data ?? envelope` unwrap stays the single source of truth for existing
   * callers (plan/apply/adopt) while `getAll()` gets at `meta` too.
   */
  private async requestEnvelope(method: string, path: string, body?: Json): Promise<unknown> {
    if (!this.cookie) {
      throw new CtApiError("Not authenticated — run `ct auth login` first", 401, null);
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Cookie: this.cookie,
    };
    if (method !== "GET" && method !== "HEAD") {
      if (!this.csrfToken) {
        await this.refreshCsrfToken();
      }
      headers["CSRF-Token"] = this.csrfToken ?? "";
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchWithRetry(
      `${this.config.host}/api${path}`,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { isIdempotent: method === "GET" || method === "HEAD" },
    );
    this.captureCookie(res);
    if (res.status === 401) {
      // The session died (expired, or invalidated server-side — a logout elsewhere,
      // a restart). Buy a new one once and replay the request, so a stale cached
      // session self-heals instead of surfacing as "Not authenticated" (#145).
      if (await this.reauthenticate()) {
        // Drain the response we're discarding so its socket isn't left buffered.
        await res.body?.cancel().catch(() => {});
        return this.requestEnvelope(method, path, body);
      }
    }
    if (!res.ok) {
      throw new CtApiError(`${method} ${path} failed`, res.status, await safeBody(res));
    }
    if (res.status === 204) {
      return undefined;
    }
    // Any 2xx may carry an empty or non-JSON body (DELETEs commonly do). A bare
    // res.json() there throws a raw SyntaxError naming no request. Read the text
    // first: empty → undefined; unparseable → a CtApiError that names method+path.
    const text = await res.text();
    if (text.trim() === "") {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new CtApiError(`${method} ${path} returned a non-JSON body`, res.status, text);
    }
  }

  /**
   * POST a form body to a LEGACY (non-`/api`) ChurchTools endpoint, riding the same session (#105).
   *
   * ChurchTools does not expose the permission master data over REST — the permission editor reads it
   * from `index.php?q=churchauth/ajax`. This is the only door to it, so it is a narrow, deliberate
   * escape hatch from the REST surface rather than a general-purpose method: it takes an `index.php`
   * query name, not an arbitrary URL, and it is a read in practice (the one caller performs
   * `getMasterData`). The CSRF header is sent because this is a POST, exactly as the browser does.
   */
  async legacyPostForm<T = unknown>(query: string, form: Record<string, string>): Promise<T> {
    if (!this.cookie) {
      throw new CtApiError("Not authenticated — run `ct auth login` first", 401, null);
    }
    if (!this.csrfToken) {
      await this.refreshCsrfToken();
    }
    const url = `${this.config.host}/index.php?q=${encodeURIComponent(query)}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Cookie: this.cookie,
          "CSRF-Token": this.csrfToken ?? "",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form).toString(),
      },
      // Not retried on 5xx: a legacy POST is not declared idempotent, and a 429 is still safe to retry.
      { isIdempotent: false },
    );
    this.captureCookie(res);
    if (!res.ok) {
      throw new CtApiError(`POST index.php?q=${query} failed`, res.status, await safeBody(res));
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CtApiError(`POST index.php?q=${query} returned a non-JSON body`, res.status, text);
    }
  }

  private async refreshCsrfToken(): Promise<void> {
    // A plain authenticated GET: it rides the session cookie and GET skips the CSRF branch in
    // request(), so this cannot recurse — and it reuses request()'s envelope unwrap + guarded 2xx
    // parsing instead of duplicating the bootstrap fetch here. Callers only reach this once a cookie
    // exists (authenticate sets it; request()'s write path guards on it), so the old empty-cookie
    // early-return is unreachable and dropped.
    this.csrfToken = await this.get<string>("/csrftoken");
  }

  /** Merge any Set-Cookie values into the stored cookie header. */
  private captureCookie(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) {
      return;
    }
    const jar = new Map<string, string>(
      (this.cookie ?? "")
        .split("; ")
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf("=");
          return [pair.slice(0, eq), pair.slice(eq + 1)] as [string, string];
        }),
    );
    for (const raw of setCookies) {
      const first = raw.split(";", 1)[0] ?? "";
      const eq = first.indexOf("=");
      if (eq > 0) {
        jar.set(first.slice(0, eq), first.slice(eq + 1));
      }
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** True when an error says "this session is no longer good" rather than "the request was bad". */
function isSessionRejection(err: unknown): boolean {
  return err instanceof CtApiError && (err.status === 401 || err.status === 403);
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Append `page`/`limit` query params, respecting any query string the caller already has. */
export function withPageParams(path: string, page: number, limit: number): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}page=${page}&limit=${limit}`;
}

/** True when the caller's path already carries its own `page`/`limit` — a deliberate single-page probe. */
export function hasOwnPageParams(path: string): boolean {
  const query = path.split("?")[1];
  return query !== undefined && /(^|&)(page|limit)=/.test(query);
}

/**
 * Whether a pagination envelope says MORE rows exist than the response carried (#100). Both signals
 * are checked because CT populates them inconsistently across endpoints: `current < lastPage` is the
 * authoritative one, and `total > count` catches an endpoint that reports a total without page
 * numbers. No pagination block at all ⇒ the endpoint is not a paged list, so nothing is missing.
 */
export function hasMorePages(meta: CtMeta | undefined, received: number): boolean {
  const p = meta?.pagination;
  if (!p) {
    return false;
  }
  if (p.current !== undefined && p.lastPage !== undefined && p.current < p.lastPage) {
    return true;
  }
  return p.total !== undefined && p.total > received;
}
