import { describe, expect, it, vi } from "vitest";
import { listState, rekeyStateEntry, removeStateEntry } from "../../src/application/operations/state.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";

function project() {
  return {
    cwd: "/project",
    configPath: "/project/ct.config.ts",
    statePath: "/project/state.json",
    environmentsPath: "/project/ct.envs.json",
    configDisplayPath: "ct.config.ts",
    stateDisplayPath: "state.json",
    environment: "dev",
    protected: false,
    host,
  };
}

describe("state operations", () => {
  it("lists and removes through structured results without a ChurchTools dependency", async () => {
    const state = emptyState(host);
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const saveState = vi.fn();
    const dependencies = {
      resolveProject: vi.fn(async () => project()),
      loadState: vi.fn(async () => state),
      loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
      saveState,
    };

    const listed = await listState({}, dependencies);
    expect(listed.value.resources).toHaveLength(1);
    const removed = await removeStateEntry({ type: "campus", key: "mainz" }, dependencies);
    expect(removed.value).toMatchObject({ removed: true, churchToolsContacted: false });
    expect(saveState).toHaveBeenCalledOnce();
    expect(state.resources.mainz).toBeUndefined();
  });

  it("keeps dry-run side-effect free", async () => {
    const state = emptyState(host);
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const saveState = vi.fn();
    const result = await removeStateEntry(
      { type: "campus", key: "mainz", dryRun: true },
      {
        resolveProject: vi.fn(async () => project()),
        loadState: vi.fn(async () => state),
        loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
        saveState,
      },
    );
    expect(result.value.removed).toBe(false);
    expect(saveState).not.toHaveBeenCalled();
    expect(state.resources.mainz).toBeDefined();
  });

  it("fails closed when a safe removal cannot inspect config", async () => {
    const state = emptyState(host);
    state.externals!.shared = {
      type: "group",
      id: 7,
      key: "shared",
      identity: { name: "Shared", groupTypeId: 2 },
      boundAt: "t",
    };
    await expect(
      removeStateEntry(
        { type: "group", key: "shared", expectedKind: "external", requireReadableConfig: true },
        {
          resolveProject: vi.fn(async () => project()),
          loadState: vi.fn(async () => state),
          loadConfig: vi.fn(async () => {
            throw new Error("broken config");
          }),
          saveState: vi.fn(),
        },
      ),
    ).rejects.toThrow(/Could not read the config/);
    expect(state.externals?.shared).toBeDefined();
  });

  it("refuses to remove a binding that changed while confirmation was pending", async () => {
    const state = emptyState(host);
    state.externals!.shared = {
      type: "group",
      id: 8,
      key: "shared",
      identity: { name: "Changed", groupTypeId: 2 },
      boundAt: "t",
    };
    await expect(
      removeStateEntry(
        {
          type: "group",
          key: "shared",
          expectedKind: "external",
          expectedEntry: {
            type: "group",
            id: 7,
            key: "shared",
            identity: { name: "Shared", groupTypeId: 2 },
            boundAt: "t",
          },
        },
        {
          resolveProject: vi.fn(async () => project()),
          loadState: vi.fn(async () => state),
          loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
          saveState: vi.fn(),
        },
      ),
    ).rejects.toThrow(/changed while confirmation was pending/);
    expect(state.externals?.shared).toBeDefined();
  });

  it("lists, removes and rekeys external entries through the shared key namespace", async () => {
    const state = emptyState(host);
    state.externals!.shared = {
      type: "group",
      id: 7,
      key: "shared",
      identity: { name: "Shared", groupTypeId: 2 },
      boundAt: "t",
    };
    const saveState = vi.fn();
    const dependencies = {
      resolveProject: vi.fn(async () => project()),
      loadState: vi.fn(async () => state),
      loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
      saveState,
    };
    const listed = await listState({}, dependencies);
    expect(listed.value.entries).toContainEqual(
      expect.objectContaining({ kind: "external", ownership: "read-only" }),
    );
    const rekeyed = await rekeyStateEntry(
      { type: "group", oldKey: "shared", newKey: "shared_group" },
      dependencies,
    );
    expect(rekeyed.value.kind).toBe("external");
    expect(state.externals?.shared_group?.key).toBe("shared_group");
    const removed = await removeStateEntry({ type: "group", key: "shared_group" }, dependencies);
    expect(removed.value.kind).toBe("external");
    expect(state.externals?.shared_group).toBeUndefined();
  });

  it("rejects rekey collisions across managed and external entries", async () => {
    const state = emptyState(host);
    state.resources.owned = {
      type: "campus",
      id: 0,
      key: "owned",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    state.externals!.shared = {
      type: "group",
      id: 7,
      key: "shared",
      identity: { name: "Shared", groupTypeId: 2 },
      boundAt: "t",
    };
    await expect(
      rekeyStateEntry(
        { type: "group", oldKey: "shared", newKey: "owned" },
        {
          resolveProject: vi.fn(async () => project()),
          loadState: vi.fn(async () => state),
        },
      ),
    ).rejects.toThrow(/unique across managed and external/);
  });
});
