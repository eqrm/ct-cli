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

  it("derives a key from campus shortName", () => {
    expect(RESOURCES.campus?.deriveKey({ name: "Mainz", shortName: "MZ" })).toBe("mz");
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
