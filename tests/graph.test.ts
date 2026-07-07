import { describe, it, expect } from "vitest";
import { orderKeys, tierOf } from "../src/engine/graph.js";
import type { DesiredResource } from "../src/engine/types.js";

function res(type: string, key: string, deps: string[] = [], parent?: string): DesiredResource {
  return { type, key, fields: {}, parent, dependsOn: parent ? [...deps, parent] : deps };
}

describe("tierOf", () => {
  it("ranks metadata below groups below the things that reference groups", () => {
    expect(tierOf("campus")).toBeLessThan(tierOf("group"));
    expect(tierOf("group")).toBeLessThan(tierOf("group-hierarchy"));
    expect(tierOf("permission")).toBeLessThan(tierOf("dynamic-group"));
    expect(tierOf("unknown")).toBe(0);
  });
});

describe("orderKeys", () => {
  it("puts metadata before groups even without explicit edges", () => {
    const order = orderKeys([res("group", "team"), res("campus", "mainz"), res("group-type", "lead")]);
    expect(order.indexOf("mainz")).toBeLessThan(order.indexOf("team"));
    expect(order.indexOf("lead")).toBeLessThan(order.indexOf("team"));
  });

  it("orders parents before children regardless of declaration order", () => {
    const order = orderKeys([res("group", "child", [], "parent"), res("group", "parent")]);
    expect(order).toEqual(["parent", "child"]);
  });

  it("orders a permission after the group it depends on", () => {
    const order = orderKeys([res("permission", "perm", ["team"]), res("group", "team")]);
    expect(order).toEqual(["team", "perm"]);
  });

  it("ignores dependencies outside the managed set", () => {
    expect(orderKeys([res("group", "team", ["nonexistent"])])).toEqual(["team"]);
  });

  it("throws on a dependency cycle", () => {
    expect(() => orderKeys([res("group", "a", ["b"]), res("group", "b", ["a"])])).toThrow(/cycle/i);
  });
});
