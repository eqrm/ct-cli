import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CtClient, CtApiError, type SessionCache } from "../src/api/ctClient.js";

function jsonResponse(body: unknown, init: ResponseInit & { setCookie?: string } = {}): Response {
  const headers = new Headers(init.headers);
  if (init.setCookie) {
    headers.append("set-cookie", init.setCookie);
  }
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/** An in-memory stand-in for the Keychain-backed store, with the same host binding. */
function memoryCache(): SessionCache & { entries: Map<string, { cookie: string; csrfToken: string }> } {
  const entries = new Map<string, { cookie: string; csrfToken: string }>();
  return {
    entries,
    load: (host, token) => Promise.resolve(entries.get(`${host}|${token}`) ?? null),
    save: (host, token, session) => {
      entries.set(`${host}|${token}`, session);
      return Promise.resolve();
    },
    drop: (host) => {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(`${host}|`)) entries.delete(key);
      }
      return Promise.resolve();
    },
  };
}

const HOST = "https://mychurch.church.tools";
const OTHER_HOST = "https://other.church.tools";

function urls(mock: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  // `fetchWithRetry` sleeps between retries (429/5xx). Run those waits instantly so
  // the retry-shaped tests below don't spend seconds actually waiting.
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session cache across invocations (#145)", () => {
  it("stores the session on login and reuses it in a second client — no second handshake", async () => {
    const cache = memoryCache();
    const first = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, { setCookie: "ct_session=abc; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-1" }));
    vi.stubGlobal("fetch", first);

    await new CtClient({ host: HOST }, { sessionCache: cache }).authenticate("tok");
    expect(cache.entries.get(`${HOST}|tok`)).toEqual({ cookie: "ct_session=abc", csrfToken: "csrf-1" });

    // A brand-new process: same host, same token, cache carried over.
    const second = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }));
    vi.stubGlobal("fetch", second);
    const client = new CtClient({ host: HOST }, { sessionCache: cache });
    const me = await client.authenticate("tok");

    expect(me).toEqual({ id: 7 });
    // One request only, and it is NOT the login handshake: no login_token, no csrftoken fetch.
    expect(second).toHaveBeenCalledTimes(1);
    expect(urls(second)[0]).toBe(`${HOST}/api/whoami`);
    expect(urls(second).join(" ")).not.toContain("login_token");
    expect(urls(second).join(" ")).not.toContain("csrftoken");
  });

  it("resumed session carries the cached cookie and CSRF token into later requests", async () => {
    const cache = memoryCache();
    await cache.save(HOST, "tok", { cookie: "ct_session=abc", csrfToken: "csrf-1" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 99 } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CtClient({ host: HOST }, { sessionCache: cache });
    await client.authenticate("tok");
    await client.request("POST", "/campuses", { name: "Mainz" });

    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get("Cookie")).toBe("ct_session=abc");
    expect(headers.get("CSRF-Token")).toBe("csrf-1"); // no extra /csrftoken round trip
  });

  it("never offers host A's session to host B (#30)", async () => {
    const cache = memoryCache();
    await cache.save(HOST, "tok", { cookie: "ct_session=abc", csrfToken: "csrf-1" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, { setCookie: "other=zzz; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-other" }));
    vi.stubGlobal("fetch", fetchMock);

    await new CtClient({ host: OTHER_HOST }, { sessionCache: cache }).authenticate("tok");

    // The other host got a full handshake, and host A's cookie was never sent there.
    expect(urls(fetchMock)[0]).toContain(`${OTHER_HOST}/api/whoami?login_token=`);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain(OTHER_HOST);
      expect(new Headers(call[1]?.headers).get("Cookie") ?? "").not.toContain("ct_session=abc");
    }
    // Both sessions coexist, each under its own host.
    expect(cache.entries.get(`${HOST}|tok`)?.cookie).toBe("ct_session=abc");
    expect(cache.entries.get(`${OTHER_HOST}|tok`)?.cookie).toBe("other=zzz");
  });

  it("a rejected cached session is dropped and replaced by a real handshake", async () => {
    const cache = memoryCache();
    await cache.save(HOST, "tok", { cookie: "stale=1", csrfToken: "old" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "unauthorized" }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, { setCookie: "fresh=2; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-2" }));
    vi.stubGlobal("fetch", fetchMock);

    const me = await new CtClient({ host: HOST }, { sessionCache: cache }).authenticate("tok");

    expect(me).toEqual({ id: 7 });
    expect(urls(fetchMock)[1]).toContain("login_token=tok");
    expect(cache.entries.get(`${HOST}|tok`)).toEqual({ cookie: "fresh=2", csrfToken: "csrf-2" });
  });

  it("401 on a real request → cache dropped, re-authenticated once, request retried", async () => {
    const cache = memoryCache();
    await cache.save(HOST, "tok", { cookie: "stale=1", csrfToken: "old" });
    const fetchMock = vi
      .fn<typeof fetch>()
      // resume probe succeeds (the session looks fine to /whoami) …
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }))
      // … then the real request is rejected
      .mockResolvedValueOnce(jsonResponse({ message: "unauthorized" }, { status: 401 }))
      // re-login
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, { setCookie: "fresh=2; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-2" }))
      // retry of the original request
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CtClient({ host: HOST }, { sessionCache: cache });
    await client.authenticate("tok");
    const campuses = await client.get("/campuses");

    expect(campuses).toEqual([{ id: 1 }]); // the 401 never reaches the user
    expect(urls(fetchMock)[4]).toBe(`${HOST}/api/campuses`);
    expect(new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get("Cookie")).toBe("fresh=2");
    expect(cache.entries.get(`${HOST}|tok`)).toEqual({ cookie: "fresh=2", csrfToken: "csrf-2" });
  });

  it("does not turn a persistently 401-ing server into a login storm", async () => {
    const cache = memoryCache();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      if (url.includes("login_token")) {
        return Promise.resolve(jsonResponse({ data: { id: 7 } }, { setCookie: "s=1; Path=/" }));
      }
      if (url.includes("csrftoken")) {
        return Promise.resolve(jsonResponse({ data: "csrf" }));
      }
      return Promise.resolve(jsonResponse({ message: "unauthorized" }, { status: 401 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CtClient({ host: HOST }, { sessionCache: cache });
    await client.authenticate("tok");
    await expect(client.get("/campuses")).rejects.toBeInstanceOf(CtApiError);

    const logins = urls(fetchMock).filter((u) => u.includes("login_token"));
    expect(logins).toHaveLength(2); // the initial login + exactly one automatic retry
  });

  it("a client without a session cache behaves exactly as before (always handshakes)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, { setCookie: "s=1; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf" }));
    vi.stubGlobal("fetch", fetchMock);

    await new CtClient({ host: HOST }).authenticate("tok");

    expect(urls(fetchMock)[0]).toContain("login_token=tok");
  });

  it("`fresh: true` ignores a cached session so `ct auth login` really verifies the token", async () => {
    const cache = memoryCache();
    await cache.save(HOST, "tok", { cookie: "ct_session=abc", csrfToken: "csrf-1" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 7 } }, { setCookie: "s=2; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await new CtClient({ host: HOST }, { sessionCache: cache }).authenticate("tok", { fresh: true });

    expect(urls(fetchMock)[0]).toContain("login_token=tok");
  });

  it("a 500 during the resume probe propagates instead of silently re-logging-in", async () => {
    const cache = memoryCache();
    await cache.save(HOST, "tok", { cookie: "ct_session=abc", csrfToken: "csrf-1" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "boom" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CtClient({ host: HOST }, { sessionCache: cache }).authenticate("tok"),
    ).rejects.toMatchObject({ name: "CtApiError", status: 500 });
    expect(urls(fetchMock).join(" ")).not.toContain("login_token");
  });
});

describe("login rate limit (HTTP 429) message", () => {
  it("says the login rate limit was hit — not that the credentials failed", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "Too many requests" }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CtClient({ host: HOST }).authenticate("tok")).rejects.toMatchObject({
      name: "CtApiError",
      status: 429,
      message: expect.stringContaining("rate-limiting logins"),
    });
  });

  it("quotes the wait from Retry-After when the server sent one", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ message: "Too many requests" }, { status: 429, headers: { "retry-after": "180" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CtClient({ host: HOST }).authenticate("tok")).rejects.toThrow(/about 3 minutes/);
  });

  it("never leaks the login token into the error message", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: "Too many requests" }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await new CtClient({ host: HOST }).authenticate("s3cret-token").catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("s3cret-token");
  });
});
