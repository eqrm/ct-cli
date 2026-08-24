/**
 * Per-host cache of the ChurchTools **session** — the session cookie plus the
 * CSRF token the login handshake yields (#145).
 *
 * Why this exists: `ct` is one-shot, so without it every single invocation
 * re-runs `GET /api/whoami?login_token=…` + `GET /api/csrftoken`. ChurchTools
 * rate-limits *logins*, so a handful of `ct get` calls in a row is enough to be
 * throttled (HTTP 429) before any command reaches its actual endpoint. The login
 * token is a credential; what was missing was somewhere to keep the *session* it
 * buys.
 *
 * ## Where it is stored, and why
 *
 * In the **macOS Keychain**, next to the credentials it derives from — never in
 * a file. A session cookie is a bearer handle on a logged-in ChurchTools
 * account: for as long as it lives it is exactly as powerful as the login token,
 * so it gets exactly the same protection. The Keychain is encrypted at rest and
 * ACL'd by the OS; a `0600` file under `$HOME` is neither (it survives in
 * backups, in `tar`red home directories, and is readable by every process
 * running as the user).
 *
 * That choice also decides the non-macOS story: `keychain.ts` has no file
 * fallback, so on Linux/Windows there is simply **no session cache**. The
 * behaviour there is exactly today's — a handshake per invocation — which is the
 * right trade: this project already refuses to write the login token to a
 * plaintext file on those platforms, and the cookie must not be the loophole
 * that does it anyway.
 *
 * ## Host binding (#30)
 *
 * The cache is keyed by host (account name `session:<host>`) AND stores the host
 * inside the blob, which is re-checked on read. A session captured against one
 * instance is therefore never offered to another, matching the rule the login
 * token already follows.
 *
 * A session is additionally bound to the *token* that bought it, by SHA-256
 * fingerprint (the hash, never the token). Log in as somebody else and the
 * fingerprint no longer matches, so the previous user's session is not silently
 * reused.
 *
 * Nothing here ever logs, prints or returns the cookie in an error: callers get
 * the value or `null`.
 */
import { createHash } from "node:crypto";
import { isMac, keychainDelete, keychainGet, keychainSet, resetKeychainCache } from "./keychain.js";
import type { SessionCache } from "../api/ctClient.js";

/** Keychain account prefix; the rest of the account name is the (normalized) host. */
const SESSION_ACCOUNT_PREFIX = "session:";

/**
 * How long a cached session may be reused before a fresh handshake is forced.
 * ChurchTools does not advertise its session lifetime, so this is a deliberately
 * conservative ceiling rather than a prediction — an already-expired session is
 * handled by the 401 self-heal in `CtClient`, not by this number.
 */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface CachedSession {
  /** The host this session was captured against. Re-checked on read (#30). */
  host: string;
  cookie: string;
  csrfToken: string;
  /** Epoch ms; ages the entry out. */
  obtainedAt: number;
  /** SHA-256 of the login token that bought the session — never the token itself. */
  tokenHash: string;
}

/** A non-reversible fingerprint of the login token, safe to persist alongside the session. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function accountFor(host: string): string {
  return `${SESSION_ACCOUNT_PREFIX}${host}`;
}

/** Parse a stored blob; `null` for anything that is not a well-formed session. */
export function parseSession(raw: string): CachedSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { host, cookie, csrfToken, obtainedAt, tokenHash } = parsed as Record<string, unknown>;
  if (typeof host !== "string" || host === "") return null;
  if (typeof cookie !== "string" || cookie === "") return null;
  if (typeof csrfToken !== "string") return null;
  if (typeof obtainedAt !== "number" || !Number.isFinite(obtainedAt)) return null;
  if (typeof tokenHash !== "string" || tokenHash === "") return null;
  return { host, cookie, csrfToken, obtainedAt, tokenHash };
}

/**
 * The cached session for `host`, or `null`. Returns `null` — rather than
 * throwing — for every "cannot be reused" case: not macOS, nothing stored,
 * corrupt blob, a session captured against a different host, a session bought
 * with a different token, or one older than {@link SESSION_MAX_AGE_MS}
 * (including a blob timestamped in the future, i.e. after a clock change).
 */
export async function readSession(host: string, token: string): Promise<CachedSession | null> {
  if (!isMac()) {
    return null;
  }
  const raw = await keychainGet(accountFor(host));
  if (!raw) {
    return null;
  }
  const session = parseSession(raw);
  if (!session) {
    return null;
  }
  // Belt and braces on top of the host-keyed account: the session must itself
  // claim the host we are about to send it to (#30).
  if (session.host !== host) {
    return null;
  }
  if (session.tokenHash !== tokenFingerprint(token)) {
    return null;
  }
  const age = Date.now() - session.obtainedAt;
  if (age < 0 || age > SESSION_MAX_AGE_MS) {
    return null;
  }
  return session;
}

/** Persist the session for `host`. A no-op off macOS (see the module docs). */
export async function storeSession(
  host: string,
  token: string,
  session: { cookie: string; csrfToken: string },
): Promise<void> {
  if (!isMac()) {
    return;
  }
  const blob: CachedSession = {
    host,
    cookie: session.cookie,
    csrfToken: session.csrfToken,
    obtainedAt: Date.now(),
    tokenHash: tokenFingerprint(token),
  };
  await keychainSet(accountFor(host), JSON.stringify(blob));
  resetKeychainCache(); // a read later in this process must see the new session, not the old one
}

/** Forget the cached session for `host` (logout, or a session the server rejected). */
export async function clearSession(host: string): Promise<void> {
  if (!isMac()) {
    return;
  }
  await keychainDelete(accountFor(host));
  resetKeychainCache();
}

/**
 * The Keychain-backed {@link SessionCache} handed to `CtClient`.
 *
 * `CtClient` takes the cache as a dependency rather than reaching for this
 * module itself, so a client built in a test (or anywhere that must not touch
 * the developer's real Keychain) simply has no cache and behaves exactly as
 * before.
 */
export function keychainSessionCache(): SessionCache {
  return {
    load: readSession,
    save: storeSession,
    drop: clearSession,
  };
}
