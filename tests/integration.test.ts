import { describe, it, expect } from "vitest";
import { buildPlan } from "../src/engine/build.js";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import { CtApiError } from "../src/api/ctClient.js";
import type { DesiredResource } from "../src/engine/types.js";

/** A tiny in-memory ChurchTools: a campuses store supporting GET/POST/PUT; hierarchy is empty. */
function fakeCt() {
  const campuses = new Map<number, Record<string, unknown>>([
    [0, { id: 0, name: "Mainz", shortName: "MZ" }],
  ]);
  let nextId = 1;
  return {
    get: async <T>(path: string): Promise<T> => {
      const m = /^\/campuses\/(\d+)$/.exec(path);
      if (m) {
        const c = campuses.get(Number(m[1]));
        if (!c) {
          throw new CtApiError("nf", 404, null);
        }
        return c as T;
      }
      if (path === "/groups/hierarchies") {
        return [] as T;
      }
      throw new CtApiError("nf", 404, null);
    },
    request: async <T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> => {
      if (method === "POST" && path === "/campuses") {
        const id = nextId++;
        campuses.set(id, { id, ...body });
        return { id } as T;
      }
      const m = /^\/campuses\/(\d+)$/.exec(path);
      if (method === "PUT" && m) {
        campuses.set(Number(m[1]), { id: Number(m[1]), ...body });
        return {} as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const noSave: (path: string, state: State) => Promise<void> = async () => {};

describe("apply → re-plan shows no drift", () => {
  it("creates a new campus and updates an adopted one, then plans clean", async () => {
    const client = fakeCt();
    const state = emptyState("h");
    // adopt the existing Mainz campus
    state.resources.mz = {
      type: "campus",
      id: 0,
      key: "mz",
      fields: { name: "Mainz", shortName: "MZ" },
      adoptedAt: "t",
      updatedAt: "t",
    };

    const desired: DesiredResource[] = [
      { type: "campus", key: "mz", fields: { name: "Mainz City", shortName: "MZ" }, dependsOn: [] },
      { type: "campus", key: "zh", fields: { name: "Zürich", shortName: "ZH" }, dependsOn: [] },
    ];

    const first = await buildPlan(client, state, desired);
    expect(first.plan.items.filter((i) => i.action !== "no-op").length).toBe(2); // 1 update + 1 create

    const result = await executePlan(first.plan, { client, state, statePath: "s", save: noSave });
    expect(result.failed).toBeUndefined();
    expect(result.created).toEqual(["zh"]);
    expect(result.updated).toEqual(["mz"]);

    const second = await buildPlan(client, state, desired);
    expect(second.plan.items.every((i) => i.action === "no-op")).toBe(true);
  });
});
