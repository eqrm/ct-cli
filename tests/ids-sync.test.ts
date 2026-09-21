/**
 * `ct ids sync` — refreshing the id map from OpenTofu's own state (#181).
 *
 * `ct export tf` can only write what ct still holds. After the cutover, tofu is the only place new
 * ids appear: a campus created by `tofu apply` exists in no ct state file, so no export will ever
 * mention it. Reading tofu's state closes that loop — from a file or stdin, so it works against any
 * backend (the real one is S3) without ct learning to speak S3.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIdsList, runIdsSync } from "../src/application/operations/ids.js";
import { writeIdMap } from "../src/resolve/idMap.js";

const HOST = "https://eqrm.church.tools";
let dir: string;

function tfstate(resources: unknown[], serial = 3): string {
  return JSON.stringify({ version: 4, serial, resources });
}

const CAMPUS_MAINZ = {
  mode: "managed",
  type: "churchtools_campus",
  name: "mainz",
  instances: [{ attributes: { id: 0 } }],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-ids-sync-"));
  await mkdir(join(dir, ".ct"), { recursive: true });
  vi.stubEnv("CT_HOST", HOST);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function sync(state: string, opts: { dryRun?: boolean } = {}) {
  const path = join(dir, "terraform.tfstate");
  await writeFile(path, state, "utf8");
  return runIdsSync({ cwd: dir, tofuState: path, dryRun: opts.dryRun });
}

describe("runIdsSync", () => {
  it("writes the map from the state and reports what moved", async () => {
    await writeIdMap(
      HOST,
      [
        { type: "campus", key: "mainz", id: 0 },
        { type: "campus", key: "horgen", id: 4 },
      ],
      join(dir, ".ct"),
    );
    const result = await sync(
      tfstate([
        CAMPUS_MAINZ,
        { ...CAMPUS_MAINZ, name: "egc", instances: [{ attributes: { id: 3 } }] },
        {
          mode: "managed",
          type: "churchtools_person_status",
          name: "status_5_core",
          instances: [{ attributes: { id: 6 } }],
        },
      ]),
    );
    expect(result.value.written).toBe(true);
    expect(result.value.serial).toBe(3);
    expect(result.value.added.map((e) => e.key)).toEqual(["egc", "status_5_core"]);
    // Gone from tofu's state, so ct must stop claiming to resolve it: a kept id would point every
    // reference at whatever holds that number now.
    expect(result.value.removed.map((e) => e.key)).toEqual(["horgen"]);
    const map = JSON.parse(await readFile(result.value.path, "utf8"));
    expect(map.campus).toEqual({ egc: { id: 3 }, mainz: { id: 0 } });
    expect(map.$meta).toMatchObject({ host: HOST, source: "ct ids sync", entries: 3 });
  });

  it("reports an id that changed under the same key", async () => {
    await writeIdMap(HOST, [{ type: "campus", key: "mainz", id: 6 }], join(dir, ".ct"));
    const result = await sync(tfstate([CAMPUS_MAINZ]));
    expect(result.value.changed).toEqual([{ entry: { type: "campus", key: "mainz", id: 0 }, previousId: 6 }]);
  });

  it("maps a relabelled resource back to its ct key via the existing map", async () => {
    await writeIdMap(
      HOST,
      [{ type: "group-type", key: "3_active", id: 4, label: "g_3_active" }],
      join(dir, ".ct"),
    );
    const result = await sync(
      tfstate([
        {
          mode: "managed",
          type: "churchtools_group_type",
          name: "g_3_active",
          instances: [{ attributes: { id: 4 } }],
        },
      ]),
    );
    expect(result.value.entries).toEqual([
      { type: "group-type", key: "3_active", id: 4, label: "g_3_active" },
    ]);
    expect(result.value.added).toEqual([]);
  });

  it("reads the state from stdin, so `tofu state pull | ct ids sync` works on any backend", async () => {
    const result = await runIdsSync(
      { cwd: dir, tofuState: "-" },
      { readStdin: async () => tfstate([CAMPUS_MAINZ]) },
    );
    expect(result.value.entries).toEqual([{ type: "campus", key: "mainz", id: 0 }]);
    expect(result.value.written).toBe(true);
  });

  it("never replaces a good map with an empty one", async () => {
    // The likeliest cause is the wrong workspace, and overwriting 50 working ids with nothing would
    // break every reference at once — the command reports and refuses instead.
    await writeIdMap(HOST, [{ type: "campus", key: "mainz", id: 0 }], join(dir, ".ct"));
    const result = await sync(tfstate([]));
    expect(result.value.written).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain("IDS_EMPTY");
    const map = JSON.parse(await readFile(result.value.path, "utf8"));
    expect(map.campus).toEqual({ mainz: { id: 0 } });
  });

  it("warns about provider resources ct has no type for", async () => {
    const result = await sync(
      tfstate([
        CAMPUS_MAINZ,
        { mode: "managed", type: "churchtools_group", name: "kids", instances: [{ attributes: { id: 7 } }] },
      ]),
    );
    const warning = result.warnings.find((w) => w.code === "IDS_TYPE_UNSUPPORTED");
    expect(warning?.message).toContain("churchtools_group");
  });

  it("writes nothing under --dry-run", async () => {
    const result = await sync(tfstate([CAMPUS_MAINZ]), { dryRun: true });
    expect(result.value.written).toBe(false);
    expect(result.value.added.map((e) => e.key)).toEqual(["mainz"]);
    await expect(readFile(join(dir, ".ct", "ids.eqrm.church.tools.json"), "utf8")).rejects.toThrow(/ENOENT/);
    // The path it REPORTS is the one it would have written. Built from the raw host, it read
    // `.ct/ids.https:/eqrm.church.tools.json` — a filename that exists nowhere, in the one mode
    // whose entire output is "here is what I would do".
    expect(result.value.path).toBe(join(dir, ".ct", "ids.eqrm.church.tools.json"));
  });

  it("says where to look rather than parsing garbage", async () => {
    await expect(sync("not json")).rejects.toThrow(/not valid JSON/);
  });

  // `loadIdMap` throws on a malformed or foreign-host map, and this is the one command able to
  // replace one. Refusing to run until the broken file is deleted by hand makes the repair tool
  // need the repair.
  it("regenerates over a malformed map instead of refusing to run", async () => {
    await writeFile(join(dir, ".ct", "ids.eqrm.church.tools.json"), "not json at all", "utf8");
    const result = await sync(tfstate([CAMPUS_MAINZ]));
    expect(result.value.written).toBe(true);
    expect(result.value.entries.map((e) => e.key)).toEqual(["mainz"]);
    expect(result.warnings.map((w) => w.code)).toContain("IDS_PREVIOUS_UNREADABLE");
  });

  // Every other path in this operation is anchored to project.cwd; this one read from process.cwd(),
  // so an embedded or HTTP caller passing `cwd` read a different file than it asked for.
  it("resolves a relative --tofu-state against the project cwd", async () => {
    await writeFile(join(dir, "terraform.tfstate"), tfstate([CAMPUS_MAINZ]), "utf8");
    const result = await runIdsSync({ cwd: dir, tofuState: "terraform.tfstate" });
    expect(result.value.entries.map((e) => e.key)).toEqual(["mainz"]);
  });
});

describe("runIdsList", () => {
  it("reports no map rather than an empty one", async () => {
    const result = await runIdsList({ cwd: dir });
    expect(result.value).toEqual({ path: null, entries: [] });
  });

  it("lists what the resolver would use", async () => {
    await writeIdMap(HOST, [{ type: "campus", key: "mainz", id: 0 }], join(dir, ".ct"));
    const result = await runIdsList({ cwd: dir });
    expect(result.value.entries).toEqual([{ type: "campus", key: "mainz", id: 0 }]);
  });
});
