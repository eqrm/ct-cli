/**
 * Persistence for the ChurchTools credentials: the instance **host** and the
 * personal **login token**, stored together so a token is always bound to the
 * instance it authenticates against.
 *
 * They live in the macOS Keychain (via the `security` CLI) as a single JSON
 * blob. There is no file fallback: on CI or non-macOS hosts, supply the host and
 * token through the `CT_HOST` / `CT_LOGINTOKEN` environment variables instead.
 *
 * Read precedence is applied by the callers:
 *   - token: `CT_LOGINTOKEN` env  → stored credentials
 *   - host:  `CT_HOST` env        → stored credentials  (see config.ts)
 *
 * Note: `security ... -w <value>` passes the value as an argv, briefly visible
 * to `ps`. Acceptable for a local developer CLI; the value never touches git.
 */
import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const KEYCHAIN_SERVICE = "ct-cli";
const KEYCHAIN_ACCOUNT = "credentials";
/** Pre-host account name; a bare token used to live here. Cleared on logout so no secret is orphaned. */
const LEGACY_KEYCHAIN_ACCOUNT = "login-token";

export interface Credentials {
  host: string;
  token: string;
}

function isMac(): boolean {
  return platform() === "darwin";
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

async function keychainSet(value: string): Promise<void> {
  await run("security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    value,
  ]);
}

async function keychainGet(): Promise<string | null> {
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function keychainDelete(account: string): Promise<void> {
  try {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
  } catch {
    /* not present — nothing to delete */
  }
}

/** Persist host + token in the macOS Keychain; returns a human-readable location. */
export async function storeCredentials(creds: Credentials): Promise<string> {
  if (!isMac()) {
    throw new Error(
      "Credential storage requires the macOS Keychain. On other platforms, set CT_HOST and CT_LOGINTOKEN instead.",
    );
  }
  await keychainSet(JSON.stringify(creds));
  return `macOS Keychain (service "${KEYCHAIN_SERVICE}", account "${KEYCHAIN_ACCOUNT}")`;
}

/** The stored credentials, or null when nothing valid is stored. */
export async function readCredentials(): Promise<Credentials | null> {
  if (!isMac()) {
    return null;
  }
  const raw = await keychainGet();
  return raw ? parseCredentials(raw) : null;
}

/** The login token: `CT_LOGINTOKEN` env wins, else the stored credentials. */
export async function readToken(): Promise<string | null> {
  const fromEnv = process.env.CT_LOGINTOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return (await readCredentials())?.token ?? null;
}

/** The stored instance host (no env fallback — env precedence lives in resolveConfig). */
export async function readStoredHost(): Promise<string | null> {
  return (await readCredentials())?.host ?? null;
}

export async function clearCredentials(): Promise<void> {
  if (isMac()) {
    await keychainDelete(KEYCHAIN_ACCOUNT);
    // Also drop the pre-host bare-token entry so an upgrade doesn't leave a secret behind.
    await keychainDelete(LEGACY_KEYCHAIN_ACCOUNT);
  }
}
