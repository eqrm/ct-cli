import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCtApiServer, type CtApiServer } from "../../src/server/app.js";

interface Running {
  api: CtApiServer;
  base: string;
  directory: string;
}

const running: Running[] = [];

async function start(options: { origins?: string[]; bodyLimitBytes?: number } = {}): Promise<Running> {
  const directory = await mkdtemp(join(tmpdir(), "ct-api-"));
  const api = await createCtApiServer({
    workspaceRoots: [directory],
    allowedOrigins: options.origins,
    bodyLimitBytes: options.bodyLimitBytes,
  });
  await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const address = api.server.address();
  if (!address || typeof address === "string") throw new Error("No TCP server address.");
  const value = { api, base: `http://127.0.0.1:${address.port}`, directory };
  running.push(value);
  return value;
}

async function pair(target: Running): Promise<string> {
  const response = await fetch(`${target.base}/api/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: target.api.pairingCode }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: { token: string } }).result.token;
}

async function pairWith(target: Running, capabilities: string[]): Promise<string> {
  const response = await fetch(`${target.base}/api/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: target.api.pairingCode, capabilities }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: { token: string } }).result.token;
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(async (target) => {
      const closed = new Promise<void>((resolve) => target.api.server.close(() => resolve()));
      target.api.server.closeAllConnections();
      await closed;
      await rm(target.directory, { recursive: true, force: true });
    }),
  );
});

describe("versioned REST API", () => {
  it("serves public health and the generated OpenAPI document", async () => {
    const target = await start();
    const health = await fetch(`${target.base}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      apiVersion: "v1",
      operation: "system.health",
      result: { status: "ok" },
    });

    const spec = await fetch(`${target.base}/api/v1/openapi.json`);
    expect(spec.status).toBe(200);
    expect(await spec.json()).toMatchObject({ openapi: "3.1.0", servers: [{ url: "/" }] });
  });

  it("serves a CSP-protected Scalar API reference backed by the generated contract", async () => {
    const target = await start();
    const response = await fetch(`${target.base}/api/docs`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("https://cdn.jsdelivr.net");

    const html = await response.text();
    expect(html).toContain("@scalar/api-reference@1.67.0");
    expect(html).toContain("url: '/api/v1/openapi.json'");
    expect(html).toContain("disabled: true");
    expect(html).toContain("telemetry: false");

    const spec = (await (await fetch(`${target.base}/api/v1/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, { content: object }> }>>;
    };
    expect(spec.paths["/api/docs"]?.get?.responses["200"]?.content).toHaveProperty("text/html");
  });

  it("exchanges the pairing code once and requires the scoped session", async () => {
    const target = await start();
    const workspace = target.api.workspaces[0]!;
    expect((await fetch(`${target.base}/api/v1/workspaces`)).status).toBe(401);

    const token = await pair(target);
    const second = await fetch(`${target.base}/api/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: target.api.pairingCode }),
    });
    expect(second.status).toBe(400);

    const response = await fetch(`${target.base}/api/v1/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { workspaces: [{ id: workspace.id }] },
    });
  });

  it("rejects unlisted browser origins before pairing or authentication", async () => {
    const target = await start({ origins: ["https://extension.example"] });
    const denied = await fetch(`${target.base}/api/v1/health`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "ORIGIN_DENIED" });
  });

  it("enforces capability-scoped sessions", async () => {
    const target = await start();
    const token = await pairWith(target, ["read"]);
    const workspace = target.api.workspaces[0]!;
    const response = await fetch(`${target.base}/api/v1/workspaces/${workspace.id}/input/snapshots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        document: { schemaVersion: "1", clientRevision: "r1", payload: {} },
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("stores immutable versioned input snapshots inside the configured workspace", async () => {
    const target = await start();
    const token = await pair(target);
    const workspace = target.api.workspaces[0]!;
    const document = { schemaVersion: "1", clientRevision: "rev-7", payload: { title: "Example" } };
    const created = await fetch(`${target.base}/api/v1/workspaces/${workspace.id}/input/snapshots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "snapshot-retry",
      },
      body: JSON.stringify({ document }),
    });
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { result: { value: { digest: string } } };
    expect(payload.result.value.digest).toMatch(/^[a-f0-9]{64}$/);

    const replay = await fetch(`${target.base}/api/v1/workspaces/${workspace.id}/input/snapshots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "snapshot-retry",
      },
      body: JSON.stringify({ document }),
    });
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await replay.json()) as { result: unknown }).toMatchObject({ result: payload.result });

    const conflict = await fetch(`${target.base}/api/v1/workspaces/${workspace.id}/input/snapshots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "snapshot-retry",
      },
      body: JSON.stringify({ document: { ...document, clientRevision: "different" } }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const fetched = await fetch(
      `${target.base}/api/v1/workspaces/${workspace.id}/input/snapshots/${payload.result.value.digest}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(await fetched.json()).toMatchObject({ result: { value: document, persisted: true } });
  });

  it("projects external-reference ownership and release operations through HTTP", async () => {
    const target = await start();
    const token = await pair(target);
    const workspace = target.api.workspaces[0]!;
    const project = target.directory;
    await writeFile(join(project, "ct.config.ts"), "export default () => {};\n");
    await writeFile(
      join(project, "ct.envs.json"),
      JSON.stringify({
        environments: {
          prod: { host: "https://example.church.tools", state: "ct-state.prod.json" },
        },
      }),
    );
    await writeFile(
      join(project, "ct-state.prod.json"),
      JSON.stringify({
        version: 2,
        host: "https://example.church.tools",
        resources: {},
        externals: {
          shared: {
            type: "group",
            key: "shared",
            id: 7,
            identity: { name: "Shared", groupTypeId: 2 },
            boundAt: "2026-09-04T00:00:00.000Z",
          },
        },
      }),
    );

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const ownership = await fetch(`${target.base}/api/v1/workspaces/${workspace.id}/ownership/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: ".", environment: "prod" }),
    });
    expect(ownership.status).toBe(200);
    expect(await ownership.json()).toMatchObject({
      operation: "ownership.check",
      result: { value: { projects: [{}] } },
    });

    const prepared = await fetch(
      `${target.base}/api/v1/workspaces/${workspace.id}/releases/external/prepare/group/shared`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ environment: "prod", configPath: "ct.config.ts" }),
      },
    );
    expect(prepared.status).toBe(201);
    const preview = (await prepared.json()) as {
      result: { id: string; confirmation: { type: string; expected: string } };
    };
    expect(preview.result.confirmation).toEqual({ type: "environment", expected: "prod" });

    const executed = await fetch(
      `${target.base}/api/v1/workspaces/${workspace.id}/releases/external/execute/${preview.result.id}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          environment: "prod",
          configPath: "ct.config.ts",
          confirmation: { type: "environment", value: "prod" },
        }),
      },
    );
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({
      operation: "release.external",
      result: { operation: "unuse", value: { removed: true, churchToolsContacted: false } },
    });
    const state = JSON.parse(await readFile(join(project, "ct-state.prod.json"), "utf8")) as {
      externals: Record<string, unknown>;
    };
    expect(state.externals).toEqual({});
  });

  it("enforces request-size limits without reflecting request contents", async () => {
    const target = await start({ bodyLimitBytes: 16 });
    const response = await fetch(`${target.base}/api/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "secret-that-is-too-large" }),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain("secret-that-is-too-large");
  });
});
