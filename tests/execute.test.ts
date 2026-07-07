import { describe, it, expect } from "vitest";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import type { Plan } from "../src/engine/types.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recorder(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      return (responses[key] ?? {}) as T;
    },
  };
  return { client, calls };
}

const noSave = async (_p: string, _s: State) => {};
const fixedNow = () => "2026-07-07T00:00:00.000Z";

describe("executePlan", () => {
  it("creates a resource, captures its id, and records it in state", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /campuses": { id: 5 } });
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Zürich" },
            { field: "shortName", from: undefined, to: "ZH" },
          ],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.created).toEqual(["zurich"]);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/campuses",
      body: { name: "Zürich", shortName: "ZH" },
    });
    expect(state.resources.zurich).toMatchObject({
      type: "campus",
      id: 5,
      key: "zurich",
      fields: { name: "Zürich", shortName: "ZH" },
    });
  });

  it("updates a group via PATCH with the full managed snapshot", async () => {
    const state = emptyState("h");
    state.resources.team = {
      type: "group",
      id: 9,
      key: "team",
      fields: { name: "Team", groupTypeId: 2, groupStatusId: 1 },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "team",
          id: 9,
          action: "update",
          changes: [{ field: "name", from: "Team", to: "Team A" }],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.updated).toEqual(["team"]);
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/groups/9",
      body: { name: "Team A", groupTypeId: 2, groupStatusId: 1 },
    });
    expect(state.resources.team!.fields).toEqual({ name: "Team A", groupTypeId: 2, groupStatusId: 1 });
  });

  it("reconciles hierarchy edges via PUT/DELETE and never stores parents in state", async () => {
    const state = emptyState("h");
    state.resources.parent = {
      type: "group",
      id: 1,
      key: "parent",
      fields: { name: "P" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    state.resources.child = {
      type: "group",
      id: 2,
      key: "child",
      fields: { name: "C" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "child",
          id: 2,
          action: "update",
          changes: [{ field: "parents", from: [], to: ["parent"] }],
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(calls).toEqual([{ method: "PUT", path: "/groups/2/parents/1", body: undefined }]);
    expect(state.resources.child!.fields.parents).toBeUndefined();
  });

  it("skips deletes (apply never deletes)", async () => {
    const state = emptyState("h");
    state.resources.old = {
      type: "campus",
      id: 3,
      key: "old",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = { items: [{ type: "campus", key: "old", id: 3, action: "delete", changes: [] }] };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.skippedDeletes).toEqual(["old"]);
    expect(calls).toEqual([]);
    expect(state.resources.old).toBeDefined();
  });

  it("stops on the first write error and reports it", async () => {
    const state = emptyState("h");
    const client = {
      request: async <T>(): Promise<T> => {
        throw new Error("boom");
      },
    };
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Z" }],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed).toEqual({ key: "zurich", message: "boom" });
    expect(result.created).toEqual([]);
  });
});
