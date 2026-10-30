/**
 * Environment profiles (#22): named `(host, token reference, state file path)`
 * triples that let one config repo drive several ChurchTools instances
 * (Terraform-workspace-style — e.g. an `eqrm-dev` rehearsal env and a `prod`
 * env), selected per command with `--env <name>`.
 *
 * The profiles live in a small committed `ct.envs.json` in the config repo
 * directory (default `ct.envs.json` in the cwd; override with `CT_ENVS`):
 *
 * ```json
 * {
 *   "environments": {
 *     "dev":  { "host": "https://mychurch-dev.church.tools" },
 *     "prod": { "host": "https://mychurch.church.tools", "protected": true, "tokenEnv": "CT_PROD_TOKEN" }
 *   }
 * }
 * ```
 *
 * A profile carries only NON-secret references: `tokenEnv` names an environment
 * variable that holds the login token (for CI) — never a literal secret, so the
 * file is safe to commit. The state file defaults to the `ct-state.<env>.json`
 * convention and may be overridden per profile with `state`.
 *
 * NOTHING here reads the Keychain or the network — it is pure file loading +
 * validation, so it is unit-testable without a live instance.
 */
import { readFile } from "node:fs/promises";
import { normalizeHost } from "../config.js";
import { resolveWithEnv } from "../util/resolve.js";

export const DEFAULT_ENVS_PATH = "ct.envs.json";

/** A fully-resolved environment profile. `statePath` is defaulted; `host` normalized. */
export interface EnvProfile {
  name: string;
  /** Base host, normalized (no trailing slash, no `/api`). */
  host: string;
  /** State file for this env — profile override or the `ct-state.<env>.json` convention. */
  statePath: string;
  /** Name of an env var holding the login token (CI). Never a literal secret. */
  tokenEnv?: string;
  /** Protected env: apply/destroy ALWAYS require typed confirmation (even with --auto-approve/--force). */
  protected: boolean;
  /** Present for a read-only gateway env (#228): no CT credential, all traffic via the local signing proxy. */
  gateway?: GatewayConfig;
}

/**
 * A read-only AWS gateway in front of ChurchTools. `host` of the env is the LOCAL proxy
 * (`http://127.0.0.1:<port>`, started by `ct gateway proxy`); this block says where the proxy forwards to.
 */
export interface GatewayConfig {
  /** The gateway's https base URL (API Gateway, SigV4/AWS_IAM). */
  url: string;
  region: string;
  /** AWS profile (in ~/.aws/config) that assumes the reader role, with MFA. */
  profile: string;
}

/** Env var through which wiring tells `authedSession` that the selected env is a read-only gateway env. */
export const GATEWAY_FLAG = "CT_GATEWAY_ENV";

/** Record (or clear) the gateway marker for the selected profile; wiring is process.env-based by design. */
export function setGatewayFlag(env: NodeJS.ProcessEnv, profile: EnvProfile): void {
  if (profile.gateway) env[GATEWAY_FLAG] = profile.name;
  else delete env[GATEWAY_FLAG];
}

/** Local port of a gateway env's proxy, parsed from its `host`. */
export function gatewayPort(profile: EnvProfile): number {
  return Number(new URL(profile.host).port);
}

/** Path precedence for the profile file: explicit → `CT_ENVS` → `ct.envs.json`. */
export function resolveEnvsPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveWithEnv(explicit, env.CT_ENVS, DEFAULT_ENVS_PATH);
}

/** The `ct-state.<env>.json` state-file convention for a named env. */
export function defaultEnvStatePath(name: string): string {
  return `ct-state.${name}.json`;
}

type RawProfile = Record<string, unknown>;

/** Parse + shape-validate the profile file; returns the raw environments map. */
function validateEnvsFile(parsed: unknown, path: string): Record<string, RawProfile> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed environments file ${path}: expected a JSON object at the top level.`);
  }
  const envs = (parsed as Record<string, unknown>).environments;
  if (typeof envs !== "object" || envs === null || Array.isArray(envs)) {
    throw new Error(
      `Malformed environments file ${path}: expected an "environments" object mapping env name → profile.`,
    );
  }
  return envs as Record<string, RawProfile>;
}

/** Read + parse + validate the profile file. A missing file throws a friendly, actionable error. */
async function loadEnvsFile(path: string): Promise<Record<string, RawProfile>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      throw new Error(
        `Environment profile file not found: ${path} (default: ${DEFAULT_ENVS_PATH}). ` +
          `Create it with an "environments" map, or drop --env to use the single-host default.`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed environments file ${path}: not valid JSON (${(err as Error).message}).`);
  }
  return validateEnvsFile(parsed, path);
}

