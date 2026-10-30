import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvProfile, gatewayPort, GATEWAY_FLAG } from "../src/env/envs.js";
import { CtClient } from "../src/api/ctClient.js";
import { runAuthToken } from "../src/application/operations/auth.js";
import { checkEnvAuth, renderEnvAuth } from "../src/auth/status.js";

let dir: string;
async function envsFile(environments: unknown): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "ct-gw-"));
  const p = join(dir, "ct.envs.json");
  await writeFile(p, JSON.stringify({ environments }));
  return p;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const GW = {
  url: "https://abc.execute-api.eu-central-1.amazonaws.com/",
  region: "eu-central-1",
  profile: "p",
};

describe("gateway env profile", () => {
  it("parses the gateway block and the local port", async () => {
    const p = await envsFile({ "prod-ro": { host: "http://127.0.0.1:8766", gateway: GW } });
    const profile = await loadEnvProfile("prod-ro", p);
    expect(profile.gateway).toEqual({ ...GW, url: "https://abc.execute-api.eu-central-1.amazonaws.com" });
    expect(gatewayPort(profile)).toBe(8766);
  });

  it("rejects a non-loopback or https host for a gateway env, and a non-https gateway url", async () => {
    const p1 = await envsFile({ x: { host: "https://mychurch.church.tools", gateway: GW } });
    await expect(loadEnvProfile("x", p1)).rejects.toThrow(/127\.0\.0\.1/);
    const p2 = await envsFile({ x: { host: "http://localhost:1", gateway: GW } });
    await expect(loadEnvProfile("x", p2)).rejects.toThrow(/127\.0\.0\.1/);
    const p3 = await envsFile({ x: { host: "http://127.0.0.1:1", gateway: { ...GW, url: "http://x" } } });
    await expect(loadEnvProfile("x", p3)).rejects.toThrow(/https/);
    const p4 = await envsFile({ x: { host: "http://127.0.0.1:1", gateway: { url: GW.url } } });
    await expect(loadEnvProfile("x", p4)).rejects.toThrow(/gateway\.region/);
    const p5 = await envsFile({
      x: { host: "http://127.0.0.1:1", gateway: { ...GW, url: `${GW.url}prod` } },
    });
    await expect(loadEnvProfile("x", p5)).rejects.toThrow(/must not have a path/);
  });
});

describe("CtClient in gateway mode", () => {
  function client(): { c: CtClient; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn(async () => new Response('{"data":{"id":1}}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return { c: new CtClient({ host: "http://127.0.0.1:8766" }, { gatewayEnv: "prod-ro" }), fetchMock };
  }

  it("authenticates with a plain whoami GET, no login_token", async () => {
    const { c, fetchMock } = client();
    await c.authenticateViaGateway();
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toBe("http://127.0.0.1:8766/api/whoami");
  });

  it("names the proxy command when the proxy is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const c = new CtClient({ host: "http://127.0.0.1:8766" }, { gatewayEnv: "prod-ro" });
    await expect(c.authenticateViaGateway()).rejects.toThrow(/ct gateway proxy --env prod-ro/);
  });

  it("refuses writes before any request leaves", async () => {
    const { c, fetchMock } = client();
    await c.authenticateViaGateway();
    fetchMock.mockClear();
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(c.request(m, "/groups/1", {})).rejects.toThrow(
        /prod-ro is read-only.*writes happen in CI/,
      );
    }
    await expect(c.ajax("churchdb", { func: "deleteMasterData", table: "t", id: "1" })).rejects.toThrow(
      /read-only/,
    );
    await expect(c.legacyPostForm("churchdb/ajax", { func: "getMasterData", extra: "1" })).rejects.toThrow(
      /read-only/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still allows GET and the two getMasterData reads", async () => {
    const { c, fetchMock } = client();
    await c.authenticateViaGateway();
    await c.get("/groups/1");
    await c.legacyPostForm("churchauth/ajax", { func: "getMasterData" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("explains a gateway 403 `blocked` as an allowlist decision and does not retry", async () => {
    const { c, fetchMock } = client();
    await c.authenticateViaGateway();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response('{"blocked":"GET /api/secret"}', { status: 403 }));
    await expect(c.get("/secret")).rejects.toThrow(/not on the gateway allowlist.*ct-read-gateway/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the proxy's own read-only hint for locally refused requests", async () => {
    const { c, fetchMock } = client();
    await c.authenticateViaGateway();
    fetchMock.mockImplementation(
      async () =>
        new Response('{"blocked":"X","hint":"ct gateway proxy is read-only: nope"}', { status: 403 }),
    );
    await expect(c.get("/x")).rejects.toThrow(/ct gateway proxy is read-only: nope/);
  });
});

describe("ct auth token for a gateway env", () => {
  it("prints a placeholder session and needs no stored token", async () => {
    const p = await envsFile({ "prod-ro": { host: "http://127.0.0.1:8766", gateway: GW } });
    const env: NodeJS.ProcessEnv = { CT_ENVS: p };
    const readToken = vi.fn(async () => null);
    const authedSession = vi.fn();
    const result = await runAuthToken(
      { environment: "prod-ro" },
      { env, readToken, authedSession, cwd: () => dir },
    );
    expect(result).toMatchObject({
      operation: "auth",
      action: "token",
      environment: "prod-ro",
      host: "http://127.0.0.1:8766",
      cookie: "via-gateway",
      csrfToken: "via-gateway",
      source: "gateway",
    });
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(readToken).not.toHaveBeenCalled();
    expect(authedSession).not.toHaveBeenCalled();
    expect(env[GATEWAY_FLAG]).toBe("prod-ro");
  });
});

describe("ct auth status for a gateway env", () => {
  it("asks the proxy for the identity instead of looking for a token", async () => {
    const p = await envsFile({ "prod-ro": { host: "http://127.0.0.1:8766", gateway: GW } });
    const profile = await loadEnvProfile("prod-ro", p);
    const readStored = vi.fn(async () => null);
    const status = await checkEnvAuth(profile, {
      env: {},
      readStored,
      gatewayWhoami: async () => ({ id: 1, firstName: "Test", lastName: "Reader" }),
    });
    expect(readStored).not.toHaveBeenCalled();
    expect(status.source).toEqual({ kind: "gateway" });
    expect(renderEnvAuth([status])[0]).toMatch(/✓ Test Reader \(#1\) via gateway proxy$/);
  });
});
