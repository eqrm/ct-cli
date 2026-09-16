import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderResource } from "../../src/export/hcl.js";
import { renderImports, type ImportTarget } from "../../src/export/imports.js";
import { EXPORTABLE_TYPES, fileForType } from "../../src/export/layout.js";

/**
 * The fixture is SYNTHETIC on purpose. This repo is public, so no live campus,
 * Bereich or status name from a real instance belongs in it. The proof that the
 * export matches a real estate lives where that state already lives — the
 * private config repo — and is run there as part of the migration gate.
 *
 * What the fixture does have to carry is every SHAPE the renderer can trip on:
 * id 0, a key that is not a valid HCL identifier, all five resource types, and
 * every camelCase field that maps to a snake_case attribute.
 */
const STATE = JSON.parse(
  readFileSync(new URL("../fixtures/ct-state.tier0.json", import.meta.url), "utf8"),
) as {
  resources: Record<string, { type: string; key: string; id: number; fields: Record<string, unknown> }>;
};

const rows = Object.values(STATE.resources).filter((r) => EXPORTABLE_TYPES.includes(r.type));

describe("golden export", () => {
  it("covers every exportable resource type", () => {
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(EXPORTABLE_TYPES));
  });

  it("routes each type to its own file", () => {
    expect(new Set(rows.map((r) => fileForType(r.type)))).toEqual(
      new Set([
        "campuses.tf",
        "group-types.tf",
        "departments.tf",
        "person-statuses.tf",
        "comment-viewers.tf",
      ]),
    );
  });

  it("renders a byte-stable set of resource blocks", () => {
    const rendered = rows
      .slice()
      .sort((a, b) => `${a.type}/${a.key}`.localeCompare(`${b.type}/${b.key}`))
      .map((r) => renderResource(r.type, r.key, r.fields))
      .join("\n");
    expect(rendered).toMatchSnapshot();
  });

  it("renders a byte-stable set of import blocks", () => {
    const targets: ImportTarget[] = rows
      .slice()
      .sort((a, b) => `${a.type}/${a.key}`.localeCompare(`${b.type}/${b.key}`))
      .map((r) => ({ type: r.type, key: r.key, id: r.id }));
    expect(renderImports(targets)).toMatchSnapshot();
  });
});