function parseGateway(name: string, raw: unknown, host: string): GatewayConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Environment "${name}": "gateway" must be an object {url, region, profile}.`);
  }
  const g = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const v = g[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`Environment "${name}": gateway.${key} must be a non-empty string.`);
    }
    return v.trim();
  };
  const url = str("url");
  if (!/^https:\/\//.test(url)) {
    throw new Error(`Environment "${name}": gateway.url must be an https:// URL.`);
  }
  // The proxy forwards to the URL's origin, so a base path (a REST API stage) would be dropped silently.
  if (new URL(url).pathname.replace(/\/+$/, "") !== "") {
    throw new Error(`Environment "${name}": gateway.url must not have a path (got "${url}").`);
  }
  // The proxy is the only thing that may sit behind a gateway env's host, and it binds loopback only.
  let local: URL;
  try {
    local = new URL(host);
  } catch {
    throw new Error(`Environment "${name}": host "${host}" is not a URL.`);
  }
  if (local.protocol !== "http:" || local.hostname !== "127.0.0.1" || !/^\d+$/.test(local.port)) {
    throw new Error(
      `Environment "${name}": a gateway env's host must be the local proxy, http://127.0.0.1:<port> ` +
        `(got "${host}").`,
    );
  }
  return { url: normalizeHost(url), region: str("region"), profile: str("profile") };
}

/** Resolve one named profile from an already-loaded environments map. */
function resolveProfile(name: string, raw: RawProfile): EnvProfile {
  const host = raw.host;
  if (typeof host !== "string" || host.trim() === "") {
    throw new Error(`Environment "${name}" is missing a non-empty "host".`);
  }
  if (raw.state !== undefined && typeof raw.state !== "string") {
    throw new Error(`Environment "${name}": "state" must be a string path.`);
  }
  if (raw.tokenEnv !== undefined && typeof raw.tokenEnv !== "string") {
    throw new Error(`Environment "${name}": "tokenEnv" must be the NAME of an env var (a string).`);
  }
  if (raw.protected !== undefined && typeof raw.protected !== "boolean") {
    throw new Error(`Environment "${name}": "protected" must be a boolean.`);
  }
  const gateway = parseGateway(name, raw.gateway, host.trim());
  return {
    name,
    host: normalizeHost(host.trim()),
    ...(gateway ? { gateway } : {}),
    statePath: (raw.state as string | undefined) ?? defaultEnvStatePath(name),
    tokenEnv: raw.tokenEnv as string | undefined,
    protected: raw.protected === true,
  };
}

/** Reject a non-object profile entry before {@link resolveProfile} reads fields off it. */
function assertProfileObject(name: string, raw: unknown, path: string): asserts raw is RawProfile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Environment "${name}" in ${path} must be a JSON object.`);
  }
}

/**
 * Load and resolve the profile named `name` from the profile file at `path`.
 * Throws a friendly error when the file is missing, malformed, or has no such env.
 */
export async function loadEnvProfile(name: string, path: string): Promise<EnvProfile> {
  const envs = await loadEnvsFile(path);
  const raw = envs[name];
  if (raw === undefined) {
    const known = Object.keys(envs);
    const list = known.length ? known.join(", ") : "(none defined)";
    throw new Error(`Unknown environment "${name}" in ${path}. Defined: ${list}.`);
  }
  assertProfileObject(name, raw, path);
  return resolveProfile(name, raw);
}

/**
 * Load and resolve EVERY profile in the file, in declaration order — the whole
 * set is what `ct auth status` reports on (#117). Same validation as the single
 * lookup: one malformed profile fails the read rather than being skipped
 * silently, because a preflight check that quietly omits an env is a trap.
 */
export async function loadEnvProfiles(path: string): Promise<EnvProfile[]> {
  const envs = await loadEnvsFile(path);
  return Object.entries(envs).map(([name, raw]) => {
    assertProfileObject(name, raw, path);
    return resolveProfile(name, raw);
  });
}
