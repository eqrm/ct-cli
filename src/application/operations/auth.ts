import { resolve } from "node:path";
import { authedSession, type AuthedSession } from "../../api/session.js";
import { CtClient, type WhoAmI } from "../../api/ctClient.js";
import { formatError } from "../../api/format.js";
import { meetsMinVersion, MIN_CT_VERSION, type CtInfo } from "../../api/version.js";
import { checkAllEnvAuth, type EnvAuthStatus } from "../../auth/status.js";
import { keychainSessionCache, SESSION_MAX_AGE_MS } from "../../auth/sessionStore.js";
import {
  clearCredentials,
  readToken,
  storeCredentials,
  type ClearCredentialsResult,
} from "../../auth/tokenStore.js";
import { MissingHostError, normalizeHost } from "../../config.js";
import { loadEnvProfile, loadEnvProfiles, resolveEnvsPath } from "../../env/envs.js";
import { CtApplicationError } from "../errors.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface AuthStatusRequest {
  cwd?: string;
  environment?: string;
  all?: boolean;
}

export interface AuthStatusResult {
  operation: "auth";
  scope: "single" | "all";
  environment: string | null;
  host: string | null;
  identity: WhoAmI | null;
  environments: EnvAuthStatus[];
  authenticated: boolean;
  environmentsPath: string;
}

export interface AuthStatusDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  readToken?: typeof readToken;
  authedSession?: () => Promise<AuthedSession>;
  loadEnvProfiles?: typeof loadEnvProfiles;
  checkAllEnvAuth?: typeof checkAllEnvAuth;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
}

export interface AuthLoginRequest {
  host: string;
  token: string;
}

export interface AuthLoginResult {
  operation: "auth";
  action: "login";
  host: string;
  identity: WhoAmI;
  storage: string;
  churchToolsVersion: string | null;
  /** Set when the version could not be read; the credentials are stored either way. */
  versionCheckError: string | null;
  minimumVersion: string;
  supportedVersion: boolean | null;
}

export interface AuthLoginDependencies {
  createClient?: (host: string) => Pick<CtClient, "authenticate" | "get">;
  storeCredentials?: typeof storeCredentials;
}

/** Verify and persist a personal token without returning the secret to either adapter. */
export async function runAuthLogin(
  request: AuthLoginRequest,
  dependencies: AuthLoginDependencies = {},
): Promise<AuthLoginResult> {
  const host = normalizeHost(request.host.trim());
  const token = request.token.trim();
  if (!token) throw new Error("No token provided.");
  const client = (
    dependencies.createClient ??
    ((resolvedHost) => new CtClient({ host: resolvedHost }, { sessionCache: keychainSessionCache() }))
  )(host);
  const identity = await client.authenticate(token, { fresh: true });
  const storage = await (dependencies.storeCredentials ?? storeCredentials)({ host, token });
  // The token is verified and stored by this point, so the login HAS succeeded. A failing /info
  // is a version check that could not run, not a failed login — throwing here reported pure
  // failure to a user whose credentials were already in the keychain (#156 review).
  let churchToolsVersion: string | null = null;
  let versionCheckError: string | null = null;
  try {
    const info = await client.get<CtInfo>("/info");
    churchToolsVersion = info.version ?? null;
  } catch (caught) {
    versionCheckError = formatError(caught);
  }
  return {
    operation: "auth",
    action: "login",
    host,
    identity,
    storage,
    churchToolsVersion,
    versionCheckError,
    minimumVersion: MIN_CT_VERSION,
    supportedVersion: churchToolsVersion ? meetsMinVersion(churchToolsVersion) : null,
  };
}

export interface AuthLogoutRequest {
  cwd?: string;
  environment?: string;
}

export interface AuthLogoutResult {
  operation: "auth";
  action: "logout";
  environment: string | null;
  host: string | null;
  clearedDefault: boolean;
}

export interface AuthLogoutDependencies {
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  loadEnvProfile?: typeof loadEnvProfile;
  clearCredentials?: (host?: string) => Promise<ClearCredentialsResult>;
}

/** Remove credentials for the default login or exactly one environment-bound host. */
export async function runAuthLogout(
  request: AuthLogoutRequest = {},
  dependencies: AuthLogoutDependencies = {},
): Promise<AuthLogoutResult> {
  const clear = dependencies.clearCredentials ?? clearCredentials;
  if (!request.environment) {
    const { clearedDefault } = await clear();
    return { operation: "auth", action: "logout", environment: null, host: null, clearedDefault };
  }
  const cwd = resolve(dependencies.cwd?.() ?? process.cwd(), request.cwd ?? ".");
  const environmentsPath = resolve(cwd, resolveEnvsPath(undefined, dependencies.env ?? process.env));
  const profile = await (dependencies.loadEnvProfile ?? loadEnvProfile)(
    request.environment,
    environmentsPath,
  );
  const { clearedDefault } = await clear(profile.host);
  return {
    operation: "auth",
    action: "logout",
    environment: profile.name,
    host: profile.host,
    clearedDefault,
  };
}

export interface AuthTokenRequest {
  cwd?: string;
  environment?: string;
}

/**
 * A ChurchTools SESSION, for handing to another tool (#179).
 *
 * Deliberately not the login token. The OpenTofu provider declares `token` as required, so the
 * tier-0 cutover meant writing a personal ChurchTools login token to local disk — a permanent,
 * full-privilege credential (an admin one on prod) that ChurchTools offers no way to scope or
 * rotate. The session bought with it is the one short-lived credential in the system: it expires,
 * `ct auth logout` drops it, and a copy that leaks into a `tofu` debug log or a CI artifact is dead
 * within hours rather than forever. So that is what `ct auth token` emits, and the token itself never
 * leaves the Keychain.
 */
