import { describe, expect, it } from "vitest";
import { assertLabelsUnique, hclLabel, hclString, renderResource } from "../../src/export/hcl.js";
import { renderImports } from "../../src/export/imports.js";

describe("hclLabel", () => {
  it("passes through identifier-safe keys", () => {
    expect(hclLabel("team_musik")).toBe("team_musik");
  });

  it("prefixes keys starting with a digit", () => {
    expect(hclLabel("3_groupactive")).toBe("g_3_groupactive");
  });

  it("replaces characters HCL cannot reference", () => {
    expect(hclLabel("standort.kids")).toBe("standort_kids");
  });
});

describe("renderResource", () => {
  it("renders a campus block with quoted strings", () => {
    expect(renderResource("campus", "hauptstandort", { name: "Hauptstandort", shorty: "HS" })).toBe(
      [
        'resource "churchtools_campus" "hauptstandort" {',
        '  name   = "Hauptstandort"',
        '  shorty = "HS"',
        "}",
        "",
      ].join("\n"),
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
  it("keeps id 0 — a real, importable campus id", () => {
    expect(renderImports([{ type: "campus", key: "hauptstandort", id: 0 }])).toBe(
      ["import {", "  to = churchtools_campus.hauptstandort", '  id = "0"', "}", ""].join("\n"),
    );
  });

  it("uses the relabelled identifier in the import address", () => {
    expect(renderImports([{ type: "group-type", key: "3_groupactive", id: 12 }])).toContain(
      "to = churchtools_group_type.g_3_groupactive",
    );
  });
});

describe("hclString", () => {
  it("doubles the HCL interpolation sigils a JSON escape leaves alone", () => {
    // `${` would otherwise be parsed as a template interpolation, not a name.
    expect(hclString("Campus ${var.x}")).toBe('"Campus $${var.x}"');
    expect(hclString("100%{if}")).toBe('"100%%{if}"');
    expect(hclString('a "quoted" name')).toBe('"a \\"quoted\\" name"');
  });
});

describe("assertLabelsUnique", () => {
  it("names both keys when two collapse onto one address", () => {
    expect(() =>
      assertLabelsUnique([
        { type: "campus", key: "standort.kids" },
        { type: "campus", key: "standort_kids" },
      ]),
    ).toThrow(/"standort.kids" and "standort_kids" both render as churchtools_campus.standort_kids/);
  });

  it("allows the same label under different resource types", () => {
    expect(() =>
      assertLabelsUnique([
        { type: "campus", key: "team" },
        { type: "group-type", key: "team" },
      ]),
    ).not.toThrow();
  });
});

describe("renderResource lifecycle", () => {
  it("mirrors destroy protection into the generated block", () => {
    expect(renderResource("campus", "a", { name: "A" }, { preventDestroy: true })).toBe(
      [
        'resource "churchtools_campus" "a" {',
        '  name = "A"',
        "",
        "  lifecycle {",
        "    prevent_destroy = true",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("emits no lifecycle block for an unprotected resource", () => {
    expect(renderResource("campus", "a", { name: "A" })).not.toContain("lifecycle");
  });
});
