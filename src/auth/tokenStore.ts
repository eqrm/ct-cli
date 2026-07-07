/**
 * Persistence for the personal ChurchTools login token.
 *
 * A single token is stored in the macOS Keychain (via the `security` CLI).
 * There is no file fallback: on CI or non-macOS hosts, supply the token through
 * the `CT_LOGINTOKEN` environment variable instead.
 *
 * Read precedence:
 *   1. `CT_LOGINTOKEN` environment variable (CI / one-off use)
 *   2. macOS Keychain
 *
 * Note: `security ... -w <token>` passes the token as an argv, briefly visible
 * to `ps`. Acceptable for a local developer CLI; the value never touches git.
 */
import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const KEYCHAIN_SERVICE = "ct-cli";
const KEYCHAIN_ACCOUNT = "login-token";

function isMac(): boolean {
  return platform() === "darwin";
}

async function keychainSet(token: string): Promise<void> {
  await run("security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    token,
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

async function keychainDelete(): Promise<void> {
  try {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
  } catch {
    /* not present — nothing to delete */
  }
}

/** Persist the token in the macOS Keychain; returns a human-readable location. */
export async function storeToken(token: string): Promise<string> {
  if (!isMac()) {
    throw new Error(
      "Token storage requires the macOS Keychain. On other platforms, set CT_LOGINTOKEN instead.",
    );
  }
  await keychainSet(token);
  return `macOS Keychain (service "${KEYCHAIN_SERVICE}", account "${KEYCHAIN_ACCOUNT}")`;
}

export async function readToken(): Promise<string | null> {
  const fromEnv = process.env.CT_LOGINTOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (isMac()) {
    return keychainGet();
  }
  return null;
}

export async function clearToken(): Promise<void> {
  if (isMac()) {
    await keychainDelete();
  }
}
