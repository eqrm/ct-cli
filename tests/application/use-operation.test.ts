import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverExternalCandidates,
  inspectExternalCandidate,
  runUseResource,
  type UseOperationDependencies,
} from "../../src/application/operations/use.js";
import type { CtApplicationError } from "../../src/application/errors.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function project(directory = "/project") {
  return {
    cwd: directory,
    configPath: join(directory, "ct.config.ts"),
    statePath: join(directory, "state.json"),
    environmentsPath: join(directory, "ct.envs.json"),
    configDisplayPath: "ct.config.ts",
    stateDisplayPath: "state.json",
    environment: "prod",
    protected: false,
    host,
  };
}

function dependencies(state = emptyState(host), row: Record<string, unknown> = { id: 7, name: "Mainz" }) {
  const saveState = vi.fn();
  const client = {
    get: vi.fn<(path?: string) => Promise<Record<string, unknown>>>().mockResolvedValue(row),
    getAll: vi.fn(async () => ({ data: [row] })),
  };
  return {
    state,
    saveState,
    client,
    value: {
      resolveProject: vi.fn(async () => project()),
      loadState: vi.fn(async () => state),
      saveState,
      authedSession: vi.fn(async () => ({ client, me: { id: 1 } })) as never,
      clock: { now: () => new Date("2026-08-27T12:00:00.000Z") },
    } satisfies UseOperationDependencies,
  };
}

describe("runUseResource", () => {
  it("creates a read-only binding and leaves managed resources untouched", async () => {
    const deps = dependencies();
    const result = await runUseResource({ type: "campus", id: 7, key: "mainz", owner: "master" }, deps.value);
    expect(result.value).toMatchObject({ action: "created", written: true, churchToolsWritten: false });
    expect(deps.state.resources).toEqual({});
    expect(deps.state.externals?.mainz).toEqual({
      type: "campus",
      key: "mainz",
      id: 7,
      owner: "master",
      identity: { name: "Mainz" },
      boundAt: "2026-08-27T12:00:00.000Z",
    });
  });

  it("is byte-stable for an unchanged binding and does not update boundAt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ct-use-idempotent-"));
    dirs.push(directory);
    const client = { get: vi.fn(async () => ({ id: 7, name: "Mainz", shorty: "MZ" })) };
    const deps: UseOperationDependencies = {
      resolveProject: vi.fn(async () => project(directory)),
      authedSession: vi.fn(async () => ({ client, me: { id: 1 } })) as never,
      clock: { now: () => new Date("2026-08-27T12:00:00.000Z") },
    };
    await runUseResource({ type: "campus", id: 7, key: "mainz" }, deps);
    const before = await readFile(join(directory, "state.json"), "utf8");
    deps.clock = { now: () => new Date("2026-08-28T12:00:00.000Z") };
    const second = await runUseResource({ type: "campus", id: 7, key: "mainz" }, deps);
    const after = await readFile(join(directory, "state.json"), "utf8");
    expect(second.value.action).toBe("no-op");
    expect(after).toBe(before);
  });

  it("requires explicit confirmation for hard identity changes, but not display-only changes", async () => {
    const state = emptyState(host);
    state.externals!.team = {
      type: "group",
      key: "team",
      id: 9,
      identity: { name: "Team", groupTypeId: 2 },
      boundAt: "t",
    };
    const deps = dependencies(state, {
      id: 9,
      name: "Team renamed",
      information: { groupTypeId: 2, campusId: 99, groupStatusId: 4 },
    });
    await expect(runUseResource({ type: "group", id: 9, key: "team" }, deps.value)).rejects.toMatchObject({
      code: "EXTERNAL_CONFIRMATION_REQUIRED",
    } satisfies Partial<CtApplicationError>);
    expect(deps.saveState).not.toHaveBeenCalled();

    const accepted = await runUseResource(
      { type: "group", id: 9, key: "team", acceptChanges: true },
      deps.value,
    );
    expect(accepted.value.action).toBe("identity-updated");
    expect(state.externals!.team!.identity).toEqual({ name: "Team renamed", groupTypeId: 2 });
  });

  it("rejects managed/external key, id and alias collisions", async () => {
    const state = emptyState(host);
    state.resources.mainz = {
      type: "campus",
      key: "mainz",
      id: 7,
      fields: { name: "Mainz" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const deps = dependencies(state);
    await expect(runUseResource({ type: "campus", id: 7, key: "mainz" }, deps.value)).rejects.toThrow(
      /already managed/,
    );
    state.externals!.berlin = {
      type: "campus",
      key: "berlin",
      id: 8,
      identity: { name: "Berlin" },
      boundAt: "t",
    };
    await expect(runUseResource({ type: "campus", id: 8, key: "other" }, deps.value)).rejects.toThrow(
      /already external as "berlin"/,
    );
  });

  it("retains the existing consumer key as the interactive proposal", async () => {
    const state = emptyState(host);
    state.externals!.carefully_named = {
      type: "campus",
      key: "carefully_named",
      id: 7,
      identity: { name: "Mainz" },
      boundAt: "t",
    };
    const deps = dependencies(state);
    const result = await inspectExternalCandidate({ type: "campus", id: 7 }, deps.value);
    expect(result.value.suggestedKey).toBe("carefully_named");
  });

  it("reports both old and new targets before an explicitly confirmed rebind", async () => {
    const state = emptyState(host);
    state.externals!.mainz = {
      type: "campus",
      key: "mainz",
      id: 6,
      identity: { name: "Old Mainz" },
      boundAt: "t",
    };
    const deps = dependencies(state, { id: 7, name: "New Mainz" });
    deps.client.get.mockImplementation(async (path?: string) =>
      path?.endsWith("/6") ? { id: 6, name: "Old Mainz" } : { id: 7, name: "New Mainz" },
    );
    await expect(runUseResource({ type: "campus", id: 7, key: "mainz" }, deps.value)).rejects.toMatchObject({
      code: "EXTERNAL_CONFIRMATION_REQUIRED",
      details: {
        action: "rebound",
        oldId: 6,
        newId: 7,
        previousLive: expect.objectContaining({ id: 6, name: "Old Mainz" }),
        live: expect.objectContaining({ id: 7, name: "New Mainz" }),
      },
    });
    expect(deps.saveState).not.toHaveBeenCalled();
  });
});

describe("discoverExternalCandidates", () => {
  it("returns every fuzzy match with registry-defined identity and display data", async () => {
    const deps = dependencies();
    deps.client.getAll.mockResolvedValue({
      data: [
        { id: 1, name: "OJAHR Fuzzies", information: { groupTypeId: 4, campusId: 2 } },
        { id: 2, name: "OJAHR Fuzzies Alumni", information: { groupTypeId: 5, campusId: 3 } },
      ],
    });
    const result = await discoverExternalCandidates({ type: "group", search: "fuzz" }, deps.value);
    expect(result.value.candidates).toHaveLength(2);
    expect(result.value.candidates[0]).toMatchObject({
      id: 1,
      identity: { name: "OJAHR Fuzzies", groupTypeId: 4 },
      display: { campusId: 2 },
    });
  });
});
