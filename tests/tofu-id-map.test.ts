/**
 * Resolving OpenTofu-owned resources through a committed id map (#181).
 *
 * This is the last step of the tier-0 cutover, and the one that could not be done by hand. When the
 * five tier-0 tables leave `ct.config.ts` AND their 50 entries leave `ct-state.<env>.json`, the
 * references that stay behind fall back to matching the key against the live object's NAME — and ct's
 * tier-0 keys were never name-derived, so for person statuses that can never work:
 *
 *   key                live name
 *   status_unbekannt   Unbekannt
 *   status_5_core      5 - Core
 *
 * A literal id is no escape either: one config serves two hosts and 39 of 43 tier-0 ids differ.
 * So the map carries the exact key→id table, per host, committed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idMapPath, loadIdMap, parseIdMap, renderIdMap, writeIdMap } from "../src/resolve/idMap.js";
import { readTfState } from "../src/resolve/tfstate.js";
import { Resolver } from "../src/resolve/resolver.js";
import { ref } from "../src/resolve/refs.js";
import type { State } from "../src/state/state.js";

const HOST = "https://eqrm.church.tools";
let dir: string | undefined;

const state: State = { version: 1, host: HOST, resources: {} };

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "ct-ids-"));
  mkdirSync(join(dir, ".ct"), { recursive: true });
  return join(dir, ".ct");
}

/** The tier-0 shape the exporter produces, with one relabelled key. */
const ENTRIES = [
  { type: "campus", key: "mainz", id: 0 },
  { type: "person-status", key: "status_unbekannt", id: 0 },
  { type: "person-status", key: "status_5_core", id: 6 },
  { type: "group-type", key: "3_groupactive", id: 9, label: "g_3_groupactive" },
];

describe("the id map file", () => {
  it("is one file per host, beside the per-instance permission catalog", () => {
    expect(idMapPath(HOST, ".ct")).toBe(".ct/ids.eqrm.church.tools.json");
    expect(idMapPath("https://eqrm-dev.church.tools/", ".ct")).toBe(".ct/ids.eqrm-dev.church.tools.json");
  });

  it("renders byte-stably, sorted by type then key", () => {
    const first = renderIdMap(HOST, ENTRIES, "ct export tf");
    const shuffled = renderIdMap(HOST, [...ENTRIES].reverse(), "ct export tf");
    expect(first).toBe(shuffled);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["$meta", "campus", "group-type", "person-status"]);
    // The label rides along only where it differs — a relabelling is many-to-one, so it cannot be
    // re-derived from the label when reading a tofu state back.
    expect(parsed["group-type"]).toEqual({ "3_groupactive": { id: 9, label: "g_3_groupactive" } });
    expect(parsed.campus).toEqual({ mainz: { id: 0 } });
  });

  it("id 0 survives the round trip", async () => {
    // `campus/mainz` is id 0 on prod and `person-status/status_unbekannt` is 0 too: any code that
    // treats a falsy id as "missing" breaks precisely the references this feature exists for.
    const d = tempDir();
    await writeIdMap(HOST, ENTRIES, d);
    const loaded = await loadIdMap(HOST, d);
    expect(loaded?.ids.get("campus\u0000mainz")).toBe(0);
    expect(loaded?.ids.get("person-status\u0000status_unbekannt")).toBe(0);
  });

  it("returns null when the repo has no map, so nothing changes for anyone else", async () => {
    expect(await loadIdMap(HOST, tempDir())).toBeNull();
  });

  it("refuses a map generated for another host", () => {
    // 39 of 43 tier-0 ids differ between the two hosts, so applying dev's map to prod would resolve
    // every reference to a real, wrong resource — undetectable downstream.
    const raw = renderIdMap("https://eqrm-dev.church.tools", ENTRIES, "ct export tf");
    expect(() => parseIdMap(raw, ".ct/ids.json", HOST)).toThrow(/was generated for https:\/\/eqrm-dev/);
  });

  it("refuses a malformed entry rather than resolving to NaN", () => {
    const raw = JSON.stringify({ campus: { mainz: { id: "0" } } });
    expect(() => parseIdMap(raw, ".ct/ids.json", HOST)).toThrow(/campus "mainz" has no numeric id/);
  });
});

