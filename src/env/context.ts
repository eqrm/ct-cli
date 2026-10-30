/**
 * Command-level wiring for `--env` (#22). Bridges an environment profile to the
 * existing single-host resolution: rather than thread a host/token/state triple
 * through every command and helper, `prepareEnv` resolves the named profile and
 * writes its host (and, for CI, token) into `process.env` so the unchanged
 * `resolveConfig` / `authedSession` / `resolveStatePath` pick them up. This keeps
 * the `--env`-less path byte-identical: with no `--env`, nothing is mutated and
 * the default state path is returned.
 *
 * Token resolution order for a chosen env stays: `CT_LOGINTOKEN` env (CI) →
 * host-keyed Keychain entry. A profile `tokenEnv` names the env var CI populated;
 * when set and present we copy it into `CT_LOGINTOKEN` so the standard order holds.
 */
import { resolveStatePath } from "../state/state.js";
import { loadEnvProfile, resolveEnvsPath, setGatewayFlag, type EnvProfile } from "./envs.js";

export interface CommandEnv {
  /** The selected env name, or null when no `--env` was passed (single-host default). */
  name: string | null;
  /** Whether the selected env is protected (apply/destroy require typed confirmation). */
  protected: boolean;
  /** The resolved state-file path (per-env under `--env`, else the single-host default). */
  statePath: string;
}

interface EnvOpts {
  env?: string;
  state?: string;
}

/**
 * Resolve the profile for `opts.env` (if any) and wire its host + token into
 * `env` so downstream host/token resolution targets that instance. Returns the
 * resolved profile, or null when no `--env` was requested.
 */
async function wireEnv(opts: EnvOpts, env: NodeJS.ProcessEnv): Promise<EnvProfile | null> {
  if (!opts.env) {
    return null;
  }
  const profile = await loadEnvProfile(opts.env, resolveEnvsPath(undefined, env));
  // The profile is the source of truth for this env's host — it overrides any ambient CT_HOST.
  env.CT_HOST = profile.host;
  setGatewayFlag(env, profile);
  if (profile.tokenEnv) {
    const token = env[profile.tokenEnv]?.trim();
    if (token) {
      env.CT_LOGINTOKEN = token;
    }
  }
  return profile;
}

/**
 * Prepare a state-touching command's environment. Call this FIRST — before
 * `resolveConfig` / `authedSession` — so the wired host/token take effect.
 */
export async function prepareEnv(opts: EnvOpts, env: NodeJS.ProcessEnv = process.env): Promise<CommandEnv> {
  const profile = await wireEnv(opts, env);
  const statePath = resolveStatePath(opts.state, env, profile?.statePath);
  return { name: profile?.name ?? null, protected: profile?.protected ?? false, statePath };
}

/**
 * Host-only variant for read-only, non-state commands (`ct get`). Wires the
 * env's host + token into `env`; returns nothing. A no-op without `--env`.
 */
export async function prepareEnvHost(
  opts: { env?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await wireEnv(opts, env);
}
