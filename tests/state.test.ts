import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, loadState, saveState, upsert, findByTypeId, isManaged } from "../src/state/state.js";

const HOST = "https://mychurch.church.tools";
const NOW = "2026-07-07T00:00:00.000Z";
const LATER = "2026-07-08T00:00:00.000Z";

describe("state.upsert", () => {
  it("creates a new managed resource", () => {
    const state = emptyState(HOST);
    const action = upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz" } }, NOW);
    expect(action).toBe("created");
    expect(state.resources.mainz).toMatchObject({ type: "campus", id: 0, key: "mainz", adoptedAt: NOW });
  });

  it("is idempotent for the same (type, id) — updates in place, no duplicate", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz" } }, NOW);
    const action = upsert(
      state,
      { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz HQ" } },
      LATER,
    );
    expect(action).toBe("updated");
    expect(Object.keys(state.resources)).toHaveLength(1);
    expect(state.resources.mainz?.fields).toEqual({ name: "Mainz HQ" });
    expect(state.resources.mainz?.adoptedAt).toBe(NOW);
    expect(state.resources.mainz?.updatedAt).toBe(LATER);
  });

  it("does not bump updatedAt when re-adopting identical fields (#52: quiet state)", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz", shorty: "MZ" } }, NOW);
    // Re-upsert with the SAME fields (a fresh object, but structurally equal) at a LATER time.
    const action = upsert(
      state,
      { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz", shorty: "MZ" } },
      LATER,
    );
    expect(action).toBe("updated");
    // updatedAt must NOT churn: nothing about the resource actually changed.
    expect(state.resources.mainz?.updatedAt).toBe(NOW);
    expect(state.resources.mainz?.adoptedAt).toBe(NOW);
  });

  it("does not bump updatedAt when a fresh snapshot carries undefined-valued optional keys the persisted one lacks (#52: JSON round-trip parity)", () => {
    // group-type's managedFields includes `nameTranslated` as an optional key: when the API omits
    // it, the freshly-built fields object carries an explicit `nameTranslated: undefined`, while the
    // snapshot loaded back from disk (via JSON.parse, after JSON.stringify dropped the undefined key
    // on save) simply lacks the key. Re-adopting must see these as equal.
    const state = emptyState(HOST);
    const persisted = JSON.parse(JSON.stringify({ name: "Members", nameTranslated: undefined }));
    upsert(state, { type: "group-type", id: 3, key: "gt-members", fields: persisted }, NOW);
    expect(state.resources["gt-members"]?.fields).toEqual({ name: "Members" });

    const fresh = { name: "Members", nameTranslated: undefined };
    const action = upsert(state, { type: "group-type", id: 3, key: "gt-members", fields: fresh }, LATER);

    expect(action).toBe("updated");
    expect(state.resources["gt-members"]?.updatedAt).toBe(NOW);
  });

  it("bumps updatedAt only when the fields actually change", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz" } }, NOW);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz HQ" } }, LATER);
    expect(state.resources.mainz?.updatedAt).toBe(LATER);
    expect(state.resources.mainz?.adoptedAt).toBe(NOW);
  });

  it("ignores field key ORDER when deciding whether fields changed (order-independent)", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "group", id: 5, key: "g", fields: { name: "G", groupTypeId: 2 } }, NOW);
    upsert(state, { type: "group", id: 5, key: "g", fields: { groupTypeId: 2, name: "G" } }, LATER);
    expect(state.resources.g?.updatedAt).toBe(NOW); // reordered, but structurally identical
  });

  it("re-adopting identical fields leaves the saved state file byte-identical", async () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz", shorty: "MZ" } }, NOW);
    const path = join(tmpdir(), `ct-cli-quiet-${process.pid}.json`);
    await saveState(path, state);
    const before = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz", shorty: "MZ" } }, LATER);
    await saveState(path, state);
    const after = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
    await rm(path, { force: true });
    expect(after).toBe(before);
  });

  it("handles id 0 without treating it as missing", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: {} }, NOW);
    expect(isManaged(state, "campus", 0)).toBe(true);
    expect(findByTypeId(state, "campus", 0)?.id).toBe(0);
  });

  it("re-keys when the same resource is adopted under a new key", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "mainz", fields: {} }, NOW);
    upsert(state, { type: "campus", id: 0, key: "mz", fields: {} }, LATER);
    expect(Object.keys(state.resources)).toEqual(["mz"]);
    expect(findByTypeId(state, "campus", 0)?.key).toBe("mz");
  });

  it("rejects a key already taken by a different resource", () => {
    const state = emptyState(HOST);
    upsert(state, { type: "campus", id: 0, key: "shared", fields: {} }, NOW);
    expect(() => upsert(state, { type: "group", id: 5, key: "shared", fields: {} }, NOW)).toThrow(
      /already used/,
    );
  });
});

