import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExportTf } from "../../src/application/operations/export-tf.js";
import { writeIdMap } from "../../src/resolve/idMap.js";

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

async function exportKeepingVersions(rows: Record<string, Row>) {
  await stateWith(rows);
  return runExportTf({ cwd: dir, statePath: "ct-state.json", outDir: "tofu", writeVersions: false });
}

describe("runExportTf", () => {
  it("warns about managed types the provider cannot represent yet", async () => {
    const result = await exportInto({
      a: row("campus", "a", 1),
      jugend: row("age-group", "jugend", 99),
      leitung: row("group-role", "leitung", 5),
      musik: row("age-group", "musik", 100),
    });

    expect(result.value.skipped).toEqual([
      { type: "age-group", count: 2 },
      { type: "group-role", count: 1 },
    ]);
    const message = result.warnings.map((w) => w.message).join("\n");
    expect(result.warnings.map((w) => w.code)).toEqual([
      "EXPORT_TYPE_UNSUPPORTED",
      "EXPORT_TYPE_UNSUPPORTED",
    ]);
    expect(message).toContain("2 age-group resource(s) were NOT exported");
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

  it("leaves the file of a type it did not export alone", async () => {
    await exportInto({ a: row("campus", "a", 1), t: row("group-type", "t", 2) });
    const before = await readFile(join(dir, "tofu", "group-types.tf"), "utf8");

    // --only campus, and a type that has left ct's state entirely (tier 0 after its cutover): both
    // mean "tofu owns this file now". Deleting it would plan the destroy of every group type (#109).
    const narrowed = await exportInto({ a: row("campus", "a", 1), t: row("group-type", "t", 2) }, ["campus"]);
    expect(narrowed.value.files).not.toContain("group-types.tf");
    await exportInto({ a: row("campus", "a", 1) });
    expect(await readFile(join(dir, "tofu", "group-types.tf"), "utf8")).toBe(before);
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

/**
 * `versions.tf` is generated so the output is a runnable root module, which is
 * right by default. But it is also the only file a consumer has a legitimate
 * reason to own: a provider VERSION CONSTRAINT lives inside
 * `required_providers`, and there is nowhere else to put one. Owning the file
 * unconditionally therefore made pinning impossible — while the generated
 * file's own comment says pinning belongs in the consumer's repo.
 */
describe("writeVersions: false", () => {
  it("does not write versions.tf", async () => {
    await exportKeepingVersions({ mainz: row("campus", "mainz", 0, { shorty: "MZ" }) });
    const files = await readdir(join(dir, "tofu"));
    expect(files).not.toContain("versions.tf");
  });

  it("leaves an existing versions.tf untouched rather than pruning it", async () => {
    const pinned = [
      "terraform {",
      "  required_providers {",
      '    churchtools = { source = "eqrm/churchtools", version = "~> 0.1" }',
      "  }",
      "}",
      "",
    ].join("\n");
    await stateWith({ mainz: row("campus", "mainz", 0, { shorty: "MZ" }) });
    const outDir = join(dir, "tofu");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "versions.tf"), pinned, "utf8");

    await runExportTf({ cwd: dir, statePath: "ct-state.json", outDir: "tofu", writeVersions: false });

    // The consumer's pin must survive: deleting it would be worse than
    // overwriting it, because nothing would hint at why.
    expect(await readFile(join(outDir, "versions.tf"), "utf8")).toBe(pinned);
  });

  it("does not report versions.tf among the written files", async () => {
    const result = await exportKeepingVersions({ mainz: row("campus", "mainz", 0, { shorty: "MZ" }) });
    expect(result.value.files).not.toContain("versions.tf");
  });

  it("still writes it by default", async () => {
    await exportInto({ mainz: row("campus", "mainz", 0, { shorty: "MZ" }) });
    const files = await readdir(join(dir, "tofu"));
    expect(files).toContain("versions.tf");
  });
});

/**
 * The id map written beside the export (#181): the same key→id table, for ct's own resolution once
 * these resources leave its state. Written under `.ct/`, not into the tofu root module — it is ct's
 * input, not part of what tofu reads.
 */
describe("runExportTf — the id map", () => {
  it("writes one entry per exported resource, keyed by host", async () => {
    const result = await exportInto({
      mainz: row("campus", "mainz", 0),
      struktur: row("group-type", "struktur", 9),
      leitung: row("group-role", "leitung", 99), // not exportable → not in the map either
    });
    expect(result.value.idMapPath).toBe(join(dir, ".ct", "ids.example.church.tools.json"));
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map.campus).toEqual({ mainz: { id: 0 } });
    expect(map["group-type"]).toEqual({ struktur: { id: 9 } });
    expect(map["group-role"]).toBeUndefined();
    expect(map.$meta).toMatchObject({ host: HOST, source: "ct export tf", entries: 2 });
  });

  it("records the HCL relabelling, which cannot be inverted by rule", async () => {
    const result = await exportInto({ "3_active": row("group-type", "3_active", 4) });
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map["group-type"]).toEqual({ "3_active": { id: 4, label: "g_3_active" } });
  });

  // A partial export describes the types it was asked for, but the map it writes is the whole file.
  // Rewriting it from one run's entries dropped every id the previous export put there — and a
  // `personStatus: "status_unbekannt"` reference cannot fall back to the live name (the key is not
  // name-derived), so the next `ct plan` hard-errors on a map the operator never meant to shrink.
  it("carries over the types a --only export never looked at", async () => {
    const rows = {
      mainz: row("campus", "mainz", 4),
      status_unbekannt: row("person-status", "status_unbekannt", 9),
    };
    await exportInto(rows);
    const result = await exportInto(rows, ["campus"]);
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map.campus).toEqual({ mainz: { id: 4 } });
    expect(map["person-status"]).toEqual({ status_unbekannt: { id: 9 } });
    expect(map.$meta).toMatchObject({ entries: 2 });
  });

  // The export upserts and never drops: one campus back in ct's state after the cutover (an adopt,
  // a straggler on one host) must not wipe the tofu-owned rest of the type. Pruning dead ids is
  // `ct ids sync --tofu-state`'s job.
  it("keeps the other entries of a type when only one of them is back in state", async () => {
    await exportInto({
      mainz: row("campus", "mainz", 4),
      horgen: row("campus", "horgen", 5),
      status_unbekannt: row("person-status", "status_unbekannt", 9),
    });
    const result = await exportInto({ mainz: row("campus", "mainz", 4) }, ["campus"]);
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map.campus).toEqual({ mainz: { id: 4 }, horgen: { id: 5 } });
    expect(map["person-status"]).toEqual({ status_unbekannt: { id: 9 } });
  });

  it("replaces an entry whose key now has another id, and an id now under another key", async () => {
    await exportInto({ a: row("campus", "a", 4), b: row("campus", "b", 5) });
    const result = await exportInto({ a: row("campus", "a", 6), c: row("campus", "c", 5) });
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map.campus).toEqual({ a: { id: 6 }, c: { id: 5 } });
  });

  // The end state the map exists to serve: tier-0 has left ct.config.ts AND ct-state.<env>.json, so
  // a full `ct export tf` (a `make export`, a CI regen, a second env) selects every type, finds
  // nothing, and would write `entries: 0` over the only thing still resolving every leftover
  // `campus:` / `personStatus:` reference. An export that exported nothing has learned nothing.
  it("never empties a populated map, however complete the export", async () => {
    await exportInto({
      mainz: row("campus", "mainz", 4),
      status_unbekannt: row("person-status", "status_unbekannt", 9),
    });
    const result = await exportInto({});
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map.campus).toEqual({ mainz: { id: 4 } });
    expect(map["person-status"]).toEqual({ status_unbekannt: { id: 9 } });
    expect(result.warnings.map((w) => w.code)).toContain("IDS_KEPT");
  });

  it("still writes an empty map when there was nothing to keep", async () => {
    const result = await exportInto({});
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map.$meta).toMatchObject({ entries: 0 });
    expect(result.warnings.map((w) => w.code)).not.toContain("IDS_KEPT");
  });

  it("writes nothing under .ct when --no-ids is passed", async () => {
    await stateWith({ mainz: row("campus", "mainz", 0) });
    const result = await runExportTf({
      cwd: dir,
      statePath: "ct-state.json",
      outDir: "tofu",
      writeIds: false,
    });
    expect(result.value.idMapPath).toBeNull();
    await expect(readdir(join(dir, ".ct"))).rejects.toThrow(/ENOENT/);
  });
});

