import { resolve } from "node:path";
import { loadEnvProfiles, resolveEnvsPath, type EnvProfile } from "../../env/envs.js";

export interface ListEnvironmentsRequest {
  cwd?: string;
}

export interface ListEnvironmentsResult {
  operation: "environment";
  environmentsPath: string;
  environments: EnvProfile[];
}

export interface ListEnvironmentsDependencies {
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  load?: typeof loadEnvProfiles;
}

/** Return non-secret environment profiles for adapter selection and discovery. */
export async function listEnvironments(
  request: ListEnvironmentsRequest = {},
  dependencies: ListEnvironmentsDependencies = {},
): Promise<ListEnvironmentsResult> {
  const cwd = resolve(dependencies.cwd?.() ?? process.cwd(), request.cwd ?? ".");
  const environmentsPath = resolve(cwd, resolveEnvsPath(undefined, dependencies.env ?? process.env));
  const environments = await (dependencies.load ?? loadEnvProfiles)(environmentsPath);
  return { operation: "environment", environmentsPath, environments };
}
