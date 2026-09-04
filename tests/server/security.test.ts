import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/server/session.js";
import { WorkspaceRegistry } from "../../src/server/workspaces.js";
import { OperationRunStore } from "../../src/server/runs.js";
import { isExactAllowedOrigin, serverCommand } from "../../src/commands/server.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("REST security primitives", () => {
  it("contains all client-selected paths in configured roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "ct-workspace-"));
    directories.push(root);
    const registry = await WorkspaceRegistry.create([root]);
    const workspace = registry.workspaces[0]!;
    expect(registry.resolveWithin(workspace, "instances/dev")).toBe(join(workspace.path, "instances/dev"));
    expect(() => registry.resolveWithin(workspace, "../escape")).toThrow(/escapes/);
  });

  it("rejects symlink escapes below an allowed workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ct-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "ct-outside-"));
    directories.push(root, outside);
    await symlink(outside, join(root, "escape"));
    const registry = await WorkspaceRegistry.create([root]);
    await expect(registry.resolveSafeWithin(registry.workspaces[0]!, "escape/file.json")).rejects.toThrow(
      /symlink/,
    );
  });

  it("consumes pairing codes once and limits session capabilities", () => {
    const sessions = new SessionManager(() => new Date("2026-01-01T00:00:00Z"));
    const paired = sessions.pair(sessions.pairingCode, ["read"]);
    expect([...paired.session.capabilities]).toEqual(["read"]);
    expect(sessions.authenticate(paired.token)?.id).toBe(paired.session.id);
    expect(() => sessions.pair(sessions.pairingCode)).toThrow(/Invalid or expired/);
  });

  it("supports cooperative cancellation through the shared observer", () => {
    const runs = new OperationRunStore();
    const { run, observer } = runs.create("plan");
    runs.cancel(run.id);
    expect(runs.get(run.id).status).toBe("cancelled");
    expect(() => observer.emit({ type: "phase-started", phase: "next" })).toThrow(/cancelled/);
  });

  it("refuses unsafe non-loopback bindings before opening a listener", async () => {
    await expect(serverCommand().parseAsync(["--host", "0.0.0.0"], { from: "user" })).rejects.toThrow(
      /requires --trusted-proxy/,
    );
    await expect(
      serverCommand().parseAsync(
        [
          "--host",
          "0.0.0.0",
          "--trusted-proxy",
          "--public-url",
          "http://plain.example",
          "--allow-origin",
          "https://extension.example",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow(/must use HTTPS/);
  });

  it("accepts exact browser-extension origins but no paths or wildcards", () => {
    expect(isExactAllowedOrigin("chrome-extension://abcdefghijklmnop")).toBe(true);
    expect(isExactAllowedOrigin("https://extension.example")).toBe(true);
    expect(isExactAllowedOrigin("https://extension.example/path")).toBe(false);
    expect(() => isExactAllowedOrigin("*")).toThrow();
  });
});