export interface AuthTokenResult {
  operation: "auth";
  action: "token";
  environment: string | null;
  host: string;
  cookie: string;
  csrfToken: string;
  /**
   * When `ct` will stop reusing this session (its `obtainedAt` + the 12h reuse ceiling in
   * sessionStore). A CEILING, not a promise: ChurchTools does not advertise its session lifetime, so
   * the server may end the session sooner. A consumer should treat a 401 as "ask again", not as an
   * error — which is also why this command is cheap to call on every run.
   */
  expiresAt: string;
  /** `cache` — reused an existing session; `handshake` — one login handshake was spent to buy it. */
  source: "cache" | "handshake";
}

export interface AuthTokenDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  readToken?: typeof readToken;
  authedSession?: () => Promise<AuthedSession>;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
}

/**
 * Resolve host + session for one environment, buying a session only if there is no reusable one.
 *
 * Returns the credential; it never prints, logs or formats it — every caller decides where the value
 * is allowed to go (the CLI adapter puts it on stdout alone, and refuses a terminal).
 */
export async function runAuthToken(
  request: AuthTokenRequest = {},
  dependencies: AuthTokenDependencies = {},
): Promise<AuthTokenResult> {
  const env = dependencies.env ?? process.env;
  const cwd = resolve(dependencies.cwd?.() ?? process.cwd(), request.cwd ?? ".");
  let project;
  try {
    project = await (dependencies.resolveProject ?? resolveProject)(
      { cwd, environment: request.environment },
      { ...dependencies.project, env },
    );
  } catch (cause) {
    if (!(cause instanceof MissingHostError)) throw cause;
    throw new CtApplicationError(
      "AUTH_REQUIRED",
      "No host resolved. Pass --env <name>, or run `ct auth login --host <url> --token <token>`.",
      { cause },
    );
  }
  // Checked before the network: "no credential for this host" is the case a credential helper hits
  // most often, and it must fail with the remedy rather than with a login error.
  if (!(await (dependencies.readToken ?? readToken)(project.host))) {
    throw new CtApplicationError(
      "AUTH_REQUIRED",
      request.environment
        ? `No token for ${project.host}. Run \`ct auth login --env ${request.environment}\`.`
        : `No token for ${project.host}. Run \`ct auth login --host ${project.host} --token <token>\`.`,
      { details: { host: project.host } },
    );
  }
  const { client } = await (dependencies.authedSession ?? authedSession)();
  const session = client.sessionCredential();
  if (!session) {
    throw new CtApplicationError(
      "AUTH_REQUIRED",
      `Authenticated against ${project.host} but no session cookie was captured, so there is nothing ` +
        `to hand over. Re-run \`ct auth login\` for this host.`,
      { details: { host: project.host } },
    );
  }
  return {
    operation: "auth",
    action: "token",
    environment: project.environment,
    host: project.host,
    cookie: session.cookie,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.obtainedAt + SESSION_MAX_AGE_MS).toISOString(),
    source: session.source,
  };
}

/** Return authentication identity and source metadata without ever returning a token. */
export async function runAuthStatus(
  request: AuthStatusRequest = {},
  dependencies: AuthStatusDependencies = {},
): Promise<AuthStatusResult> {
  if (request.all && request.environment) {
    throw new Error("--all reports every environment; drop --env (or drop --all to check just one).");
  }
  const env = dependencies.env ?? process.env;
  const cwd = resolve(dependencies.cwd?.() ?? process.cwd(), request.cwd ?? ".");
  const environmentsPath = resolve(cwd, resolveEnvsPath(undefined, env));
  if (request.all) {
    const profiles = await (dependencies.loadEnvProfiles ?? loadEnvProfiles)(environmentsPath);
    const environments = await (dependencies.checkAllEnvAuth ?? checkAllEnvAuth)(profiles, { env });
    return {
      operation: "auth",
      scope: "all",
      environment: null,
      host: null,
      identity: null,
      environments,
      authenticated: environments.length > 0 && environments.every((status) => status.identity !== undefined),
      environmentsPath,
    };
  }

  let project;
  try {
    project = await (dependencies.resolveProject ?? resolveProject)(
      { cwd, environment: request.environment },
      { ...dependencies.project, env },
    );
  } catch (cause) {
    // ONLY an unresolvable host means "not logged in". A typo'd `--env`, a missing ct.envs.json
    // or a malformed one must report itself — rewriting those sent a user who IS logged in to
    // `ct auth login` (#156 review).
    if (!(cause instanceof MissingHostError)) throw cause;
    throw new CtApplicationError(
      "AUTH_REQUIRED",
      "Not logged in. Run `ct auth login --host <url> --token <token>`.",
      { cause },
    );
  }
  if (!(await (dependencies.readToken ?? readToken)(project.host))) {
    throw new CtApplicationError(
      "AUTH_REQUIRED",
      `No token for ${project.host}. Run \`ct auth login --host ${project.host} --token <token>\`.`,
      { details: { host: project.host } },
    );
  }
  const { me } = await (dependencies.authedSession ?? authedSession)();
  return {
    operation: "auth",
    scope: "single",
    environment: project.environment,
    host: project.host,
    identity: me,
    environments: [],
    authenticated: true,
    environmentsPath,
  };
}
