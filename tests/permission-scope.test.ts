import { describe, it, expect } from "vitest";
import { resolveScope } from "../src/permissions/scope.js";
import type { State } from "../src/state/state.js";

const state: State = { version: 1, host: "h", resources: {
  kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
  other: { type: "group", id: 7, key: "other", fields: {}, adoptedAt: "t", updatedAt: "t" },
}};

describe("resolveScope", () => {
  it("maps managed group keys to resolutions sorted by id", () => {
    expect(resolveScope(["other", "kids_area"], state)).toEqual([
      { key: "other", id: 7, type: "group" },
      { key: "kids_area", id: 42, type: "group" },
    ]);
  });
  it("resolves a declared-but-not-yet-created group key to a pending (null id) resolution", () => {
    expect(resolveScope(["kids"], state, new Set(["kids"]))).toEqual([{ key: "kids", id: null, type: "group" }]);
  });
  it("orders resolved (in-state, by id) before pending (by key)", () => {
    expect(resolveScope(["pending_b", "kids_area", "pending_a"], state, new Set(["pending_a", "pending_b"]))).toEqual([
      { key: "kids_area", id: 42, type: "group" },
      { key: "pending_a", id: null, type: "group" },
      { key: "pending_b", id: null, type: "group" },
    ]);
  });
  it("throws for a key that is neither in state nor declared", () => {
    expect(() => resolveScope(["nope"], state)).toThrow(/scope key "nope"/i);
  });

  it("passes a raw numeric scope entry through directly, without a state lookup (escape hatch, #49)", () => {
    expect(resolveScope([5, "kids_area"], state)).toEqual([
      { key: "5", id: 5, numeric: true },
      { key: "kids_area", id: 42, type: "group" },
    ]);
  });

  it("sorts numeric and resolved group entries together, ascending by id", () => {
    expect(resolveScope(["kids_area", 3], state)).toEqual([
      { key: "3", id: 3, numeric: true },
      { key: "kids_area", id: 42, type: "group" },
    ]);
  });

  it("rejects a non-integer or below-sentinel numeric scope entry", () => {
    expect(() => resolveScope([-3], state)).toThrow(/numeric scope/i);
    expect(() => resolveScope([1.5], state)).toThrow(/numeric scope/i);
  });

  // 0 is a real dataId on more than one CT dimension — campus "Mainz" is id 0 on eqrm prod — so it
  // must pass through like any other, not be rejected as falsy.
  it("accepts dataId 0 as an ordinary scope entry", () => {
    expect(resolveScope([0], state)).toEqual([{ key: "0", id: 0, numeric: true }]);
  });

  // -1 is ChurchTools' "all values of this dimension" sentinel (e.g. `churchcore:login to external
  // system` granted for every external system). CT reads it back verbatim, so it must survive the
  // round trip unchanged or the grant would churn on every plan.
  it("accepts the -1 ALL sentinel and sorts it first", () => {
    expect(resolveScope([-1], state)).toEqual([{ key: "-1", id: -1, numeric: true }]);
    expect(resolveScope([3, -1], state)).toEqual([
      { key: "-1", id: -1, numeric: true },
      { key: "3", id: 3, numeric: true },
    ]);
  });
});