describe("state.loadState", () => {
  const statePath = join(tmpdir(), `ct-cli-loadstate-${process.pid}.json`);

  afterEach(async () => {
    await rm(statePath, { force: true });
  });

  it("returns an empty state for the given host when the file is missing", async () => {
    const state = await loadState(statePath, HOST);
    expect(state).toEqual(emptyState(HOST));
  });

  it("round-trips a saved state", async () => {
    const original = emptyState(HOST);
    upsert(original, { type: "campus", id: 0, key: "mainz", fields: { name: "Mainz" } }, NOW);
    await saveState(statePath, original);
    expect(await loadState(statePath, HOST)).toEqual(original);
  });

  it("refuses to load a state file recorded against a different host", async () => {
    await saveState(statePath, emptyState("https://other.church.tools"));
    await expect(loadState(statePath, HOST)).rejects.toThrow(/Refusing to mix instances/);
  });

  it("rejects a structurally invalid state file (missing resources) with a friendly error", async () => {
    await writeFile(statePath, JSON.stringify({ version: 1, host: HOST }), "utf8");
    await expect(loadState(statePath, HOST)).rejects.toThrow(/"resources" must be an object/);
  });

  it("rejects a top-level non-object state file", async () => {
    await writeFile(statePath, "null", "utf8");
    await expect(loadState(statePath, HOST)).rejects.toThrow(/expected a JSON object/);
  });

  it("rejects invalid JSON with a friendly error", async () => {
    await writeFile(statePath, "{ not json", "utf8");
    await expect(loadState(statePath, HOST)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an unsupported version", async () => {
    await writeFile(statePath, JSON.stringify({ version: 3, host: HOST, resources: {} }), "utf8");
    await expect(loadState(statePath, HOST)).rejects.toThrow(/Unsupported state file version/);
  });

  it("migrates version 1 in memory to version 2 with an empty externals map", async () => {
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        host: HOST,
        resources: {
          mainz: {
            type: "campus",
            id: 0,
            key: "mainz",
            fields: { name: "Mainz" },
            adoptedAt: "t",
            updatedAt: "t",
          },
        },
      }),
      "utf8",
    );
    const state = await loadState(statePath, HOST);
    expect(state.version).toBe(2);
    expect(state.externals).toEqual({});
    expect(state.resources.mainz?.id).toBe(0);
  });

  it("rejects managed/external key collisions in version 2", async () => {
    const common = { type: "campus", id: 0, key: "mainz" };
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        host: HOST,
        resources: {
          mainz: { ...common, fields: {}, adoptedAt: "t", updatedAt: "t" },
        },
        externals: {
          mainz: { ...common, identity: { name: "Mainz" }, boundAt: "t" },
        },
      }),
      "utf8",
    );
    await expect(loadState(statePath, HOST)).rejects.toThrow(/both a managed and an external/);
  });

  it("migrates a pre-rename campus snapshot: shortName → shorty (#17 item 4)", async () => {
    // A campus adopted before the shortName→shorty rename (Phase 4, no version bump).
    const file = {
      version: 1,
      host: HOST,
      resources: {
        mainz: {
          type: "campus",
          id: 0,
          key: "mainz",
          fields: { name: "Mainz", shortName: "MZ" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    await writeFile(statePath, JSON.stringify(file), "utf8");
    const state = await loadState(statePath, HOST);
    // The vestigial `shortName` is renamed to the real create-key `shorty`, clearing the phantom drift.
    expect(state.resources.mainz!.fields).toEqual({ name: "Mainz", shorty: "MZ" });
  });

  it("does not clobber a post-rename snapshot that already has shorty", async () => {
    const file = {
      version: 1,
      host: HOST,
      resources: {
        mainz: {
          type: "campus",
          id: 0,
          key: "mainz",
          // Both keys present (e.g. a raw CT snapshot) — the real `shorty` must win, untouched.
          fields: { name: "Mainz", shorty: "MZ", shortName: null },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    await writeFile(statePath, JSON.stringify(file), "utf8");
    const state = await loadState(statePath, HOST);
    expect(state.resources.mainz!.fields.shorty).toBe("MZ");
  });
});
