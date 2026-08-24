import { describe, it, expect } from "vitest";
import {
  bootstrapLoginToken,
  loginWithPassword,
  redactSecrets,
  LoginError,
  loginHint,
  envVarHint,
  type LoginPrompts,
} from "../src/auth/login.js";
import { isSecureStorageAvailable } from "../src/auth/tokenStore.js";

// A host that cannot resolve: if a stub is ever missed, the test fails loudly
// instead of reaching a real instance.
const HOST = "https://ct-cli.invalid";
const PASSWORD = "hunter2-correct-horse";
const TOTP = "123456";
const TOKEN = "tok_abcdef0123456789";

interface Call {
  url: string;
  method: string;
  body?: string;
  cookie?: string;
}

/** A fetch stub that records every request and answers from a scripted queue. */
function stubFetch(responses: { status?: number; body?: unknown; setCookie?: string[] }[]): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : undefined,
      cookie: headers.Cookie,
    });
    const spec = responses[i++] ?? { status: 500, body: {} };
    const res = new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
    if (spec.setCookie) {
      for (const cookie of spec.setCookie) {
        res.headers.append("Set-Cookie", cookie);
      }
    }
    return res;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Prompts that answer from a script and record everything shown to the user. */
function scriptedPrompts(script: { ask?: string[]; secret?: string[] }): {
  prompts: LoginPrompts;
  shown: string[];
} {
  const shown: string[] = [];
  const asks = [...(script.ask ?? [])];
  const secrets = [...(script.secret ?? [])];
  return {
    shown,
    prompts: {
      ask: async (question) => {
        shown.push(question);
        const next = asks.shift();
        if (next === undefined) {
          throw new Error(`unexpected visible prompt: ${question}`);
        }
        return next;
      },
      askSecret: async (question) => {
        shown.push(question);
        const next = secrets.shift();
        if (next === undefined) {
          throw new Error(`unexpected secret prompt: ${question}`);
        }
        return next;
      },
      notify: (message) => shown.push(message),
    },
  };
}

const OK_LOGIN = { status: 200, body: { data: { personId: 42, status: "success" } } };
const TOTP_CHALLENGE = { status: 200, body: { data: { personId: 42, status: "totp" } } };
const TOKEN_RESPONSE = { status: 200, body: { data: TOKEN } };

