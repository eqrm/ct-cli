import { describe, it, expect } from "vitest";
import { slug, resourceType, configSnippet, RESOURCES } from "../src/resources/registry.js";

describe("slug", () => {
  it("normalises names to underscore keys", () => {
    expect(slug("Kids Leitung")).toBe("kids_leitung");
    expect(slug("Kids 0–3")).toBe("kids_0_3");
    expect(slug("  MZ  ")).toBe("mz");
  });

  it("strips German diacritics to their base letters instead of adding underscores", () => {
    expect(slug("Zürich")).toBe("zurich");
    expect(slug("Jugendküche")).toBe("jugendkuche");
    expect(slug("Gebärdensprache")).toBe("gebardensprache");
  });
});

describe("resourceType", () => {
  it("returns the campus spec with the right item path", () => {
    expect(resourceType("campus").itemPath(0)).toBe("/campuses/0");
  });

  it("builds the group-type item path from its collection path", () => {
    expect(resourceType("group-type").itemPath(7)).toBe("/group/grouptypes/7");
  });

  it("throws for an unknown type, listing the known ones", () => {
    expect(() => resourceType("nope")).toThrow(/Adoptable types/);
  });

  it("derives a key from campus shorty", () => {
    expect(RESOURCES.campus?.deriveKey({ name: "Mainz", shorty: "MZ" })).toBe("mz");
  });

  it("snapshots group ids whether they are nested under information or top-level", () => {
    expect(
      RESOURCES.group?.managedFields({ name: "Team", information: { groupTypeId: 2, groupStatusId: 1 } }),
    ).toEqual({ name: "Team", groupTypeId: 2, groupStatusId: 1 });
    expect(RESOURCES.group?.managedFields({ name: "Team", groupTypeId: 2, groupStatusId: 1 })).toEqual({
      name: "Team",
      groupTypeId: 2,
      groupStatusId: 1,
    });
  });
});

describe("configSnippet", () => {
  it("renders a TS-as-code call with the logical key first", () => {
    expect(configSnippet("campus", "mainz", { name: "Mainz", shortName: "MZ" })).toBe(
      'campus({ key: "mainz", name: "Mainz", shortName: "MZ" });',
    );
  });

  it("camelCases a hyphenated type into the function name", () => {
    expect(configSnippet("group-type", "commitment", { name: "Commitment" })).toBe(
      'groupType({ key: "commitment", name: "Commitment" });',
    );
  });

  it("omits undefined fields", () => {
    expect(configSnippet("group", "team", { name: "Team", groupTypeId: undefined })).toBe(
      'group({ key: "team", name: "Team" });',
    );
  });
});

describe("write specs", () => {
  it("campus creates via POST /campuses and updates via PUT", () => {
    expect(RESOURCES.campus?.collectionPath).toBe("/campuses");
    expect(RESOURCES.campus?.updateMethod).toBe("PUT");
  });

  it("group updates via PATCH", () => {
    expect(RESOURCES.group?.collectionPath).toBe("/groups");
    expect(RESOURCES.group?.updateMethod).toBe("PATCH");
  });

  it("registers the new writable types with their collection + item paths", () => {
    expect(RESOURCES["age-group"]?.collectionPath).toBe("/group/agegroups");
    expect(RESOURCES["target-group"]?.collectionPath).toBe("/group/targetgroups");
    expect(RESOURCES["relationship-type"]?.collectionPath).toBe("/person/relationshiptypes");
    expect(RESOURCES["group-role"]?.collectionPath).toBe("/group/roles");
    expect(RESOURCES["age-group"]?.itemPath(3)).toBe("/group/agegroups/3");
  });

  // Field sets verified live against eqrm.church.tools (2026-07-08).
  it("snapshots real relationship-type degree fields (degreeNameA/B, not degreeForward/Reverse)", () => {
    const raw = {
      name: "relationship.couple",
      nameTranslated: "Couple",
      degreeNameA: "spouse",
      degreeNameB: "spouse",
      securityLevelId: 1,
    };
    expect(RESOURCES["relationship-type"]?.managedFields(raw)).toEqual({
      name: "relationship.couple",
      nameTranslated: "Couple",
      degreeNameA: "spouse",
      degreeNameB: "spouse",
    });
  });

  it("snapshots age-group / group-role fields that exist on the live payload", () => {
    expect(
      RESOURCES["age-group"]?.managedFields({ name: "NextGen", nameTranslated: "NextGen", sortKey: 8 }),
    ).toEqual({ name: "NextGen", nameTranslated: "NextGen", sortKey: 8 });
    expect(
      RESOURCES["group-role"]?.managedFields({ name: "Mitglied", nameTranslated: "Mitglied", groupTypeId: 2 }),
    ).toEqual({ name: "Mitglied", nameTranslated: "Mitglied", groupTypeId: 2 });
  });
});
