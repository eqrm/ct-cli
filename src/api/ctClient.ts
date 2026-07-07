/**
 * Layer 0 + Layer 1: authenticated ChurchTools API access.
 *
 * ChurchTools' personal login token authenticates via a session handshake, NOT
 * an `Authorization` header (which yields a null CSRF token for this token
 * class and breaks writes). The proven flow for this instance is:
 *
 *   1. GET /api/whoami?login_token=<token>  → sets the session cookie
 *   2. GET /api/csrftoken                   → returns the CSRF token
 *   3. every request sends the cookie; every write sends `CSRF-Token: <token>`
 *
 * Phase 0 (#2) confirms this handshake against a live token. Once the typed
 * client is generated (`npm run generate:client`), the hand-written `request`
 * here can be swapped for `openapi-fetch` while keeping this class's surface.
 */
import { resolveConfig, type CtConfig } from "../config.js";
import { fetchWithRetry } from "./http.js";

export interface WhoAmI {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export class CtApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CtApiError";
  }
}

type Json = Record<string, unknown>;

export class CtClient {
  private cookie: string | null = null;
  private csrfToken: string | null = null;

  constructor(private readonly config: CtConfig = resolveConfig()) {}

  get host(): string {
    return this.config.host;
  }

  /** Run the login-token handshake and cache the session cookie + CSRF token. */
  async authenticate(loginToken: string): Promise<WhoAmI> {
    const url = `${this.config.host}/api/whoami?login_token=${encodeURIComponent(loginToken)}`;
    const res = await fetchWithRetry(
      url,
      { headers: { Accept: "application/json" } },
      { isIdempotent: true },
    );
    this.captureCookie(res);
    if (!res.ok) {
      throw new CtApiError(`Login failed (whoami)`, res.status, await safeBody(res));
    }
    if (!this.cookie) {
      throw new CtApiError("Login succeeded but no session cookie was returned", res.status, null);
    }
    await this.refreshCsrfToken();
    const body = (await res.json()) as { data: WhoAmI };
    return body.data;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async request<T = unknown>(method: string, path: string, body?: Json): Promise<T> {
    if (!this.cookie) {
      throw new CtApiError("Not authenticated — run `ct auth login` first", 401, null);
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Cookie: this.cookie,
    };
    if (method !== "GET" && method !== "HEAD") {
      if (!this.csrfToken) {
        await this.refreshCsrfToken();
      }
      headers["CSRF-Token"] = this.csrfToken ?? "";
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchWithRetry(
      `${this.config.host}/api${path}`,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { isIdempotent: method === "GET" || method === "HEAD" },
    );
    this.captureCookie(res);
    if (!res.ok) {
      throw new CtApiError(`${method} ${path} failed`, res.status, await safeBody(res));
    }
    if (res.status === 204) {
      return undefined as T;
    }
    const parsed = (await res.json()) as { data?: T };
    return (parsed.data ?? parsed) as T;
  }

  private async refreshCsrfToken(): Promise<void> {
    if (!this.cookie) {
      return;
    }
    const res = await fetchWithRetry(
      `${this.config.host}/api/csrftoken`,
      { headers: { Accept: "application/json", Cookie: this.cookie } },
      { isIdempotent: true },
    );
    this.captureCookie(res);
    if (!res.ok) {
      throw new CtApiError("Failed to fetch CSRF token", res.status, await safeBody(res));
    }
    const body = (await res.json()) as { data: string };
    this.csrfToken = body.data;
  }

  /** Merge any Set-Cookie values into the stored cookie header. */
  private captureCookie(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) {
      return;
    }
    const jar = new Map<string, string>(
      (this.cookie ?? "")
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
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