/**
 * Groups (tier 1) point at tier-0 resources by id. One `tofu/` directory serves both hosts and those
 * ids differ between them, so the export writes a reference to the tofu address, never the number.
 */
describe("runExportTf — groups", () => {
  function group(key: string, id: number, fields: Record<string, unknown>): Row {
    return { type: "group", key, id, fields: { name: key, groupStatusId: 1, ...fields } };
  }

  async function seedIdMap(entries: { type: string; key: string; id: number; label?: string }[]) {
    await writeIdMap(HOST, entries, join(dir, ".ct"));
  }

  it("resolves a reference through the id map once tier 0 has left ct's state", async () => {
    await seedIdMap([
      { type: "campus", key: "nord", id: 0 },
      { type: "group-type", key: "3_dienst", id: 4 },
    ]);
    await exportInto({ jugend: group("jugend", 99, { groupTypeId: 4, campusId: 0 }) });
    const groups = await readFile(join(dir, "tofu", "groups.tf"), "utf8");
    expect(groups).toContain("campus_id       = churchtools_campus.nord.id");
    // The address uses the exporter's label, which is what tier 0 was exported under.
    expect(groups).toContain("group_type_id   = churchtools_group_type.g_3_dienst.id");
  });

  it("refuses an id it cannot place instead of writing the number", async () => {
    await seedIdMap([{ type: "group-type", key: "dienst", id: 4 }]);
    await expect(
      exportInto({ jugend: group("jugend", 99, { groupTypeId: 4, campusId: 6 }) }),
    ).rejects.toThrow(/group "jugend": campusId = 6 \(campus\)/);
    await expect(readdir(join(dir, "tofu"))).rejects.toThrow(/ENOENT/);
  });

  it("uses the label the id map recorded as the address", async () => {
    await seedIdMap([
      { type: "campus", key: "nord", id: 0, label: "standort_nord" },
      { type: "group-type", key: "dienst", id: 4 },
    ]);
    await exportInto({ jugend: group("jugend", 99, { groupTypeId: 4, campusId: 0 }) });
    expect(await readFile(join(dir, "tofu", "groups.tf"), "utf8")).toContain(
      "churchtools_campus.standort_nord.id",
    );
  });

  it("refuses a reference that is not a number rather than writing it as a literal", async () => {
    await seedIdMap([{ type: "group-type", key: "dienst", id: 4 }]);
    await expect(exportInto({ jugend: group("jugend", 99, { groupTypeId: "4" }) })).rejects.toThrow(
      /groupTypeId = "4" is not a numeric id/,
    );
  });

  it("omits a campus that is null, and names the groups whose campus ct never recorded", async () => {
    await seedIdMap([{ type: "group-type", key: "dienst", id: 4 }]);
    const result = await exportInto({
      ohne: group("ohne", 98, { groupTypeId: 4, campusId: null }),
      alt: group("alt", 97, { groupTypeId: 4 }),
    });
    const groups = await readFile(join(dir, "tofu", "groups.tf"), "utf8");
    expect(groups).not.toContain("campus_id");
    const unknown = result.warnings.find((w) => w.code === "EXPORT_CAMPUS_UNKNOWN");
    expect(unknown?.details).toEqual({ keys: ["alt"] });
  });

  // The regression the tier-1 cutover would have hit: a FULL export now finds groups, so it is no
  // longer "empty" — and rewriting every selected type from this run's rows would drop every tier-0
  // id from the map, the only thing still resolving `campus: "nord"` in ct.config.ts.
  it("keeps the tier-0 ids in the map when a full export finds only groups", async () => {
    await seedIdMap([
      { type: "campus", key: "nord", id: 0 },
      { type: "group-type", key: "dienst", id: 4 },
    ]);
    const result = await exportInto({ jugend: group("jugend", 99, { groupTypeId: 4, campusId: 0 }) });
    const map = JSON.parse(await readFile(result.value.idMapPath!, "utf8"));
    expect(map.campus).toEqual({ nord: { id: 0 } });
    expect(map["group-type"]).toEqual({ dienst: { id: 4 } });
    expect(map.group).toEqual({ jugend: { id: 99 } });
  });
});

