import { describe, it, expect } from "vitest";
import { parentIdsByGroupId, managedParentKeys, applyHierarchy } from "../src/engine/hierarchy.js";
import type { DesiredResource } from "../src/engine/types.js";
import type { State, ManagedResource } from "../src/state/state.js";

function group(key: string, id: number): ManagedResource {
  return { type: "group", id, key, fields: { name: key }, adoptedAt: "t", updatedAt: "t" };
}

describe("parentIdsByGroupId", () => {
  it("maps group ids to their parent id lists", () => {
    const map = parentIdsByGroupId([
      { groupId: 1311, parents: [8, 119, 1175], children: [] },
      { groupId: 8, children: [1311] },
    ]);
    expect(map.get(1311)).toEqual([8, 119, 1175]);
    expect(map.get(8)).toEqual([]); // no parents key → empty
  });
});

describe("managedParentKeys", () => {
  it("keeps only managed parents, mapped to keys and sorted", () => {
    const idToKey = new Map([
      [8, "team_kids"],
      [119, "not_relevant"],
    ]);
    // 1175 is unmanaged → dropped; result sorted
    expect(managedParentKeys([1175, 119, 8], idToKey)).toEqual(["not_relevant", "team_kids"]);
  });
});

describe("applyHierarchy", () => {
  const state: State = {
    version: 1,
    host: "h",
    resources: { child: group("child", 1311), parent: group("parent", 8) },
  };

  it("injects actual managed parents and augments opted-in desired groups", () => {
    const actual = new Map<string, Record<string, unknown>>([
      ["child", { name: "child" }],
      ["parent", { name: "parent" }],
    ]);
    const parentIds = new Map([
      [1311, [8, 119, 1175]], // only 8 is managed
      [8, []],
    ]);
    const desired: DesiredResource[] = [
      { type: "group", key: "child", fields: { name: "child" }, parents: ["parent"], dependsOn: ["parent"] },
      { type: "group", key: "parent", fields: { name: "parent" }, dependsOn: [] }, // no opt-in
    ];

    const out = applyHierarchy(desired, state, actual, parentIds);

    expect(actual.get("child")?.parents).toEqual(["parent"]); // 119/1175 unmanaged → dropped
    // "parent" did not opt into hierarchy → its actual is left untouched (no injected pseudo-field).
    expect(actual.get("parent")).not.toHaveProperty("parents");
    expect(out[0]?.fields.parents).toEqual(["parent"]);
    expect(out[1]?.fields.parents).toBeUndefined(); // group that did not opt in is untouched
  });

  it("injects an empty actual.parents for an opted-in group whose managed parents are all gone", () => {
    // A group that opts in (parents: []) but still has a managed parent in CT must see the removal.
    const actual = new Map<string, Record<string, unknown>>([
      ["child", { name: "child" }],
      ["parent", { name: "parent" }],
    ]);
    const parentIds = new Map([[1311, [8]]]); // CT still links child -> parent(8, managed)
    const desired: DesiredResource[] = [
      { type: "group", key: "child", fields: { name: "child" }, parents: [], dependsOn: [] }, // managed-empty
      { type: "group", key: "parent", fields: { name: "parent" }, dependsOn: [] },
    ];

    const out = applyHierarchy(desired, state, actual, parentIds);

    expect(actual.get("child")?.parents).toEqual(["parent"]); // real managed parent surfaced...
    expect(out[0]?.fields.parents).toEqual([]); // ...against a desired of none → diff proposes removal
  });

  it("leaves non-group resources untouched", () => {
    const campusState: State = {
      version: 1,
      host: "h",
      resources: { mz: { type: "campus", id: 0, key: "mz", fields: {}, adoptedAt: "t", updatedAt: "t" } },
    };
    const actual = new Map<string, Record<string, unknown>>([["mz", { name: "Mainz" }]]);
    applyHierarchy([], campusState, actual, new Map());
    expect(actual.get("mz")).not.toHaveProperty("parents");
  });
});
