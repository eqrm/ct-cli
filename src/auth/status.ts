/**
 * Per-environment authentication status (#117).
 *
 * "Which account am I using against dev?" is a question you ask *before* an
 * apply, not after — but the only way to answer it used to be to run something
 * that touches the host for real, or to read `ct.envs.json` and the Keychain by
 * hand. This resolves the same host + token an `--env` command would resolve,
 * and reports who that token belongs to.
 *
 * The resolution order deliberately mirrors `authedSession`, so a green line
 * here means the same command with `--env <name>` will authenticate the same
 * way: a profile `tokenEnv` (CI) → `CT_LOGINTOKEN` → the host-keyed Keychain
 * entry. Nothing here writes anything; the only network call is the `whoami`
 * handshake, and only for an env that actually has a token.
 */
import { CtClient, type WhoAmI } from "../api/ctClient.js";
import { readCredentials, type Credentials } from "./tokenStore.js";
import type { EnvProfile } from "../env/envs.js";

/** Where an env's token came from — `null` when there is none to try. */
export type TokenSource = { kind: "env"; variable: string } | { kind: "stored" } | { kind: "none" };

export interface EnvAuthStatus {
  name: string;
  host: string;
  source: TokenSource;
  /** Who the token authenticates as. Absent when there is no token, or the check failed. */
  identity?: WhoAmI;
  /** Why the check failed (expired token, wrong host, instance unreachable). */
  error?: string;
}

export interface StatusDeps {
  env?: NodeJS.ProcessEnv;
  readStored?: (host: string) => Promise<Credentials | null>;
  whoami?: (host: string, token: string) => Promise<WhoAmI>;
}

async function defaultWhoami(host: string, token: string): Promise<WhoAmI> {
  return new CtClient({ host }).authenticate(token);
}

/** Resolve the token an `--env <name>` command would use, without disclosing it. */
async function resolveToken(
  profile: EnvProfile,
  env: NodeJS.ProcessEnv,
  readStored: (host: string) => Promise<Credentials | null>,
): Promise<{ token: string; source: TokenSource } | { token: null; source: TokenSource }> {
  if (profile.tokenEnv) {
    const fromProfileVar = env[profile.tokenEnv]?.trim();
    if (fromProfileVar) {
      return { token: fromProfileVar, source: { kind: "env", variable: profile.tokenEnv } };
    }
  }
  const ambient = env.CT_LOGINTOKEN?.trim();
  if (ambient) {
    return { token: ambient, source: { kind: "env", variable: "CT_LOGINTOKEN" } };
  }
  const stored = await readStored(profile.host);
  if (stored) {
    return { token: stored.token, source: { kind: "stored" } };
  }
  return { token: null, source: { kind: "none" } };
}

/** Check one environment. Never throws: a failure is reported as the env's status. */
export async function checkEnvAuth(profile: EnvProfile, deps: StatusDeps = {}): Promise<EnvAuthStatus> {
  const env = deps.env ?? process.env;
  const readStored = deps.readStored ?? readCredentials;
  const whoami = deps.whoami ?? defaultWhoami;

  const { token, source } = await resolveToken(profile, env, readStored);
  if (token === null) {
    return { name: profile.name, host: profile.host, source };
  }
  try {
    return { name: profile.name, host: profile.host, source, identity: await whoami(profile.host, token) };
  } catch (err) {
    return {
      name: profile.name,
      host: profile.host,
      source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check every environment. Sequential on purpose: each check is a login
 * handshake against a different instance, and a burst of them across hosts is
 * exactly the traffic pattern this project keeps deliberately polite.
 */
export async function checkAllEnvAuth(
  profiles: EnvProfile[],
  deps: StatusDeps = {},
): Promise<EnvAuthStatus[]> {
  const statuses: EnvAuthStatus[] = [];
  for (const profile of profiles) {
    statuses.push(await checkEnvAuth(profile, deps));
  }
  return statuses;
}

/** `Vorname Nachname (#42)`, degrading to `#42` when the instance returns no name. */
export function describeIdentity(me: WhoAmI): string {
  const name = `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim();
  return name ? `${name} (#${me.id})` : `#${me.id}`;
}

function describeSource(source: TokenSource): string {
  switch (source.kind) {
    case "env":
      return `via $${source.variable}`;
    case "stored":
      return "via Keychain";
    case "none":
      return "";
  }
}

/** One aligned report line per env — the columns are padded to the widest entry. */
export function renderEnvAuth(statuses: EnvAuthStatus[]): string[] {
  const nameWidth = Math.max(0, ...statuses.map((s) => s.name.length));
  const hostWidth = Math.max(0, ...statuses.map((s) => s.host.length));
  return statuses.map((status) => {
    const prefix = `${status.name.padEnd(nameWidth)}  ${status.host.padEnd(hostWidth)}`;
    if (status.identity) {
      return `${prefix}  ✓ ${describeIdentity(status.identity)} ${describeSource(status.source)}`.trimEnd();
    }
    if (status.error) {
      return `${prefix}  ✗ ${status.error} ${describeSource(status.source)}`.trimEnd();
    }
    return `${prefix}  ✗ no token`;
  });
}

/** True when every env resolved to a working identity — the preflight's exit code. */
export function allEnvsAuthenticated(statuses: EnvAuthStatus[]): boolean {
  return statuses.every((status) => status.identity !== undefined);
}
