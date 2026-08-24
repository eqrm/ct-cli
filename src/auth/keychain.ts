/**
 * The low-level macOS Keychain access shared by everything this CLI persists
 * locally: the login credentials ({@link ../auth/tokenStore.js}) and the cached
 * session ({@link ./sessionStore.js}).
 *
 * Both are secrets, both live under the same `ct-cli` keychain service, and both
 * need the same per-process read memoization — so the `security` plumbing lives
 * here once, in a module neither of them imports the other through.
 *
 * There is deliberately **no file fallback**. On Linux/Windows there is no
 * keychain backend, and writing a secret (a token *or* a session cookie) to a
 * plaintext file is exactly what this project refuses to do; those platforms
 * supply the token through `CT_HOST` / `CT_LOGINTOKEN` and simply run without a
 * session cache.
 *
 * Note: `security ... -w <value>` passes the value as an argv, briefly visible
 * to `ps`. Acceptable for a local developer CLI; the value never touches git.
 */
import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const KEYCHAIN_SERVICE = "ct-cli";

export function isMac(): boolean {
  return platform() === "darwin";
}

/**
 * Memoized keychain reads for this process, keyed by account. A single run
 * resolves the host (via `resolveConfig`) AND the token (via `authedSession`) —
 * each of which reaches for the stored credentials — so without this cache the
 * same entry is fetched multiple times per command, spawning
 * `security find-generic-password` (and prompting to unlock a locked Keychain)
 * every time. A cached value of `null` = read and absent. Invalidated wholesale
 * on any write (`resetKeychainCache`).
 */
const cachedBlobs = new Map<string, string | null>();

/** Drop the memoized keychain reads. Called after every store/clear; exported for tests. */
export function resetKeychainCache(): void {
  cachedBlobs.clear();
}

export async function keychainSet(account: string, value: string): Promise<void> {
  await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value]);
}

export async function keychainGet(account: string): Promise<string | null> {
  const cached = cachedBlobs.get(account);
  if (cached !== undefined) {
    return cached;
  }
  let value: string | null;
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    value = stdout.trim() || null;
  } catch {
    value = null;
  }
  cachedBlobs.set(account, value);
  return value;
}

export async function keychainDelete(account: string): Promise<void> {
  try {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
  } catch {
    /* not present — nothing to delete */
  }
}
