/**
 * Persistence for the personal ChurchTools login token, keyed by host so one
 * machine can hold tokens for several instances.
 *
 * Read precedence:
 *   1. `CT_LOGINTOKEN` environment variable (CI / one-off use)
 *   2. macOS Keychain (via the `security` CLI), when on darwin
 *   3. credentials file at `~/.config/ct-cli/credentials.json` (0600 fallback)
 *
 * The Keychain is preferred on macOS; the file store is the cross-platform
 * fallback and also catches tokens written before Keychain support existed.
 *
 * Note: `security ... -w <token>` passes the token as an argv, briefly visible
 * to `ps`. Acceptable for a local developer CLI; the value never touches git.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const KEYCHAIN_SERVICE = "ct-cli";

interface Credentials {
  host: string;
  token: string;
}

function isMac(): boolean {
  return platform() === "darwin";
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "ct-cli");
}

function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

async function keychainSet(host: string, token: string): Promise<void> {
  await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", host, "-w", token]);
}

async function keychainGet(host: string): Promise<string | null> {
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      host,
      "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function keychainDelete(host: string): Promise<void> {
  try {
    await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", host]);
  } catch {
    /* not present — nothing to delete */
  }
}

async function fileStore(host: string, token: string): Promise<string> {
  await mkdir(configDir(), { recursive: true });
  const path = credentialsPath();
  const payload: Credentials = { host, token };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function fileRead(): Promise<string | null> {
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    return parsed.token?.trim() || null;
  } catch {
    return null;
  }
}

/** Persist the token; returns a human-readable description of where it landed. */
export async function storeToken(host: string, token: string): Promise<string> {
  if (isMac()) {
    try {
      await keychainSet(host, token);
      return `macOS Keychain (service "${KEYCHAIN_SERVICE}", account "${host}")`;
    } catch {
      /* fall back to file */
    }
  }
  const path = await fileStore(host, token);
  return `${path} (mode 0600)`;
}

export async function readToken(host: string): Promise<string | null> {
  const fromEnv = process.env.CT_LOGINTOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (isMac()) {
    const fromKeychain = await keychainGet(host);
    if (fromKeychain) {
      return fromKeychain;
    }
  }
  return fileRead();
}

export async function clearToken(host: string): Promise<void> {
  if (isMac()) {
    await keychainDelete(host);
  }
  await rm(credentialsPath(), { force: true });
}
