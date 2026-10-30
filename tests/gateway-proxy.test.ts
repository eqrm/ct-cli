import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cachingCredentials, createProxyServer, listenLoopback } from "../src/gateway/proxy.js";

const CREDS = { accessKeyId: "AKIATEST", secretAccessKey: "secret", sessionToken: "tok-session" };

interface Seen {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function start(): Promise<{ proxy: string; seen: Seen[]; logs: string[] }> {
  const seen: Seen[] = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.url === "/api/busy") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "7", "set-cookie": "s=1" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":{"id":123}}');
    });
  });
  servers.push(upstream);
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const logs: string[] = [];
  // The real gateway is https; the test upstream is http, so route the signed https URL to it.
  const proxy = createProxyServer({
    gatewayUrl: "https://gw.example.execute-api.eu-central-1.amazonaws.com",
    region: "eu-central-1",
    credentials: async () => CREDS,
    log: (l) => logs.push(l),
    fetchImpl: (input, init) =>
      fetch(String(input).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${upstreamPort}`), init),
  });
  servers.push(proxy);
  await listenLoopback(proxy, 0);
  return { proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, seen, logs };
}

describe("gateway proxy", () => {
  it("refuses a foreign Host header (DNS rebinding) without forwarding", async () => {
    const { proxy, seen } = await start();
    const { port } = new URL(proxy);
    const status = await new Promise<number>((done, fail) => {
      request(
        { host: "127.0.0.1", port, path: "/api/persons", headers: { host: `attacker.example:${port}` } },
        (r) => {
          r.resume();
          done(r.statusCode!);
        },
      )
        .on("error", fail)
        .end();
    });
    expect(status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("passes Retry-After through, and nothing else but content-type", async () => {
    const { proxy } = await start();
    const res = await fetch(`${proxy}/api/busy`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("binds loopback only", async () => {
    const { proxy } = await start();
    expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((servers[1]!.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("signs forwarded requests (SigV4, execute-api) and strips cookie/auth/csrf/login_token", async () => {
    const { proxy, seen, logs } = await start();
    const res = await fetch(`${proxy}/api/groups/123?login_token=SECRET&page=1`, {
      headers: { Cookie: "ChurchTools_x=abc", Authorization: "Login SECRET", "CSRF-Token": "csrf" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 123 } });
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.url).toBe("/api/groups/123?page=1");
    expect(s.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-central-1\/execute-api\/aws4_request, SignedHeaders=.*Signature=[0-9a-f]{64}$/,
    );
    expect(s.headers["x-amz-security-token"]).toBe("tok-session");
    expect(s.headers["x-amz-date"]).toBeTruthy();
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers["csrf-token"]).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("SECRET");
    // One line, method + path, no query.
    expect(logs).toEqual(["GET /api/groups/123 200"]);
  });

  it("forwards the getMasterData POST, signed", async () => {
    const { proxy, seen } = await start();
    const res = await fetch(`${proxy}/index.php?q=churchauth/ajax`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "func=getMasterData",
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "POST", body: "func=getMasterData" });
    expect(seen[0]!.url).toBe("/index.php?q=churchauth%2Fajax");
    expect(seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it("refuses writes locally with 403 and never contacts the gateway", async () => {
    const { proxy, seen, logs } = await start();
    for (const [method, path, body] of [
      ["PUT", "/api/groups/1", "{}"],
      ["DELETE", "/api/groups/1", undefined],
      ["POST", "/index.php?q=churchdb/ajax", "func=deleteMasterData"],
    ] as const) {
      const res = await fetch(`${proxy}${path}`, { method, body });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { blocked: string; hint: string };
      expect(json.hint).toMatch(/read-only/);
    }
    expect(seen).toHaveLength(0);
    expect(logs.every((l) => l.includes("403"))).toBe(true);
    expect(logs.join("\n")).not.toContain("deleteMasterData");
  });
});

describe("cachingCredentials", () => {
  it("re-runs the provider only when credentials are about to expire, once for concurrent calls", async () => {
    let calls = 0;
    let now = 0;
    const get = cachingCredentials(
      async () => {
        calls++;
        return { ...CREDS, expiration: new Date(now + 3600_000) };
      },
      () => now,
    );
    await Promise.all([get(), get(), get()]);
    expect(calls).toBe(1);
    now = 1800_000;
    await get();
    expect(calls).toBe(1);
    now = 3600_000 - 30_000; // inside the 60 s margin
    await get();
    expect(calls).toBe(2);
  });
});
