import { describe, expect, it } from "vitest";
import { RESOURCES } from "../src/resources/registry.js";

describe("generic external registry contract", () => {
  it.each(Object.entries(RESOURCES))(
    "%s supplies identity, display and one unique ref kind",
    (type, spec) => {
      const sample = {
        id: 7,
        name: "Example",
        shorty: "EX",
        groupTypeId: 2,
        information: { groupTypeId: 2, campusId: 3, groupStatusId: 1 },
        sortKey: 4,
        degreeNameA: "A",
        degreeNameB: "B",
        type: "participant",
      };
      expect(spec.external.refKind).toBeTruthy();
      expect(spec.external.identity(sample)).toHaveProperty("name", "Example");
      expect(spec.external.display(sample)).toEqual(expect.any(Object));
      expect(spec.collectionPath).toBeTruthy();
      expect(spec.itemPath(7)).toBeTruthy();
      expect(type).toBeTruthy();
    },
  );

  it("does not maintain two type lists: every registry entry has a distinct logical ref kind", () => {
    const kinds = Object.values(RESOURCES).map((spec) => spec.external.refKind);
    expect(new Set(kinds).size).toBe(Object.keys(RESOURCES).length);
  });

  it.each([
    ["campus", ["name"], ["shorty"]],
    ["group", ["groupTypeId", "name"], ["campusId", "groupStatusId"]],
    ["group-type", ["name"], ["nameTranslated"]],
    ["age-group", ["name"], ["nameTranslated", "sortKey"]],
    ["target-group", ["name"], ["nameTranslated", "sortKey"]],
    ["relationship-type", ["name"], ["degreeNameA", "degreeNameB"]],
    ["person-status", ["name"], ["isMember", "shorty"]],
    ["department", ["name"], ["shorty"]],
    ["security-level", ["name"], ["level"]],
    ["comment-viewer", ["name"], ["sortKey"]],
    ["group-role", ["groupTypeId", "name"], ["type"]],
  ] as const)("%s pins the issue-defined hard/display identity boundary", (type, hard, display) => {
    const sample = {
      id: 7,
      name: "Example",
      shorty: "EX",
      nameTranslated: "Example translated",
      groupTypeId: 2,
      information: { groupTypeId: 2, campusId: 3, groupStatusId: 1 },
      campusId: 3,
      groupStatusId: 1,
      sortKey: 4,
      degreeNameA: "Parent",
      degreeNameB: "Child",
      isMember: true,
      type: "participant",
    };
    expect(Object.keys(RESOURCES[type]!.external.identity(sample)).sort()).toEqual([...hard].sort());
    expect(Object.keys(RESOURCES[type]!.external.display(sample)).sort()).toEqual([...display].sort());
  });
});
