import { describe, expect, it } from "vitest";
import { hclLabel, renderResource } from "../../src/export/hcl.js";
import { renderImports } from "../../src/export/imports.js";

describe("hclLabel", () => {
  it("passes through identifier-safe keys", () => {
    expect(hclLabel("team_kidsdienst")).toBe("team_kidsdienst");
  });

  it("prefixes keys starting with a digit", () => {
    expect(hclLabel("3_groupactive")).toBe("g_3_groupactive");
  });

  it("replaces characters HCL cannot reference", () => {
    expect(hclLabel("mainz.kids")).toBe("mainz_kids");
  });
});

describe("renderResource", () => {
  it("renders a campus block with quoted strings", () => {
    expect(renderResource("campus", "mainz", { name: "Mainz", shorty: "MZ" })).toBe(
      ['resource "churchtools_campus" "mainz" {', '  name   = "Mainz"', '  shorty = "MZ"', "}", ""].join(
        "\n",
      ),
    );
  });

  it("omits null and undefined fields rather than emitting null", () => {
    expect(renderResource("campus", "x", { name: "X", shorty: null })).toBe(
      ['resource "churchtools_campus" "x" {', '  name = "X"', "}", ""].join("\n"),
    );
  });

  it("snake_cases the CT field names the provider exposes", () => {
    expect(
      renderResource("person-status", "mitglied", {
        name: "Mitglied",
        shorty: "M",
        isMember: true,
        isSearchable: true,
        sortKey: 10,
        securityLevelId: 1,
      }),
    ).toContain("is_member         = true");
  });

  it("renders group-type as churchtools_group_type", () => {
    expect(renderResource("group-type", "team", { name: "Team", nameTranslated: "Team" })).toContain(
      'resource "churchtools_group_type" "team" {',
    );
  });

  it("refuses a resource type it has no Terraform mapping for", () => {
    expect(() => renderResource("group-role", "x", { name: "X" })).toThrow(/no Terraform resource type/);
  });
});

describe("renderImports", () => {
  it("keeps id 0 — the Mainz campus", () => {
    expect(renderImports([{ type: "campus", key: "mainz", id: 0 }])).toBe(
      ["import {", "  to = churchtools_campus.mainz", '  id = "0"', "}", ""].join("\n"),
    );
  });

  it("uses the relabelled identifier in the import address", () => {
    expect(renderImports([{ type: "group-type", key: "3_groupactive", id: 12 }])).toContain(
      "to = churchtools_group_type.g_3_groupactive",
    );
  });
});
