import { describe, it, expect } from "vitest";
import { parseTargets, orderDestroy } from "../src/commands/destroy.js";
import { emptyState } from "../src/state/state.js";

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
});
