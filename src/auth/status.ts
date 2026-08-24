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
 * way: a profile `tokenEnv` (CI) → `CT_LOGINTOKEN` *for the host that token is
 * bound to* → the host-keyed Keychain entry. Nothing here writes anything; the
 * only network call is the `whoami` handshake plus the same minimum-version
 * check `authedSession` runs, and only for an env that actually has a token.
 */
import { CtClient, type WhoAmI } from "../api/ctClient.js";
import { normalizeHost } from "../config.js";
import { readCredentials, readStoredHost, type Credentials } from "./tokenStore.js";
import type { EnvProfile } from "../env/envs.js";
import { formatError } from "../ui.js";

/** Where an env's token came from — `null` when there is none to try. */
export type TokenSource = { kind: "env"; variable: string } | { kind: "stored" } | { kind: "none" };

export interface EnvAuthStatus {
  name: string;
  host: string;
  source: TokenSource;
  /** Who the token authenticates as. Absent when there is no token, or the check failed. */
  identity?: WhoAmI;
  /** Why the check failed (expired token, wrong host, instance unreachable, too-old instance). */
  error?: string;
}

export interface StatusDeps {
  env?: NodeJS.ProcessEnv;
  readStored?: (host: string) => Promise<Credentials | null>;
  /** The host the *default* (unqualified) login points at — see {@link ambientTokenHost}. */
  readDefaultHost?: () => Promise<string | null>;
  whoami?: (host: string, token: string) => Promise<WhoAmI>;
}

/**
 * The handshake, plus the very check that would refuse the next `apply`.
 *
 * `authedSession` follows `authenticate` with `assertMinVersion`, so without it
 * a green preflight line could still be followed by `ct apply --env <name>`
 * refusing to run — exactly the failure a preflight exists to catch.
 */
async function defaultWhoami(host: string, token: string): Promise<WhoAmI> {
  const client = new CtClient({ host });
  const me = await client.authenticate(token);
  await client.assertMinVersion();
  return me;
}

/**
 * The host an ambient `CT_LOGINTOKEN` belongs to — `null` when it belongs to
 * nothing in particular.
 *
 * A login token is bound to the instance it was issued by (issue #30), and
 * `--all` walks *every* host in `ct.envs.json`. Handing the ambient token to all
 * of them would post one instance's secret to every other one — as a
 * `login_token=` URL query parameter, straight into their access logs — and then
 * report `✓ … via $CT_LOGINTOKEN` for envs nothing was ever configured for.
 * `authedSession` gets away with the same fallback only because `--env` is the
 * operator naming one host explicitly.
 *
 * So the ambient token is offered to exactly the host it pairs with: `CT_HOST`
 * when set (the CI shape), else the stored default login's host.
 */
async function ambientTokenHost(
  env: NodeJS.ProcessEnv,
  readDefaultHost: () => Promise<string | null>,
): Promise<string | null> {
  const fromEnv = env.CT_HOST?.trim();
  if (fromEnv) {
    return normalizeHost(fromEnv);
  }
  return await readDefaultHost();
}

/** Resolve the token an `--env <name>` command would use, without disclosing it. */
async function resolveToken(
  profile: EnvProfile,
  env: NodeJS.ProcessEnv,
  readStored: (host: string) => Promise<Credentials | null>,
  readDefaultHost: () => Promise<string | null>,
): Promise<{ token: string; source: TokenSource } | { token: null; source: TokenSource }> {
  if (profile.tokenEnv) {
    const fromProfileVar = env[profile.tokenEnv]?.trim();
    if (fromProfileVar) {
      return { token: fromProfileVar, source: { kind: "env", variable: profile.tokenEnv } };
    }
  }
  const ambient = env.CT_LOGINTOKEN?.trim();
  if (ambient && (await ambientTokenHost(env, readDefaultHost)) === profile.host) {
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
  const readDefaultHost = deps.readDefaultHost ?? readStoredHost;
  const whoami = deps.whoami ?? defaultWhoami;

  // Resolution happens INSIDE the try: it touches the credential store, and a
  // store that throws must not abort the whole `--all` sweep.
  let source: TokenSource = { kind: "none" };
  try {
    const resolved = await resolveToken(profile, env, readStored, readDefaultHost);
    source = resolved.source;
    if (resolved.token === null) {
      return { name: profile.name, host: profile.host, source };
    }
    const identity = await whoami(profile.host, resolved.token);
    return { name: profile.name, host: profile.host, source, identity };
  } catch (err) {
    // formatError, not err.message: `authenticate` throws CtApiError("Login failed
    // (whoami)", status) — the status lives on the error, not in its message, and
    // "expired token" vs "not your instance" vs "instance down" is the whole point.
    return { name: profile.name, host: profile.host, source, error: formatError(err) };
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
      // A multi-line body (formatError appends the response body) would break the
      // one-line-per-env alignment; the first line carries status + message.
      const [first = ""] = status.error.split("\n");
      return `${prefix}  ✗ ${first} ${describeSource(status.source)}`.trimEnd();
    }
    return `${prefix}  ✗ no token`;
  });
}

/** True when every env resolved to a working identity — the preflight's exit code. */
export function allEnvsAuthenticated(statuses: EnvAuthStatus[]): boolean {
  return statuses.every((status) => status.identity !== undefined);
}