/**
 * A resource that keeps its id but gets a new key gets a new HCL address. Without a `moved` block,
 * tofu plans to destroy the old address (#199).
 */
describe("runExportTf — re-keyed resources", () => {
  it("writes a moved block from the label the id map recorded, and keeps the import", async () => {
    await exportInto({ jugend: row("group", "jugend", 99, { groupStatusId: 1 }) });
    const result = await exportInto({ jugend_nord: row("group", "jugend_nord", 99, { groupStatusId: 1 }) });

    expect(result.value.moved).toEqual([{ type: "group", from: "jugend", to: "jugend_nord" }]);
    const imports = await readFile(join(dir, "tofu", "imports.tf"), "utf8");
    expect(imports).toBe(
      [
        "moved {",
        "  from = churchtools_group.jugend",
        "  to   = churchtools_group.jugend_nord",
        "}",
        "",
        "import {",
        "  to = churchtools_group.jugend_nord",
        '  id = "99"',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("moves from the recorded label, not one re-derived from the old key", async () => {
    await writeIdMap(
      HOST,
      [{ type: "campus", key: "3_nord", id: 0, label: "standort_nord" }],
      join(dir, ".ct"),
    );
    const result = await exportInto({ nord: row("campus", "nord", 0) });
    expect(result.value.moved).toEqual([{ type: "campus", from: "standort_nord", to: "nord" }]);
  });

  it("writes no moved block when the label is unchanged or the id is new", async () => {
    await exportInto({ a: row("campus", "a", 1) });
    const result = await exportInto({ a: row("campus", "a", 1), b: row("campus", "b", 2) });
    expect(result.value.moved).toEqual([]);
    expect(await readFile(join(dir, "tofu", "imports.tf"), "utf8")).not.toContain("moved");
  });

  it("does not take an id of another type for a move", async () => {
    await exportInto({ a: row("campus", "a", 7) });
    const result = await exportInto({ a: row("campus", "a", 7), t: row("group-type", "t", 7) });
    expect(result.value.moved).toEqual([]);
  });
});
