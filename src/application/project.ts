import { resolve } from "node:path";
import { resolveConfig } from "../config.js";
import { resolveConfigPath } from "../config/load.js";
import { loadEnvProfile, resolveEnvsPath, setGatewayFlag, type EnvProfile } from "../env/envs.js";
import { resolveStatePath } from "../state/state.js";
import type { ProjectRequest, ResolvedProjectInfo } from "./contracts.js";

export interface ProjectResolutionDependencies {
  /** Runtime variables to resolve and wire. Defaults to process.env for CLI compatibility. */
  env?: NodeJS.ProcessEnv;
  /** Base cwd provider, injectable so tests and a future server never need process.chdir(). */
  cwd?: () => string;
  /** Stored-login host reader; the production default remains the existing keychain lookup. */
  readStoredHost?: () => Promise<string | null>;
}

function absoluteFrom(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function wireProfile(profile: EnvProfile, env: NodeJS.ProcessEnv): void {
  // A selected profile is authoritative and deliberately overrides ambient CT_HOST.
  env.CT_HOST = profile.host;
  setGatewayFlag(env, profile);
  if (profile.tokenEnv) {
    const token = env[profile.tokenEnv]?.trim();
    if (token) env.CT_LOGINTOKEN = token;
  }
}

/**
 * Resolve the common, non-secret project context for every application operation.
 *
 * Precedence remains identical to the CLI: explicit request → environment variable → default;
 * a selected environment supplies the authoritative host and state fallback, while CT_STATE may
 * still override that fallback. Relative paths are anchored to request.cwd instead of whichever
 * directory an HTTP server happens to use.
 */
export async function resolveProject(
  request: ProjectRequest = {},
  dependencies: ProjectResolutionDependencies = {},
): Promise<ResolvedProjectInfo> {
  const env = dependencies.env ?? process.env;
  const baseCwd = dependencies.cwd?.() ?? process.cwd();
  const cwd = resolve(baseCwd, request.cwd ?? ".");
  const environmentsPath = absoluteFrom(cwd, resolveEnvsPath(undefined, env));

  const profile = request.environment ? await loadEnvProfile(request.environment, environmentsPath) : null;
  if (profile) wireProfile(profile, env);

  const configDisplayPath = resolveConfigPath(request.configPath, env);
  const stateDisplayPath = resolveStatePath(request.statePath, env, profile?.statePath);
  const configPath = absoluteFrom(cwd, configDisplayPath);
  const statePath = absoluteFrom(cwd, stateDisplayPath);
  const { host } = await resolveConfig(env, dependencies.readStoredHost);

  return {
    cwd,
    configPath,
    statePath,
    environmentsPath,
    configDisplayPath,
    stateDisplayPath,
    environment: profile?.name ?? null,
    protected: profile?.protected ?? false,
    host,
  };
}
