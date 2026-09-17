import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExportTf } from "../../src/application/operations/export-tf.js";

const HOST = "https://example.church.tools";

interface Row {
  type: string;
  key: string;
  id: number;
  fields: Record<string, unknown>;
  preventDestroy?: boolean;
}

let dir: string;

async function stateWith(rows: Record<string, Row>): Promise<string> {
  const path = join(dir, "ct-state.json");
  await writeFile(
    path,
    JSON.stringify({ version: 1, host: HOST, resources: rows, permissions: {} }, null, 2),
    "utf8",
  );
  return path;
}

function row(type: string, key: string, id: number, fields: Record<string, unknown> = {}): Row {
  return { type, key, id, fields: { name: key, ...fields } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-export-"));
  vi.stubEnv("CT_HOST", HOST);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function exportInto(rows: Record<string, Row>, only?: string[]) {
  await stateWith(rows);
  return runExportTf({ cwd: dir, statePath: "ct-state.json", outDir: "tofu", only });
}

describe("runExportTf", () => {
  it("warns about managed types the provider cannot represent yet", async () => {
    const result = await exportInto({
      a: row("campus", "a", 1),
      jugend: row("group", "jugend", 99),
      leitung: row("group-role", "leitung", 5),
      musik: row("group", "musik", 100),
    });

    expect(result.value.skipped).toEqual([
      { type: "group", count: 2 },
      { type: "group-role", count: 1 },
    ]);
    const message = result.warnings.map((w) => w.message).join("\n");
    expect(result.warnings.map((w) => w.code)).toEqual([
      "EXPORT_TYPE_UNSUPPORTED",
      "EXPORT_TYPE_UNSUPPORTED",
    ]);
    expect(message).toContain("2 group resource(s) were NOT exported");
    expect(message).toContain("1 group-role resource(s) were NOT exported");
    // The export still runs: the mapped types are exported, not held hostage.
    expect(result.value.imported).toBe(1);
  });

  it("says nothing about types the user filtered out on purpose", async () => {
    const result = await exportInto({ a: row("campus", "a", 1), t: row("group-type", "t", 2) }, ["campus"]);
    expect(result.warnings).toEqual([]);
    expect(result.value.skipped).toEqual([]);
    expect(result.value.imported).toBe(1);
  });

  it("refuses an --only type it cannot export instead of writing an empty imports.tf", async () => {
    await expect(exportInto({ a: row("campus", "a", 1) }, ["campuses"])).rejects.toThrow(
      /unknown resource type\(s\) "campuses"/,
    );
  });

  it("orders imports.tf exactly like the resource blocks, whatever order state is in", async () => {
    const forwards = await exportInto({
      b: row("campus", "b", 7),
      a: row("campus", "a", 0),
      t: row("group-type", "t", 11),
    });
    const first = await readFile(join(dir, "tofu", "imports.tf"), "utf8");
    const firstCampuses = await readFile(join(dir, "tofu", "campuses.tf"), "utf8");
    expect(forwards.value.imported).toBe(3);

    // Same resources, state object in a different (re-keyed) order.
    const again = await exportInto({
      t: row("group-type", "t", 11),
      a: row("campus", "a", 0),
      b: row("campus", "b", 7),
    });
    expect(again.value.imported).toBe(3);
    expect(await readFile(join(dir, "tofu", "imports.tf"), "utf8")).toBe(first);
    expect(await readFile(join(dir, "tofu", "campuses.tf"), "utf8")).toBe(firstCampuses);

    expect(first.indexOf("churchtools_campus.a")).toBeLessThan(first.indexOf("churchtools_campus.b"));
    expect(first.indexOf("churchtools_campus.b")).toBeLessThan(first.indexOf("churchtools_group_type.t"));
  });

  it("keeps id 0 importable", async () => {
    await exportInto({ a: row("campus", "a", 0) });
    expect(await readFile(join(dir, "tofu", "imports.tf"), "utf8")).toContain('id = "0"');
  });

  it("prunes the files it owns but did not write this run", async () => {
    await exportInto({ a: row("campus", "a", 1), t: row("group-type", "t", 2) });
    expect(await readdir(join(dir, "tofu"))).toContain("group-types.tf");

    const narrowed = await exportInto({ a: row("campus", "a", 1), t: row("group-type", "t", 2) }, ["campus"]);
    const left = await readdir(join(dir, "tofu"));
    expect(left).not.toContain("group-types.tf");
    expect(left.sort()).toEqual(["campuses.tf", "imports.tf", "versions.tf"]);
    expect(narrowed.value.files).not.toContain("group-types.tf");
  });

  it("never touches a file it does not own", async () => {
    await exportInto({ a: row("campus", "a", 1) });
    await writeFile(join(dir, "tofu", "main.tf"), "# hand written\n", "utf8");
    await exportInto({ a: row("campus", "a", 1) });
    expect(await readFile(join(dir, "tofu", "main.tf"), "utf8")).toBe("# hand written\n");
  });

  it("writes a provider requirement so the output directory is a runnable root module", async () => {
    const result = await exportInto({ a: row("campus", "a", 1) });
    expect(result.value.files).toContain("versions.tf");
    const versions = await readFile(join(dir, "tofu", "versions.tf"), "utf8");
    expect(versions).toContain("required_providers");
    expect(versions).toContain('source = "eqrm/churchtools"');
  });

  it("carries destroy protection across instead of silently dropping it", async () => {
    await exportInto({
      a: { ...row("campus", "a", 1), preventDestroy: true },
      b: row("campus", "b", 2),
    });
    const campuses = await readFile(join(dir, "tofu", "campuses.tf"), "utf8");
    expect(campuses).toContain("prevent_destroy = true");
    expect(campuses.split("prevent_destroy").length - 1).toBe(1);
  });

  it("refuses two keys that would share one HCL address", async () => {
    await expect(
      exportInto({ x: row("campus", "mainz.kids", 1), y: row("campus", "mainz_kids", 2) }),
    ).rejects.toThrow(/both render as churchtools_campus\.mainz_kids/);
  });

  it("escapes HCL interpolation markers in exported names", async () => {
    await exportInto({ a: row("campus", "a", 1, { name: "Campus ${var.x}" }) });
    expect(await readFile(join(dir, "tofu", "campuses.tf"), "utf8")).toContain('"Campus $${var.x}"');
  });
});
