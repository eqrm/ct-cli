import { describe, it, expect, vi } from "vitest";
import { parseTargets, orderDestroy, runDeleteLoop, destroyWarnings } from "../src/commands/destroy.js";
import { emptyState, type State } from "../src/state/state.js";
import { CtApiError, type CtClient } from "../src/api/ctClient.js";

function stateWith(...entries: Array<{ key: string; type: string; id: number }>): State {
  const state = emptyState("h");
  for (const e of entries) {
    state.resources[e.key] = { type: e.type, id: e.id, key: e.key, fields: {}, adoptedAt: "t", updatedAt: "t" };
  }
  return state;
}

describe("parseTargets", () => {
  it("splits commas, trims, and dedupes", () => {
    expect(parseTargets(["a,b", " c ", "a"])).toEqual(["a", "b", "c"]);
  });
});

describe("orderDestroy", () => {
  it("orders higher tiers first (reverse of apply): groups before campuses", () => {
    const state = emptyState("h");
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    state.resources.team = {
      type: "group",
      id: 1,
      key: "team",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    expect(orderDestroy(state, ["mainz", "team"])).toEqual(["team", "mainz"]);
  });

  it("orders a child before its parent within the group tier (live hierarchy edges)", () => {
    const state = stateWith(
      { key: "area", type: "group", id: 1 },
      { key: "kids", type: "group", id: 2 },
    );
    // kids → parent area. State carries no edges, so the command supplies them from /groups/hierarchies.
    const edges = new Map([["kids", ["area"]]]);
    // Input order deliberately parent-first: a tier-only sort would delete area before kids.
    expect(orderDestroy(state, ["area", "kids"], edges)).toEqual(["kids", "area"]);
    // Order-independent: the child still precedes the parent regardless of input order.
    expect(orderDestroy(state, ["kids", "area"], edges)).toEqual(["kids", "area"]);
  });

  it("still puts a campus (base tier) last, after its child groups", () => {
    const state = stateWith(
      { key: "mainz", type: "campus", id: 0 },
      { key: "area", type: "group", id: 1 },
      { key: "kids", type: "group", id: 2 },
    );
    const edges = new Map([["kids", ["area"]]]);
    expect(orderDestroy(state, ["mainz", "area", "kids"], edges)).toEqual(["kids", "area", "mainz"]);
  });
});

describe("runDeleteLoop", () => {
  const asClient = (request: unknown) => ({ request }) as unknown as Pick<CtClient, "request">;

  it("treats a 404 (already deleted in CT) as success: removes from state and continues to the next target", async () => {
    const state = stateWith({ key: "gone", type: "group", id: 1 }, { key: "other", type: "group", id: 2 });
    const request = vi.fn(async (_m: string, path: string) => {
      if (path === "/groups/1") throw new CtApiError("Not Found", 404, null);
      return {};
    });
    const save = vi.fn(async () => {});

    await runDeleteLoop({ client: asClient(request), state, statePath: "s.json", ordered: ["gone", "other"], save });

    expect(state.resources.gone).toBeUndefined();  // already-deleted target removed from state
    expect(state.resources.other).toBeUndefined();  // loop continued and deleted the rest
    expect(request).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("stops on a non-404 error with state saved up to that point and leaves later targets untouched", async () => {
    const state = stateWith({ key: "boom", type: "group", id: 1 }, { key: "later", type: "group", id: 2 });
    const request = vi.fn(async (_m: string, path: string) => {
      if (path === "/groups/1") throw new CtApiError("Server Error", 500, null);
      return {};
    });
    const save = vi.fn(async () => {});
    const prevExit = process.exitCode;

    await runDeleteLoop({ client: asClient(request), state, statePath: "s.json", ordered: ["boom", "later"], save });

    expect(state.resources.boom).toBeDefined();   // not removed — the DELETE failed
    expect(state.resources.later).toBeDefined();  // never reached
    expect(request).toHaveBeenCalledTimes(1);     // stopped at the first target
    expect(save).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });

  it("renders a CtApiError's HTTP status + body in the stop message, via the shared formatter (#71)", async () => {
    const state = stateWith({ key: "boom", type: "group", id: 1 });
    const request = vi.fn(async (_m: string, path: string) => {
      if (path === "/groups/1") throw new CtApiError("DELETE /groups/1 failed", 403, { message: "no permission" });
      return {};
    });
    const save = vi.fn(async () => {});
    const prevExit = process.exitCode;
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runDeleteLoop({ client: asClient(request), state, statePath: "s.json", ordered: ["boom"], save });

    const combined = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(combined).toContain("HTTP 403");
    expect(combined).toContain("no permission");
    errSpy.mockRestore();
    process.exitCode = prevExit;
  });
});

describe("destroyWarnings (#99 review)", () => {
  it("flags a person-status target — the one delete that reaches person records", () => {
    const state = stateWith({ key: "core", type: "person-status", id: 5 });
    const lines = destroyWarnings(state, ["core"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("person-status.core");
    expect(lines[0]).toMatch(/MUTATES every person carrying it/);
  });

  it("stays silent for ordinary master data (and for an unknown key)", () => {
    const state = stateWith({ key: "mainz", type: "campus", id: 1 });
    expect(destroyWarnings(state, ["mainz", "ghost"])).toEqual([]);
  });
});
