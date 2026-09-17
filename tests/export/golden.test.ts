import { mkdtemp, readdir, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExportTf } from "../../src/application/operations/export-tf.js";
import type { ExportTfResult } from "../../src/application/operations/export-tf.js";

/**
 * The fixture is SYNTHETIC on purpose. This repo is public, so no live campus,
 * Bereich or status name from a real instance belongs in it. The proof that the
 * export matches a real estate lives where that state already lives — the
 * private config repo — and is run there as part of the migration gate.
 *
 * What the fixture does have to carry is every SHAPE the renderer can trip on:
 * id 0, a key that is not a valid HCL identifier, a name carrying an HCL
 * interpolation marker, a destroy-protected resource, a managed type the
 * provider cannot represent yet, all five exportable types, and every camelCase
 * field that maps to a snake_case attribute.
 *
 * It snapshots the files `ct export tf` WRITES, via runExportTf, rather than
 * re-rendering the rows here: a golden that re-implements the pipeline pins its
 * own ordering, not the command's, and the two drifted apart once already.
 */
const FIXTURE = new URL("../fixtures/ct-state.tier0.json", import.meta.url);
const HOST = "https://example.church.tools";

let dir: string;
let result: ExportTfResult;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-golden-"));
  await copyFile(FIXTURE, join(dir, "ct-state.json"));
  vi.stubEnv("CT_HOST", HOST);
  result = await runExportTf({ cwd: dir, statePath: "ct-state.json", outDir: "tofu" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function generated(file: string): Promise<string> {
  return readFile(join(dir, "tofu", file), "utf8");
}

describe("golden export", () => {
  it("writes exactly the files it owns", async () => {
    expect((await readdir(join(dir, "tofu"))).sort()).toEqual([
      "campuses.tf",
      "comment-viewers.tf",
      "departments.tf",
      "group-types.tf",
      "imports.tf",
      "person-statuses.tf",
      "versions.tf",
    ]);
  });

  it("routes each resource to the file named after its type", async () => {
    expect(await generated("campuses.tf")).toContain('resource "churchtools_campus"');
    expect(await generated("campuses.tf")).not.toContain("churchtools_group_type");
    expect(await generated("group-types.tf")).toContain('resource "churchtools_group_type"');
    expect(await generated("departments.tf")).toContain('resource "churchtools_department"');
    expect(await generated("person-statuses.tf")).toContain('resource "churchtools_person_status"');
    expect(await generated("comment-viewers.tf")).toContain('resource "churchtools_comment_viewer"');
  });

  it("reports the relabelled key and the type it cannot export", () => {
    expect(result.value.relabelled).toEqual([{ key: "3_aktiv", label: "g_3_aktiv" }]);
    expect(result.value.skipped).toEqual([{ type: "group", count: 1 }]);
    expect(result.value.imported).toBe(8);
  });

  it("renders byte-stable campuses.tf", async () => {
    expect(await generated("campuses.tf")).toMatchSnapshot();
  });

  it("renders byte-stable group-types.tf", async () => {
    expect(await generated("group-types.tf")).toMatchSnapshot();
  });

  it("renders byte-stable departments.tf", async () => {
    expect(await generated("departments.tf")).toMatchSnapshot();
  });

  it("renders byte-stable person-statuses.tf", async () => {
    expect(await generated("person-statuses.tf")).toMatchSnapshot();
  });

  it("renders byte-stable comment-viewers.tf", async () => {
    expect(await generated("comment-viewers.tf")).toMatchSnapshot();
  });

  it("renders byte-stable imports.tf", async () => {
    expect(await generated("imports.tf")).toMatchSnapshot();
  });

  it("renders byte-stable versions.tf", async () => {
    expect(await generated("versions.tf")).toMatchSnapshot();
  });
});