describe("Resolver", () => {
  const client = {
    get: async () => [],
    getAll: async () => ({ data: [{ id: 99, name: "Unbekannt" }] }),
  };

  it("resolves a key the live name cannot produce", async () => {
    const map = parseIdMap(renderIdMap(HOST, ENTRIES, "ct export tf"), ".ct/ids.json", HOST);
    const resolver = new Resolver({ client: client as never, state, desired: [], host: HOST, idMap: map });
    expect(await resolver.resolve(ref.personStatus("status_5_core"), "site")).toBe(6);
    expect(await resolver.resolve(ref.campus("mainz"), "site")).toBe(0);
  });

  it("still prefers ct's own state over the map", async () => {
    // ct never stops trusting what it owns: a resource still in ct's state is ct's, and a stale map
    // entry must not overrule it.
    const owned: State = {
      version: 1,
      host: HOST,
      resources: {
        mainz: { type: "campus", id: 42, key: "mainz", fields: {}, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const map = parseIdMap(renderIdMap(HOST, ENTRIES, "ct export tf"), ".ct/ids.json", HOST);
    const resolver = new Resolver({
      client: client as never,
      state: owned,
      desired: [],
      host: HOST,
      idMap: map,
    });
    expect(await resolver.resolve(ref.campus("mainz"), "site")).toBe(42);
  });

  it("prefers the map over a live name match", async () => {
    // The map is exact; the catalog match is a guess at a slug. `status_unbekannt` would resolve to
    // the live "Unbekannt" row (#99) only by accident of naming — and does not on the real instance.
    const map = parseIdMap(
      renderIdMap(HOST, [{ type: "person-status", key: "unbekannt", id: 7 }], "ct export tf"),
      ".ct/ids.json",
      HOST,
    );
    const resolver = new Resolver({ client: client as never, state, desired: [], host: HOST, idMap: map });
    expect(await resolver.resolve(ref.personStatus("unbekannt"), "site")).toBe(7);
  });

  it("names the map, and how to refresh it, when a key is in neither", async () => {
    const map = parseIdMap(renderIdMap(HOST, ENTRIES, "ct export tf"), ".ct/ids.json", HOST);
    const resolver = new Resolver({ client: client as never, state, desired: [], host: HOST, idMap: map });
    await expect(resolver.resolve(ref.campus("horgen"), "site")).rejects.toThrow(
      /\.ct\/ids\.json has no campus "horgen" either.*ct ids sync/s,
    );
  });
});

describe("readTfState", () => {
  const tfstate = {
    version: 4,
    serial: 12,
    resources: [
      {
        mode: "managed",
        type: "churchtools_person_status",
        name: "status_unbekannt",
        instances: [{ attributes: { id: 0, name: "Unbekannt" } }],
      },
      {
        mode: "managed",
        type: "churchtools_group_type",
        name: "g_3_groupactive",
        instances: [{ attributes: { id: 9 } }],
      },
      // A data source describes a read, not a managed object.
      {
        mode: "data",
        type: "churchtools_campus",
        name: "elsewhere",
        instances: [{ attributes: { id: 5 } }],
      },
      // Mid-create or tainted: no id to map.
      { mode: "managed", type: "churchtools_campus", name: "pending", instances: [{ attributes: {} }] },
      // A provider resource ct has no type for — reported, never fatal.
      { mode: "managed", type: "churchtools_group", name: "kids", instances: [{ attributes: { id: 3 } }] },
      { mode: "managed", type: "aws_s3_bucket", name: "state", instances: [{ attributes: { id: "b" } }] },
    ],
  };

  it("maps managed churchtools resources back to ct keys", () => {
    // tofu's label is mapped back through the previous map, because the exporter's relabelling
    // (`3_groupactive` → `g_3_groupactive`) is many-to-one and cannot be inverted by rule.
    const previous = parseIdMap(renderIdMap(HOST, ENTRIES, "ct export tf"), ".ct/ids.json", HOST);
    const { entries, unmapped, serial } = readTfState(tfstate, previous.keysByLabel);
    expect(entries).toEqual([
      { type: "person-status", key: "status_unbekannt", id: 0 },
      { type: "group-type", key: "3_groupactive", id: 9, label: "g_3_groupactive" },
    ]);
    expect(unmapped).toEqual(["churchtools_group"]);
    expect(serial).toBe(12);
  });

  it("takes the label as the key when no previous map recorded a relabelling", () => {
    const { entries } = readTfState(tfstate);
    expect(entries.map((e) => e.key)).toEqual(["status_unbekannt", "g_3_groupactive"]);
  });

  it("rejects something that is not a tofu state", () => {
    expect(() => readTfState([])).toThrow(/expected a JSON object/);
    expect(() => readTfState({ resources: {} })).toThrow(/"resources" is not an array/);
  });
});
