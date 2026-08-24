/**
 * Persistence for the ChurchTools credentials: the instance **host** and the
 * personal **login token**, stored together so a token is always bound to the
 * instance it authenticates against.
 *
 * They live in the macOS Keychain (via the `security` CLI) as JSON blobs. There
 * is no file fallback: on CI or non-macOS hosts, supply the host and token
 * through the `CT_HOST` / `CT_LOGINTOKEN` environment variables instead.
 *
 * Multi-host (#22): each host's credentials are stored under a **per-host account**
 * (account name = the host), so one machine can hold logins for several instances
 * (e.g. `eqrm-dev` and `prod`) at once. A legacy single `"credentials"` account is
 * still written as the "default / last login" pointer (so the single-host path —
 * `readStoredHost()` with no host — keeps working) and is still READ as a fallback
 * for a host that has no per-host account yet (a login made before this change).
 *
 * Read precedence is applied by the callers:
 *   - token: `CT_LOGINTOKEN` env  → stored credentials for the host
 *   - host:  `CT_HOST` env        → stored default host  (see config.ts)
 *
 * Note: `security ... -w <value>` passes the value as an argv, briefly visible
 * to `ps`. Acceptable for a local developer CLI; the value never touches git.
 */
import { clearSession } from "./sessionStore.js";
import {
  isMac,
  keychainDelete,
  keychainGet,
  keychainSet,
  resetKeychainCache,
  KEYCHAIN_SERVICE,
} from "./keychain.js";

/** Re-exported so callers (and tests) keep one entry point for invalidating stored reads. */
export { resetKeychainCache };

/** The "default / last login" account — a single blob, also the single-host (pre-#22) location. */
const DEFAULT_ACCOUNT = "credentials";
/** Pre-host account name; a bare token used to live here. Cleared on logout so no secret is orphaned. */
const LEGACY_KEYCHAIN_ACCOUNT = "login-token";

export interface Credentials {
  host: string;
  token: string;
}

/**
 * Whether this platform has a credential store `ct` can write to — today, the
 * macOS Keychain and nothing else. Exported because callers need to know BEFORE
 * they collect anything: an interactive login that gathered a password on Linux
 * could only throw it away again at {@link storeCredentials}, having handled a
 * secret for nothing. Those platforms keep the `CT_HOST` / `CT_LOGINTOKEN`
 * guidance instead (#138).
 */
export function isSecureStorageAvailable(): boolean {
  return isMac();
}

/** Parse the stored blob. Returns null for anything that is not a well-formed {host, token}. */
export function parseCredentials(raw: string): Credentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // legacy bare-token value or corruption — require a fresh `auth login`
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { host, token } = parsed as Record<string, unknown>;
  if (typeof host !== "string" || host === "" || typeof token !== "string" || token === "") {
    return null;
  }
  return { host, token };
}

/**
 * Persist host + token in the macOS Keychain; returns a human-readable location.
 * Written to BOTH the per-host account (so `readCredentials(host)` finds it) and
 * the default `"credentials"` account (so the single-host path — resolve the host
 * with no `--env` — keeps working, and this login becomes the default).
 */
export async function storeCredentials(creds: Credentials): Promise<string> {
  if (!isMac()) {
    throw new Error(
      "Credential storage requires the macOS Keychain. On other platforms, set CT_HOST and CT_LOGINTOKEN instead.",
    );
  }
  const blob = JSON.stringify(creds);
  await keychainSet(creds.host, blob);
  await keychainSet(DEFAULT_ACCOUNT, blob);
  resetKeychainCache(); // a fresh login must invalidate any read the process already cached
  return `macOS Keychain (service "${KEYCHAIN_SERVICE}", account "${creds.host}")`;
}

/**
 * The stored credentials. With a `host`, prefer that host's per-host account,
 * then fall back to the legacy default blob ONLY when its host matches (so a
 * pre-#22 single login keeps working, but one host's token never leaks for
 * another). With no `host`, return the default / last-login blob (single-host path).
 */
export async function readCredentials(host?: string): Promise<Credentials | null> {
  if (!isMac()) {
    return null;
  }
  if (host === undefined) {
    const raw = await keychainGet(DEFAULT_ACCOUNT);
    return raw ? parseCredentials(raw) : null;
  }
  const keyed = await keychainGet(host);
  const keyedCreds = keyed ? parseCredentials(keyed) : null;
  if (keyedCreds) {
    return keyedCreds;
  }
  const fallbackRaw = await keychainGet(DEFAULT_ACCOUNT);
  const fallback = fallbackRaw ? parseCredentials(fallbackRaw) : null;
  return fallback && fallback.host === host ? fallback : null;
}

/** The login token: `CT_LOGINTOKEN` env wins, else the stored credentials for `host`. */
export async function readToken(host?: string): Promise<string | null> {
  const fromEnv = process.env.CT_LOGINTOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return (await readCredentials(host))?.token ?? null;
}

/** The stored default instance host (no env fallback — env precedence lives in resolveConfig). */
export async function readStoredHost(): Promise<string | null> {
  return (await readCredentials())?.host ?? null;
}

/**
 * Remove stored credentials.
 *
 * With no `host`: clears the default blob, the pre-host bare-token entry, and —
 * for the current default login — its per-host account, so a single-host logout
 * leaves no secret behind. (Additional per-host logins for OTHER hosts are left
 * in place; re-login overwrites them.)
 *
 * With a `host` (already normalized — `ct auth logout --env <name>`, #117):
 * clears only that host's per-host account, leaving other hosts logged in. The
 * default blob is dropped too when it points at that same host, since it holds a
 * copy of the very token being removed — which also un-sets the host that
 * commands WITHOUT `--env` fall back to. That is reported back in
 * `clearedDefault` so the caller can say so instead of promising, wrongly, that
 * nothing else changed.
 *
 * Either way the host's **cached session** goes with its credentials (#145): the
 * session cookie is a live authenticated handle on the instance, so leaving it
 * behind would mean `ct auth logout` had not actually logged anything out.
 */
export interface ClearCredentialsResult {
  /** True when the default (unqualified) login was removed along with the host's. */
  clearedDefault: boolean;
}

export async function clearCredentials(host?: string): Promise<ClearCredentialsResult> {
  let clearedDefault = false;
  if (isMac()) {
    if (host !== undefined) {
      await keychainDelete(host);
      await clearSession(host);
      const fallback = await readCredentials(); // the default blob may hold the same token
      if (fallback?.host === host) {
        await keychainDelete(DEFAULT_ACCOUNT);
        await keychainDelete(LEGACY_KEYCHAIN_ACCOUNT);
        clearedDefault = true;
      }
    } else {
      clearedDefault = true;
      const current = await readCredentials(); // default blob → its host's per-host account
      if (current) {
        await keychainDelete(current.host);
        await clearSession(current.host);
      }
      await keychainDelete(DEFAULT_ACCOUNT);
      // Also drop the pre-host bare-token entry so an upgrade doesn't leave a secret behind.
      await keychainDelete(LEGACY_KEYCHAIN_ACCOUNT);
    }
  }
  resetKeychainCache(); // a later read in the same process must not return the cleared secret
  return { clearedDefault };
}
