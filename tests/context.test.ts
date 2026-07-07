import { describe, it, expect } from "vitest";
import { createContext, evaluateConfig } from "../src/config/context.js";
import { isKnownType } from "../src/engine/graph.js";

describe("config context", () => {
  it("builds desired resources from DSL calls, separating key/parent from fields", () => {
    const { ct, resources } = createContext();
    ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });
    ct.group({ key: "kids", name: "Kids", parent: "mainz", groupTypeId: 3 });

    expect(resources[0]).toEqual({
      type: "campus",
      key: "mainz",
      fields: { name: "Mainz", shortName: "MZ" },
      parent: undefined,
      dependsOn: [],
    });
    expect(resources[1]).toMatchObject({
      type: "group",
      key: "kids",
      fields: { name: "Kids", groupTypeId: 3 },
      parent: "mainz",
      dependsOn: ["mainz"],
    });
  });

  it("merges explicit dependsOn with the parent edge", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "Team", parent: "lead", dependsOn: ["type_x"] });
    expect(resources[0]?.dependsOn).toEqual(["type_x", "lead"]);
  });

  it("captures multiple parents (hierarchy is a DAG) as an opt-in set, not in fields", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "Team", parents: ["area_a", "area_b"] });
    expect(resources[0]?.parents).toEqual(["area_a", "area_b"]);
    expect(resources[0]?.dependsOn).toEqual(["area_a", "area_b"]);
    expect(resources[0]?.fields).not.toHaveProperty("parents");
  });

  it("treats parents as opt-in: omitted → undefined, explicit [] → managed-empty", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "no_hierarchy", name: "N" });
    ct.group({ key: "empty_hierarchy", name: "E", parents: [] });
    expect(resources[0]?.parents).toBeUndefined();
    expect(resources[1]?.parents).toEqual([]);
  });

  it("de-duplicates parent + parents", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "T", parent: "lead", parents: ["lead", "other"] });
    expect(resources[0]?.parents).toEqual(["lead", "other"]);
  });

  it("rejects a duplicate logical key", () => {
    const { ct } = createContext();
    ct.campus({ key: "mainz", name: "A" });
    expect(() => ct.campus({ key: "mainz", name: "B" })).toThrow(/Duplicate/);
  });

  it("rejects a missing key", () => {
    const { ct } = createContext();
    expect(() => ct.campus({ name: "no key" } as never)).toThrow(/key/);
  });

  it("every DSL resource type has an apply tier (context and graph stay in sync)", () => {
    const { ct, resources } = createContext();
    ct.campus({ key: "a", name: "a" });
    ct.group({ key: "b", name: "b" });
    ct.groupType({ key: "c", name: "c" });
    ct.ageGroup({ key: "d", name: "d" });
    ct.targetGroup({ key: "e", name: "e" });
    ct.relationshipType({ key: "f", name: "f" });
    for (const r of resources) {
      expect(isKnownType(r.type), `type "${r.type}" is missing from TYPE_TIER`).toBe(true);
    }
  });

  it("evaluateConfig runs a module against a fresh context (blueprints + loops)", async () => {
    const resources = await evaluateConfig((ct) => {
      for (const c of ["mainz", "berlin"]) {
        ct.campus({ key: c, name: c });
        ct.group({ key: `${c}_kids`, name: `${c} kids`, parent: c });
      }
    });
    expect(resources.map((r) => r.key)).toEqual(["mainz", "mainz_kids", "berlin", "berlin_kids"]);
  });
});
