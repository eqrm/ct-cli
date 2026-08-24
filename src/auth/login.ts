/**
 * Interactive bootstrap of a ChurchTools **personal login token** (#138).
 *
 * Copying a token out of the ChurchTools web UI is the first thing a new user
 * has to do and the first thing they get wrong. ChurchTools can hand the token
 * out over the API instead: log in with username + password, complete TOTP when
 * the instance asks for it, then read the persistent token for the person who
 * just authenticated.
 *
 * ```text
 * How do you want to authenticate?
 *   1. Username and password
 *   2. Existing login token
 *   3. Skip login
 * ```
 *
 * Security properties this module is responsible for — all of them tested:
 *
 * - The username, password and TOTP code exist only as locals for the duration
 *   of the two requests that consume them. Nothing but `{host, token}` is ever
 *   handed to the credential store, and there is deliberately **no password
 *   flag**: a password on the command line lands in shell history and in `ps`.
 * - No secret is ever printed. Every message derived from a ChurchTools response
 *   passes through {@link redactSecrets}, and request bodies are never echoed
 *   into an error — an authentication failure reports the HTTP status and CT's
 *   own (redacted) message, never what was sent.
 * - Password / TOTP / token prompts do not echo (see `askHidden`).
 * - On a platform with no credential store, the flow refuses up front rather
 *   than collecting a password it could only discard (`isSecureStorageAvailable`).
 *
 * The session cookie is handled locally rather than through `CtClient`: the
 * login → TOTP pair must ride ONE session, and `CtClient`'s handshake is built
 * around the login token that this module exists to obtain. Verification of the
 * resulting token goes back through `CtClient.authenticate` unchanged.
 */
import { fetchWithRetry } from "../api/http.js";
import { askHidden, askVisible } from "../ui/prompt.js";
import { isSecureStorageAvailable } from "./tokenStore.js";

/** Prompt surface, injectable so the whole flow is testable without a terminal. */
export interface LoginPrompts {
  /** Ask for a non-secret value (username, choice, host). Echoes. */
  ask: (question: string) => Promise<string>;
  /** Ask for a secret (password, TOTP code, token). Must NOT echo. */
  askSecret: (question: string) => Promise<string>;
  /** Informational line for the user. Never called with a secret. */
  notify: (message: string) => void;
}

export interface BootstrapDeps {
  prompts?: Partial<LoginPrompts>;
  /** Defaults to `process.stdin.isTTY`. A non-TTY never prompts. */
  isTTY?: boolean;
  /** Defaults to {@link isSecureStorageAvailable}. */
  secureStorage?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * What the interactive flow produced.
 *
 * - `token` — a personal login token, from either the password flow or the
 *   user's clipboard. The caller verifies and stores it.
 * - `skipped` — the user chose not to log in (or there is no terminal to ask
 *   on). `hint` is the command to run later.
 * - `unsupported` — this platform has no credential store, so nothing was
 *   collected. `hint` is the environment-variable guidance.
 */
export type BootstrapOutcome =
  | { kind: "token"; token: string }
  | { kind: "skipped"; hint: string }
  | { kind: "unsupported"; hint: string };

/** The command a user runs to authenticate later, once they have a token. */
export function loginHint(host?: string): string {
  return `ct auth login${host ? ` --host ${host}` : " --host <url>"} --token <personal-login-token>`;
}

/** The guidance for platforms without a credential store — unchanged from the README. */
export function envVarHint(host?: string): string {
  return `export CT_HOST=${host ?? "<url>"} and export CT_LOGINTOKEN=<personal-login-token>`;
}

/**
 * Remove every known secret from a string before it is shown to anyone.
 *
 * The belt to the braces of "never build a message out of a secret in the first
 * place": ChurchTools' own error messages are surfaced so a wrong password says
 * so, and this guarantees that even a server that echoed the credential back
 * cannot make it reach the terminal. Empty/short values are ignored so a
 * one-character password does not shred the message.
 */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 2) {
      continue;
    }
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

/** An authentication failure. Carries a status, never a request body. */
export class LoginError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

function defaultPrompts(): LoginPrompts {
  return {
    ask: askVisible,
    askSecret: askHidden,
    notify: (message: string) => process.stderr.write(`${message}\n`),
  };
}

