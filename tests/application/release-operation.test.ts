import { describe, expect, it, vi } from "vitest";
import {
  executePreparedRelease,
  prepareRelease,
  type PreparedReleaseExecution,
} from "../../src/application/operations/release.js";
import { PreparedOperationStore } from "../../src/application/prepared-operation-store.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";

function project(environment: string | null = "prod") {
  return {
    cwd: "/project",
    configPath: "/project/ct.config.ts",
    statePath: "/project/state.json",
    environmentsPath: "/project/ct.envs.json",
    configDisplayPath: "ct.config.ts",
    stateDisplayPath: "state.json",
    environment,
    protected: false,
    host,
  };
}

describe("release operations", () => {
  it("enforces environment proof inside the application operation", async () => {
    const state = emptyState(host);
    state.externals!.shared = {
      type: "group",
      id: 7,
      key: "shared",
      identity: { name: "Shared", groupTypeId: 2 },
      boundAt: "t",
    };
    const saveState = vi.fn();
    const store = new PreparedOperationStore<PreparedReleaseExecution>();
    const dependencies = {
      resolveProject: vi.fn(async () => project()),
      loadState: vi.fn(async () => state),
      loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
      saveState,
      store,
    };
    const prepared = await prepareRelease({ kind: "external", type: "group", key: "shared" }, dependencies);
    expect(prepared.confirmation).toEqual({ type: "environment", expected: "prod" });
    expect(prepared.preview.operation).toBe("unuse");

    await expect(executePreparedRelease(prepared, undefined, dependencies)).rejects.toMatchObject({
      code: "STATE_RELEASE_CONFIRMATION_REQUIRED",
    });
    await expect(
      executePreparedRelease(prepared, { type: "environment", value: "dev" }, dependencies),
    ).rejects.toMatchObject({ code: "STATE_RELEASE_CONFIRMATION_REQUIRED" });
    expect(saveState).not.toHaveBeenCalled();
    expect(state.externals?.shared).toBeDefined();

    const result = await executePreparedRelease(
      prepared,
      { type: "environment", value: "prod" },
      dependencies,
    );
    expect(result.operation).toBe("unuse");
    expect(result.value).toMatchObject({ kind: "external", removed: true, churchToolsContacted: false });
    expect(state.externals?.shared).toBeUndefined();
    expect(saveState).toHaveBeenCalledOnce();
  });

  it("uses exact logical-key proof for a legacy project without --env", async () => {
    const state = emptyState(host);
    state.resources.owned = {
      type: "campus",
      id: 0,
      key: "owned",
      fields: { name: "Owned" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const store = new PreparedOperationStore<PreparedReleaseExecution>();
    const dependencies = {
      resolveProject: vi.fn(async () => project(null)),
      loadState: vi.fn(async () => state),
      loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
      saveState: vi.fn(),
      store,
    };
    const prepared = await prepareRelease({ kind: "managed", type: "campus", key: "owned" }, dependencies);
    expect(prepared.confirmation).toEqual({ type: "key", expected: "owned" });
    await executePreparedRelease(prepared, { type: "key", value: "owned" }, dependencies);
    expect(state.resources.owned).toBeUndefined();
  });
});