describe("loginWithPassword (#138)", () => {
  it("logs in without 2FA and returns the personal login token", async () => {
    const { fetchImpl, calls } = stubFetch([
      { ...OK_LOGIN, setCookie: ["ChurchTools_ct=sess1; Path=/; HttpOnly"] },
      TOKEN_RESPONSE,
    ]);
    const token = await loginWithPassword(HOST, "ada@example.org", PASSWORD, { fetchImpl });
    expect(token).toBe(TOKEN);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${HOST}/api/login`,
      `GET ${HOST}/api/persons/42/logintoken`,
    ]);
    // The token read rides the session cookie the login handed out.
    expect(calls[1]?.cookie).toContain("ChurchTools_ct=sess1");
  });

  it("detects the TOTP challenge and completes it on the SAME session cookie", async () => {
    const { fetchImpl, calls } = stubFetch([
      { ...TOTP_CHALLENGE, setCookie: ["ChurchTools_ct=sess1; Path=/"] },
      { status: 200, body: { data: { personId: 42, status: "success" } } },
      TOKEN_RESPONSE,
    ]);
    const token = await loginWithPassword(HOST, "ada", PASSWORD, {
      fetchImpl,
      askTotp: async () => TOTP,
    });
    expect(token).toBe(TOKEN);
    expect(calls[1]?.url).toBe(`${HOST}/api/login/totp`);
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ code: TOTP, personId: 42 });
    expect(calls[1]?.cookie).toContain("ChurchTools_ct=sess1");
    expect(calls[2]?.cookie).toContain("ChurchTools_ct=sess1");
  });

  it("does not ask for a code when the instance does not challenge", async () => {
    const { fetchImpl } = stubFetch([OK_LOGIN, TOKEN_RESPONSE]);
    let asked = false;
    await loginWithPassword(HOST, "ada", PASSWORD, {
      fetchImpl,
      askTotp: async () => {
        asked = true;
        return TOTP;
      },
    });
    expect(asked).toBe(false);
  });

  it("reads a top-level envelope as well as a nested one", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { personId: 7, status: "success" } },
      { status: 200, body: { data: { token: TOKEN } } },
    ]);
    await expect(loginWithPassword(HOST, "ada", PASSWORD, { fetchImpl })).resolves.toBe(TOKEN);
  });

  it("rejects invalid credentials with CT's message and the status, and no request body", async () => {
    const { fetchImpl } = stubFetch([
      { status: 401, body: { message: "Wrong username or password", translatedMessage: "" } },
    ]);
    const err = await loginWithPassword(HOST, "ada", PASSWORD, { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).status).toBe(401);
    expect((err as LoginError).message).toContain("Wrong username or password");
    expect((err as LoginError).message).toContain("401");
    expect((err as LoginError).message).not.toContain(PASSWORD);
  });

  it("rejects an invalid TOTP code without leaking the code", async () => {
    const { fetchImpl } = stubFetch([
      { ...TOTP_CHALLENGE, setCookie: ["ct=1"] },
      { status: 403, body: { message: "Invalid code" } },
    ]);
    const err = await loginWithPassword(HOST, "ada", PASSWORD, {
      fetchImpl,
      askTotp: async () => "999999",
    }).catch((e: unknown) => e);
    expect((err as LoginError).message).toContain("2FA verification failed");
    expect((err as LoginError).message).not.toContain("999999");
    expect((err as LoginError).message).not.toContain(PASSWORD);
  });

  it("refuses a code that is not six digits before sending it anywhere", async () => {
    const { fetchImpl, calls } = stubFetch([TOTP_CHALLENGE]);
    await expect(
      loginWithPassword(HOST, "ada", PASSWORD, { fetchImpl, askTotp: async () => "12" }),
    ).rejects.toThrow(/six digits/);
    expect(calls).toHaveLength(1); // the login only — no /login/totp call
  });

  it("fails clearly when a 2FA challenge arrives with no way to answer it", async () => {
    const { fetchImpl } = stubFetch([TOTP_CHALLENGE]);
    await expect(loginWithPassword(HOST, "ada", PASSWORD, { fetchImpl })).rejects.toThrow(
      /interactive terminal/,
    );
  });

  it("fails when the instance returns no token", async () => {
    const { fetchImpl } = stubFetch([OK_LOGIN, { status: 200, body: { data: "" } }]);
    await expect(loginWithPassword(HOST, "ada", PASSWORD, { fetchImpl })).rejects.toThrow(/no login token/);
  });
});

describe("bootstrapLoginToken choices (#138)", () => {
  it("choice 1 runs the password flow and returns the token", async () => {
    const { fetchImpl } = stubFetch([OK_LOGIN, TOKEN_RESPONSE]);
    const { prompts } = scriptedPrompts({ ask: ["1", "ada@example.org"], secret: [PASSWORD] });
    const outcome = await bootstrapLoginToken(HOST, {
      prompts,
      isTTY: true,
      secureStorage: true,
      fetchImpl,
    });
    expect(outcome).toEqual({ kind: "token", token: TOKEN });
  });

  it("defaults to choice 1 on an empty answer", async () => {
    const { fetchImpl } = stubFetch([OK_LOGIN, TOKEN_RESPONSE]);
    const { prompts } = scriptedPrompts({ ask: ["", "ada"], secret: [PASSWORD] });
    const outcome = await bootstrapLoginToken(HOST, {
      prompts,
      isTTY: true,
      secureStorage: true,
      fetchImpl,
    });
    expect(outcome.kind).toBe("token");
  });

  it("choice 2 keeps the existing-token path: asked hidden, returned untouched", async () => {
    const { prompts, shown } = scriptedPrompts({ ask: ["2"], secret: [`  ${TOKEN}  `] });
    const outcome = await bootstrapLoginToken(HOST, {
      prompts,
      isTTY: true,
      secureStorage: true,
      fetchImpl: (() => {
        throw new Error("the token path must not call the API itself");
      }) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: "token", token: TOKEN });
    // The token was asked for through the SECRET prompt, so it never echoes.
    expect(shown).toContain("Personal login token (not shown): ");
  });

  it("choice 3 skips and hands back an actionable command", async () => {
    const { prompts } = scriptedPrompts({ ask: ["3"] });
    const outcome = await bootstrapLoginToken(HOST, { prompts, isTTY: true, secureStorage: true });
    expect(outcome).toEqual({ kind: "skipped", hint: loginHint(HOST) });
    expect(loginHint(HOST)).toContain("ct auth login");
  });

  it("rejects an unknown choice", async () => {
    const { prompts } = scriptedPrompts({ ask: ["9"] });
    await expect(bootstrapLoginToken(HOST, { prompts, isTTY: true, secureStorage: true })).rejects.toThrow(
      /pick 1, 2 or 3/,
    );
  });

  it("never prompts on a non-TTY", async () => {
    const outcome = await bootstrapLoginToken(HOST, {
      isTTY: false,
      secureStorage: true,
      prompts: {
        ask: async () => {
          throw new Error("must not prompt");
        },
        askSecret: async () => {
          throw new Error("must not prompt");
        },
      },
    });
    expect(outcome.kind).toBe("skipped");
  });
});

describe("platform without secure credential storage (#138)", () => {
  it("collects nothing and keeps the environment-variable guidance", async () => {
    const outcome = await bootstrapLoginToken(HOST, {
      isTTY: true,
      secureStorage: false,
      prompts: {
        ask: async () => {
          throw new Error("no credential may be collected without a store to put it in");
        },
        askSecret: async () => {
          throw new Error("no credential may be collected without a store to put it in");
        },
      },
    });
    expect(outcome).toEqual({ kind: "unsupported", hint: envVarHint(HOST) });
    expect(envVarHint(HOST)).toContain("CT_LOGINTOKEN");
    expect(envVarHint(HOST)).toContain("CT_HOST");
  });

  it("isSecureStorageAvailable tracks the platform the Keychain lives on", () => {
    expect(isSecureStorageAvailable()).toBe(process.platform === "darwin");
  });
});

describe("secret redaction (#138)", () => {
  it("scrubs every known secret out of a message", () => {
    const text = `sent ${PASSWORD} and ${TOTP} and ${TOKEN}`;
    const clean = redactSecrets(text, [PASSWORD, TOTP, TOKEN, undefined, ""]);
    expect(clean).not.toContain(PASSWORD);
    expect(clean).not.toContain(TOTP);
    expect(clean).not.toContain(TOKEN);
    expect(clean).toContain("[redacted]");
  });

  it("redacts a server that echoes the credentials straight back", async () => {
    const { fetchImpl } = stubFetch([
      { status: 400, body: { message: `Bad request: {"password":"${PASSWORD}"}` } },
    ]);
    const err = await loginWithPassword(HOST, "ada", PASSWORD, { fetchImpl }).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(PASSWORD);
    expect((err as Error).message).toContain("[redacted]");
  });

  it("no secret reaches the terminal anywhere in the interactive flow", async () => {
    const { fetchImpl } = stubFetch([
      { ...TOTP_CHALLENGE, setCookie: ["ct=1"] },
      { status: 200, body: { data: { personId: 42 } } },
      TOKEN_RESPONSE,
    ]);
    const { prompts, shown } = scriptedPrompts({
      ask: ["1", "ada@example.org"],
      secret: [PASSWORD, TOTP],
    });
    const outcome = await bootstrapLoginToken(HOST, {
      prompts,
      isTTY: true,
      secureStorage: true,
      fetchImpl,
    });
    expect(outcome).toEqual({ kind: "token", token: TOKEN });
    const transcript = shown.join("\n");
    for (const secret of [PASSWORD, TOTP, TOKEN]) {
      expect(transcript).not.toContain(secret);
    }
  });

  it("the password and code are sent once and only to the login endpoints", async () => {
    const { fetchImpl, calls } = stubFetch([
      { ...TOTP_CHALLENGE, setCookie: ["ct=1"] },
      { status: 200, body: { data: { personId: 42 } } },
      TOKEN_RESPONSE,
    ]);
    await loginWithPassword(HOST, "ada", PASSWORD, { fetchImpl, askTotp: async () => TOTP });
    const withPassword = calls.filter((c) => c.body?.includes(PASSWORD));
    const withCode = calls.filter((c) => c.body?.includes(TOTP));
    expect(withPassword.map((c) => c.url)).toEqual([`${HOST}/api/login`]);
    expect(withCode.map((c) => c.url)).toEqual([`${HOST}/api/login/totp`]);
    // Nothing secret ever rides in a URL, where it would land in an access log.
    for (const call of calls) {
      expect(call.url).not.toContain(PASSWORD);
      expect(call.url).not.toContain(TOTP);
    }
  });
});

describe("ct auth login flags (#138)", () => {
  it("offers no password flag — a password must never reach the shell history", async () => {
    const { authCommand } = await import("../src/commands/auth.js");
    const login = authCommand()
      .commands.find((c) => c.name() === "login")
      ?.options.map((o) => o.flags)
      .join(" ");
    expect(login).toBeDefined();
    expect(login).not.toMatch(/password/i);
    expect(login).not.toMatch(/--totp|--code|--user(name)?/i);
  });
});