/** Merge the `Set-Cookie`s of one response into a `Cookie` header value. */
function mergeCookies(current: string, res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) {
    return current;
  }
  const jar = new Map<string, string>(
    current
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        return [pair.slice(0, eq), pair.slice(eq + 1)] as [string, string];
      }),
  );
  for (const raw of setCookies) {
    const first = raw.split(";", 1)[0] ?? "";
    const eq = first.indexOf("=");
    if (eq > 0) {
      jar.set(first.slice(0, eq), first.slice(eq + 1));
    }
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const text = await res.text();
    const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * ChurchTools is inconsistent about its envelope: `status` and `personId` turn
 * up at the top level on some releases and inside `data` on others. Look in
 * both rather than pinning one shape.
 */
function pick(body: Record<string, unknown>, key: string): unknown {
  if (body[key] !== undefined) {
    return body[key];
  }
  const data = body.data;
  if (typeof data === "object" && data !== null) {
    return (data as Record<string, unknown>)[key];
  }
  return undefined;
}

function messageOf(body: Record<string, unknown>): string | undefined {
  for (const key of ["translatedMessage", "message"]) {
    const value = pick(body, key);
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function personIdOf(body: Record<string, unknown>): number | undefined {
  const value = pick(body, "personId");
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

/** Fail with CT's own explanation when there is one — redacted, never with the body we sent. */
function fail(
  what: string,
  res: Response,
  body: Record<string, unknown>,
  secrets: (string | undefined)[],
): never {
  const detail = messageOf(body);
  const message = detail ? `${what}: ${redactSecrets(detail, secrets)}` : what;
  throw new LoginError(`${message} (HTTP ${res.status})`, res.status);
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    },
    // A login POST is not idempotent, so 5xx is not retried; a 429 still is.
    { isIdempotent: false, fetchImpl },
  );
}

/**
 * The password → (TOTP) → token exchange.
 *
 * `POST /api/login`, then — when the instance answers `status: "totp"` —
 * `POST /api/login/totp` on the SAME session cookie, then
 * `GET /api/persons/{personId}/logintoken` for the persistent token.
 *
 * Fetching the login token of the person who just authenticated is
 * authentication, not people management: it reads nothing about anyone else and
 * writes nothing at all.
 *
 * The password and code are parameters, never fields — they go out of scope
 * with this call.
 */
export async function loginWithPassword(
  host: string,
  username: string,
  password: string,
  opts: { fetchImpl?: typeof fetch; askTotp?: () => Promise<string> } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const secrets: (string | undefined)[] = [password];
  let cookie = "";

  const loginRes = await postJson(fetchImpl, `${host}/api/login`, cookie, { username, password });
  cookie = mergeCookies(cookie, loginRes);
  const loginBody = await readJson(loginRes);
  if (!loginRes.ok) {
    fail("Login failed", loginRes, loginBody, secrets);
  }

  const status = pick(loginBody, "status");
  let personId = personIdOf(loginBody);

  if (status === "totp") {
    if (personId === undefined) {
      throw new LoginError("ChurchTools asked for a 2FA code but returned no personId.", loginRes.status);
    }
    if (!opts.askTotp) {
      throw new LoginError(
        "This account requires a 2FA code, which needs an interactive terminal.",
        loginRes.status,
      );
    }
    const code = (await opts.askTotp()).trim();
    secrets.push(code);
    if (!/^\d{6}$/.test(code)) {
      throw new LoginError("The 2FA code must be six digits.", 0);
    }
    const totpRes = await postJson(fetchImpl, `${host}/api/login/totp`, cookie, { code, personId });
    cookie = mergeCookies(cookie, totpRes);
    const totpBody = await readJson(totpRes);
    if (!totpRes.ok) {
      fail("2FA verification failed", totpRes, totpBody, secrets);
    }
    personId = personIdOf(totpBody) ?? personId;
  }

  if (personId === undefined) {
    throw new LoginError("ChurchTools accepted the login but returned no personId.", loginRes.status);
  }

  const tokenRes = await fetchWithRetry(
    `${host}/api/persons/${personId}/logintoken`,
    { headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) } },
    { isIdempotent: true, fetchImpl },
  );
  const tokenBody = await readJson(tokenRes);
  if (!tokenRes.ok) {
    fail("Could not read the personal login token", tokenRes, tokenBody, secrets);
  }
  const raw = tokenBody.data ?? tokenBody;
  const token =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>).token
        : undefined;
  if (typeof token !== "string" || token.trim() === "") {
    throw new LoginError("ChurchTools returned no login token for this account.", tokenRes.status);
  }
  return token.trim();
}

/**
 * The interactive flow, factored out of `ct auth login` so `ct init` (#131) can
 * run the very same prompts in its own sequence — call it with the host the
 * user just chose and store the returned token through `storeCredentials`.
 *
 * Never prompts on a non-TTY, and never collects anything on a platform without
 * a credential store.
 */
export async function bootstrapLoginToken(host: string, deps: BootstrapDeps = {}): Promise<BootstrapOutcome> {
  const prompts: LoginPrompts = { ...defaultPrompts(), ...deps.prompts };
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const secureStorage = deps.secureStorage ?? isSecureStorageAvailable();
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!secureStorage) {
    // No store to put a token in, so nothing is asked for. Collecting a password
    // here would mean handling a secret only to throw it away (#138).
    return {
      kind: "unsupported",
      hint: envVarHint(host),
    };
  }
  if (!isTTY) {
    return { kind: "skipped", hint: loginHint(host) };
  }

  prompts.notify("How do you want to authenticate?");
  prompts.notify("  1. Username and password");
  prompts.notify("  2. Existing login token");
  prompts.notify("  3. Skip login");
  const choice = (await prompts.ask("Choice [1]: ")).trim() || "1";

  switch (choice) {
    case "1": {
      const username = (await prompts.ask("Username or email: ")).trim();
      if (!username) {
        throw new LoginError("No username given.", 0);
      }
      // `password` is a local: it dies with this block, and is never stored,
      // logged, or passed anywhere but the login request.
      const password = await prompts.askSecret("Password (not shown): ");
      if (!password) {
        throw new LoginError("No password given.", 0);
      }
      const token = await loginWithPassword(host, username, password, {
        fetchImpl,
        askTotp: () => prompts.askSecret("Six-digit 2FA code (not shown): "),
      });
      return { kind: "token", token };
    }
    case "2": {
      const token = (await prompts.askSecret("Personal login token (not shown): ")).trim();
      if (!token) {
        throw new LoginError("No token given.", 0);
      }
      return { kind: "token", token };
    }
    case "3":
      return { kind: "skipped", hint: loginHint(host) };
    default:
      throw new LoginError(`Unknown choice "${choice}" — pick 1, 2 or 3.`, 0);
  }
}
