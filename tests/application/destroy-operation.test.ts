import { describe, expect, it, vi } from "vitest";
import type { CtApplicationError } from "../../src/application/errors.js";
import {
  executePreparedDestroy,
  prepareDestroy,
  runDeleteLoop,
  type DestroyOperationDependencies,
  type PreparedDestroyExecution,
} from "../../src/application/operations/destroy.js";
import { PreparedOperationStore } from "../../src/application/prepared-operation-store.js";
import { CtApiError, type CtClient } from "../../src/api/ctClient.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";
const statePath = "/project/ct-state.prod.json";

function harness() {
  let stateFile = "state-v1";
  const state = emptyState(host);
  state.resources.area = {
    type: "group",
    id: 42,
    key: "area",
    fields: {},
    adoptedAt: "t",
    updatedAt: "t",
  };
  const request = vi.fn(async () => ({}));
  const client = {
    get: vi.fn(async () => []),
    request,
  } as unknown as CtClient;
  const store = new PreparedOperationStore<PreparedDestroyExecution>(undefined, {
    nextId: () => "destroy-1",
  });
  const events: string[] = [];
  const dependencies: DestroyOperationDependencies = {
    store,
    readStateFile: async () => stateFile,
    resolveProject: vi.fn(async () => ({
      cwd: "/project",
      configPath: "/project/ct.config.ts",
      statePath,
      environmentsPath: "/project/ct.envs.json",
      configDisplayPath: "ct.config.ts",
      stateDisplayPath: "ct-state.prod.json",
      environment: "prod",
      protected: true,
      host,
    })),
    loadState: vi.fn(async () => state),
    authedSession: vi.fn(async () => ({ client, me: { id: 1 } })),
    fetchActual: vi.fn(async () => ({
      actual: new Map([["area", { name: "Area" }]]),
      fetchErrors: [],
      unresolved: new Set<string>(),
      fetchFailed: new Map<string, string>(),
    })),
    writeBackup: vi.fn(async () => "/project/backups/backup.json"),
    saveState: vi.fn(async () => {}),
    observer: { emit: (event) => events.push(event.type) },
  };
  return {
    dependencies,
    state,
    request,
    events,
    changeState(value: string) {
      stateFile = value;
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: CtApplicationError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "CtApplicationError", code });
}

describe("prepared destroy operation", () => {
  it("cannot target an external binding and performs no ChurchTools read or write", async () => {
    const test = harness();
    test.state.externals!.shared = {
      type: "group",
      id: 77,
      key: "shared",
      identity: { name: "Shared", groupTypeId: 2 },
      boundAt: "t",
    };
    await expect(prepareDestroy({ targets: ["shared"] }, test.dependencies)).rejects.toThrow(
      /not managed.*Nothing to destroy/,
    );
    expect(test.request).not.toHaveBeenCalled();
    expect(test.dependencies.authedSession).not.toHaveBeenCalled();
  });

  it("exposes the exact proposal and requires the protected environment before deleting", async () => {
    const test = harness();
    const prepared = await prepareDestroy({ targets: ["area"] }, test.dependencies);

    expect(prepared).toMatchObject({
      id: "destroy-1",
      targets: ["area"],
      memberFields: [],
      backupPath: "/project/backups/backup.json",
      confirmation: { type: "environment", environment: "prod" },
    });
    expect(test.request).not.toHaveBeenCalled();

    await expectCode(
      executePreparedDestroy(prepared, { type: "yes" }, test.dependencies),
      "PROTECTED_ENV_CONFIRMATION_REQUIRED",
    );
    expect(test.request).not.toHaveBeenCalled();

    const result = await executePreparedDestroy(
      prepared,
      { type: "environment", value: "prod" },
      test.dependencies,
    );
    expect(test.request).toHaveBeenCalledWith("DELETE", "/groups/42");
    expect(result).toMatchObject({
      operation: "destroy",
      value: {
        backupPath: "/project/backups/backup.json",
        complete: true,
        outcomes: [{ key: "area", id: 42, status: "destroyed" }],
      },
    });
    expect(test.events).toContain("resource-destroyed");
  });

  it("reports every completed delete before a mid-loop throw can discard them", async () => {
    const state = emptyState(host);
    for (const key of ["a", "b", "c"]) {
      state.resources[key] = { type: "group", id: 1, key, fields: {}, adoptedAt: "t", updatedAt: "t" };
    }
    const messages: string[] = [];
    let saves = 0;
    await expect(
      runDeleteLoop({
        client: { request: vi.fn(async () => ({})) } as unknown as CtClient,
        state,
        statePath,
        ordered: ["a", "b", "c"],
        save: async () => {
          saves += 1;
          if (saves === 3) throw new Error("EACCES: state file is read-only");
        },
        observer: {
          emit: (event) => {
            if (event.type === "outcome") messages.push(event.outcome.message);
          },
        },
      }),
    ).rejects.toThrow("EACCES");
    // The array the old code returned is gone with the stack — these two deletes really happened
    // in ChurchTools, and the operator has been told so.
    expect(messages).toEqual(["Destroyed group.a (#1)", "Destroyed group.b (#1)"]);
  });

  it("keeps the HTTP status but truncates a huge body in the stop message", async () => {
    const state = emptyState(host);
    state.resources.a = { type: "group", id: 9, key: "a", fields: {}, adoptedAt: "t", updatedAt: "t" };
    const outcomes = await runDeleteLoop({
      client: {
        request: vi.fn(async () => {
          throw new CtApiError("DELETE /groups/9 failed", 502, "<html>".repeat(2000));
        }),
      } as unknown as CtClient,
      state,
      statePath,
      ordered: ["a"],
      save: async () => {},
    });
    const message = outcomes[0]!.message;
    expect(message).toContain("(HTTP 502)");
    // The resume guidance must not be buried under a full HTML error page (#50).
    expect(message).toContain("truncated");
    expect(message.length).toBeLessThan(2600);
  });

  it("does not expire a prepared destroy the caller keeps across a blocking confirmation", async () => {
    const test = harness();
    const prepared = await prepareDestroy(
      { targets: ["area"] },
      { ...test.dependencies, preparedTtlMs: null },
    );
    expect(prepared.expiresAt).toBeNull();

    const result = await executePreparedDestroy(
      prepared,
      { type: "environment", value: "prod" },
      test.dependencies,
    );
    expect(result.value.complete).toBe(true);
  });

  it("refuses a proposal after its state file changed", async () => {
    const test = harness();
    const prepared = await prepareDestroy({ targets: ["area"] }, test.dependencies);
    test.changeState("state-v2");

    await expectCode(
      executePreparedDestroy(prepared, { type: "environment", value: "prod" }, test.dependencies),
      "PLAN_CONFIRMATION_MISMATCH",
    );
    expect(test.request).not.toHaveBeenCalled();
  });
});
