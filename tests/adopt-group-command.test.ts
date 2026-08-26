import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CtApiError } from "../src/api/ctClient.js";
import { buildPlan } from "../src/engine/build.js";
import { createContext } from "../src/config/context.js";
import type { CtClient } from "../src/api/ctClient.js";

/**
 * A tiny in-memory ChurchTools double covering everything `ct adopt group` reads:
 *  - `/groups/{id}` (single fetch), `/groups` (getAll, for --type)
 *  - `/groups/{id}/children` (for --children-of; includes a cyclic pair to exercise the guard)
 *  - `/group/grouptypes` (for --type's logical-key resolution)
 *  - `/dynamicgroups/{id}/ruleset` + `/status` (for --with-dynamic; #31 is deliberately NOT dynamic)
 */
type ChildrenResponse = "array" | "envelope" | "domain-envelope" | "root-404";

function makeClient(childrenResponse: ChildrenResponse = "array") {
  const groups: Record<number, Record<string, unknown>> = {
    10: { id: 10, name: "Area A", information: { groupTypeId: 5, groupStatusId: 1 } },
    11: { id: 11, name: "Area B", information: { groupTypeId: 5, groupStatusId: 1 } },
    20: { id: 20, name: "Other Type Group", information: { groupTypeId: 9, groupStatusId: 1 } },
    40: { id: 40, name: "Root", information: { groupTypeId: 5, groupStatusId: 1 } },
    41: { id: 41, name: "Child One", information: { groupTypeId: 5, groupStatusId: 1 } },
    42: { id: 42, name: "Child Two", information: { groupTypeId: 5, groupStatusId: 1 } },
    43: { id: 43, name: "Grandchild", information: { groupTypeId: 5, groupStatusId: 1 } },
    50: { id: 50, name: "Cycle A", information: { groupTypeId: 5, groupStatusId: 1 } },
    51: { id: 51, name: "Cycle B", information: { groupTypeId: 5, groupStatusId: 1 } },
    30: { id: 30, name: "All Mainz", information: { groupTypeId: 5, groupStatusId: 1 } },
    // campusId 0 (Mainz) exercises campus reverse-resolution — including the id-0 edge — end to end.
    31: { id: 31, name: "Static Group", information: { groupTypeId: 5, groupStatusId: 1, campusId: 0 } },
    33: { id: 33, name: "Portable Dynamic", information: { groupTypeId: 5, groupStatusId: 1 } },
  };
  const children: Record<number, number[]> = {
    40: [41, 42],
    41: [43],
    50: [51], // cyclic: 50 -> 51 -> 50
    51: [50],
  };
  const groupTypes = [
    { id: 5, name: "Team" },
    { id: 9, name: "Other Type" },
  ];
  // Master-data catalogs the reverse resolver reads to sugar numeric ids back to logical keys (#52).
  // groupStatusId has NO such catalog (#67) — /group/memberstatus is deliberately NOT wired here for
  // that purpose; it is still mocked below only because `--children-of`/etc. share the same `get`
  // dispatcher with other tests exercising member statuses, and to prove it's never fetched for a
  // plain group adopt (see the assertion in the --with-dynamic capture test below).
  const campuses = [{ id: 0, name: "Mainz" }];
  const memberStatuses = [{ id: 1, name: "Aktiv" }];
  // Global role catalog (/group/roles), each row carrying its `groupTypeId` — used to portablize a
  // `role.id` groupTypeRoleId into a (group-type, role-name) marker (#76). Role 7 is a "Leiter" on
  // group type 5 ("Team").
  const roles = [{ id: 7, name: "Leiter", groupTypeId: 5 }];
  const rulesets: Record<number, Record<string, unknown>> = {
    30: { description: "x", query: { "==": [{ var: "a" }, "1"] }, process: {} },
    // A ruleset carrying every portablizable var shape (#76): a managed group id (10) + an unmanaged
    // one (999); a campus id (0); a role id (7); and a catalog-less groupStatusId list (untouched).
    33: {
      description: "portable",
      query: {
        and: [
          { oneof: [{ var: "ctgroup.id" }, ["10", "999"]] },
          { "==": [{ var: "ctgroup.campusId" }, "0"] },
          { oneof: [{ var: "role.id" }, ["7"]] },
          { oneof: [{ var: "ctgroup.groupStatusId" }, ["1", "2"]] },
        ],
      },
      process: {},
    },
  };
  const statuses: Record<number, string> = { 30: "active", 33: "active" };
  // Group-scoped member fields (#135). Group 31 has two custom fields plus a row sourced elsewhere
  // (`type: "person"`), which must NOT be adopted — only `/memberfields/group` rows are manageable.
  const memberFields: Record<number, Array<Record<string, unknown>>> = {
    31: [
      {
        type: "group",
        field: {
          id: 701,
          referenceName: "wahl",
          name: "Wahl",
          fieldTypeCode: "text",
          requiredInRegistrationForm: true,
          sortKey: 1,
        },
      },
      {
        type: "group",
        field: {
          id: 702,
          referenceName: "notiz",
          name: "Notiz",
          fieldTypeCode: "textarea",
        },
      },
      {
        type: "person",
        field: {
          id: 703,
          referenceName: "vorname",
          name: "Vorname",
          fieldTypeCode: "text",
        },
      },
    ],
  };

  const get = vi.fn(async (path: string): Promise<unknown> => {
    let m = /^\/groups\/(\d+)$/.exec(path);
    if (m) {
      const g = groups[Number(m[1])];
      if (!g) throw new CtApiError("not found", 404, null);
      return g;
    }
    m = /^\/groups\/(\d+)\/children$/.exec(path);
    if (m) {
      const parentId = Number(m[1]);
      if (childrenResponse === "root-404" && parentId === 40) {
        throw new CtApiError("not found", 404, null);
      }
      const rows = (children[parentId] ?? []).map((id) => ({ id }));
      if (childrenResponse === "envelope") return { data: rows };
      if (childrenResponse === "domain-envelope") {
        return {
          data: rows.map(({ id }) => ({
            domainIdentifier: String(id),
            domainType: "group",
            apiUrl: `/groups/${id}`,
          })),
        };
      }
      return rows;
    }
    m = /^\/groups\/(\d+)\/memberfields$/.exec(path);
    if (m) return memberFields[Number(m[1])] ?? [];
    if (path === "/group/grouptypes") return groupTypes;
    if (path === "/campuses") return campuses;
    if (path === "/group/roles") return roles;
    if (path === "/group/memberstatus") return memberStatuses;
    m = /^\/dynamicgroups\/(\d+)\/ruleset$/.exec(path);
    if (m) {
      const rs = rulesets[Number(m[1])];
      if (!rs) throw new CtApiError("not found", 404, null);
      return rs;
    }
    m = /^\/dynamicgroups\/(\d+)\/status$/.exec(path);
    if (m) return { dynamicGroupStatus: statuses[Number(m[1])] ?? "none" };
    throw new CtApiError(`unmocked GET ${path}`, 404, null);
  });

  const getAll = vi.fn(async (path: string) => {
    if (path === "/groups") return { data: Object.values(groups) };
    // The Resolver reads master-data catalogs paginated (#99 review), and `--children-of` reads
    // `/groups/{id}/children` paginated (#101), so serve them here too — same rows as `get`, with
    // the real client's envelope normalization (bare array or `{ data: [...] }` -> page items).
    const single = await get(path);
    if (Array.isArray(single)) return { data: single };
    const inner = (single as { data?: unknown }).data;
    return { data: Array.isArray(inner) ? inner : [single] };
  });

  return { get, getAll };
}

let client = makeClient();

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client, me: { id: 1 } })),
}));

const { adoptCommand } = await import("../src/commands/adopt.js");
const { loadState, saveState } = await import("../src/state/state.js");
const { loadConfig } = await import("../src/config/load.js");

const HOST = "https://mychurch.church.tools";
const originalHost = process.env.CT_HOST;
const originalCwd = process.cwd();

let workDir: string;
let statePath: string;

async function run(args: string[]): Promise<void> {
  await adoptCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
  client = makeClient();
  process.env.CT_HOST = HOST;
  workDir = mkdtempSync(join(tmpdir(), "ct-adopt-group-"));
  process.chdir(workDir);
  statePath = join(workDir, "ct-state.json");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
});

describe("ct adopt group — multi-id list form", () => {
  it("adopts every listed group, in the given order, into one state file", async () => {
    await run(["group", "10", "11", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.area_a).toMatchObject({ type: "group", id: 10 });
    expect(state.resources.area_b).toMatchObject({ type: "group", id: 11 });
    expect(Object.keys(state.resources)).toEqual(["area_a", "area_b"]);
  });

  it("prints a single grouped config block with a type comment header", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["group", "10", "11", "--state", statePath]);
    } finally {
      spy.mockRestore();
    }
    const block = writes.join("");
    expect(block).toContain("// group");
    // Idiomatic multi-line snippets (#52 item A): the call opens on its own line, key first.
    expect(block).toContain("group({");
    expect(block).toContain('key: "area_a"');
    expect(block).toContain('key: "area_b"');
    // parents-before-children / declared order preserved: area_a's line precedes area_b's.
    expect(block.indexOf('key: "area_a"')).toBeLessThan(block.indexOf('key: "area_b"'));
  });

  it("dedupes a repeated id", async () => {
    await run(["group", "10", "10", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(Object.keys(state.resources)).toEqual(["area_a"]);
  });

  it("--dry-run adopts nothing and writes no state file", async () => {
    await run(["group", "10", "11", "--dry-run", "--state", statePath]);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects --key with more than one id, before any network call", async () => {
    await expect(run(["group", "10", "11", "--key", "x", "--state", statePath])).rejects.toThrow(
      /single group/,
    );
    expect(client.get).not.toHaveBeenCalled();
  });

  it("rejects an invalid id before any network call", async () => {
    await expect(run(["group", "10", "abc", "--state", statePath])).rejects.toThrow(
      /expected a non-negative integer/,
    );
    expect(client.get).not.toHaveBeenCalled();
  });

  it("still supports the plain single-id form exactly as before", async () => {
    await run(["group", "10", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.area_a).toMatchObject({
      type: "group",
      id: 10,
      fields: { name: "Area A", groupTypeId: 5, groupStatusId: 1 },
    });
  });
});

describe("ct adopt group --type", () => {
  it("adopts every group of a numeric group-type id, and none of another type", async () => {
    await run(["group", "--type", "5", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const types = Object.values(state.resources).map((r) => r.id);
    expect(types).toEqual(expect.arrayContaining([10, 11, 40, 41, 42, 43, 50, 51, 30, 31]));
    expect(types).not.toContain(20); // group type 9 — excluded
  });

  it("resolves a logical group-type key against /group/grouptypes", async () => {
    await run(["group", "--type", "team", "--state", statePath]);
    expect(client.getAll).toHaveBeenCalledWith("/groups");
    const state = await loadState(statePath, HOST);
    expect(state.resources.area_a).toMatchObject({ id: 10 });
    expect(Object.values(state.resources).map((r) => r.id)).not.toContain(20);
  });

  it("rejects an unknown --type key", async () => {
    await expect(run(["group", "--type", "nope", "--state", statePath])).rejects.toThrow(
      /no group type matches/,
    );
  });

  it("rejects combining --type with explicit ids", async () => {
    await expect(run(["group", "10", "--type", "5", "--state", statePath])).rejects.toThrow(/only one of/);
  });
});

describe("ct adopt group --children-of", () => {
  it("recursively adopts the full subtree, parent before child, excluding the root itself", async () => {
    await run(["group", "--children-of", "40", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const ids = Object.values(state.resources).map((r) => r.id);
    expect(ids.sort((a, b) => a - b)).toEqual([41, 42, 43]);
    expect(ids).not.toContain(40); // root itself is not re-adopted by --children-of
    // 41 (child of root) must be adopted before 43 (child of 41).
    const order = Object.values(state.resources).map((r) => r.id);
    expect(order.indexOf(41)).toBeLessThan(order.indexOf(43));
    // `/groups/{id}/children` is a paginated list endpoint: read via `getAll`, never a plain `get`
    // (#101), or a wide Bereich silently loses everything past CT's default first page.
    expect(client.getAll).toHaveBeenCalledWith("/groups/40/children");
    expect(client.getAll).toHaveBeenCalledWith("/groups/41/children");
  });

  it("terminates on a cyclic hierarchy instead of looping forever (cycle guard)", async () => {
    await run(["group", "--children-of", "50", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const ids = Object.values(state.resources).map((r) => r.id);
    expect(ids).toEqual([51]); // 50 -> 51 -> 50: only 51 is a new descendant
  });

  it("accepts the raw { data: [...] } collection envelope", async () => {
    client = makeClient("envelope");
    await run(["group", "--children-of", "40", "--state", statePath]);

    const state = await loadState(statePath, HOST);
    expect(Object.values(state.resources).map((r) => r.id)).toEqual([41, 43, 42]);
  });

  it("reads ids from the domain resources documented by the live ChurchTools OpenAPI", async () => {
    client = makeClient("domain-envelope");
    await run(["group", "--children-of", "40", "--state", statePath]);

    const state = await loadState(statePath, HOST);
    expect(Object.values(state.resources).map((r) => r.id)).toEqual([41, 43, 42]);
  });

  it("propagates a children endpoint 404 instead of treating the group as a leaf", async () => {
    client = makeClient("root-404");
    await expect(run(["group", "--children-of", "40", "--state", statePath])).rejects.toMatchObject({
      status: 404,
    });
  });

  it("resolves --children-of by an already-adopted state key", async () => {
    await run(["group", "40", "--state", statePath]); // adopt the root first, under its derived key "root"
    await run(["group", "--children-of", "root", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(
      Object.values(state.resources)
        .map((r) => r.id)
        .sort((a, b) => a - b),
    ).toEqual([40, 41, 42, 43]);
  });

  it("reports an empty subtree without adopting anything", async () => {
    await run(["group", "--children-of", "42", "--state", statePath]); // 42 has no children
    const state = await loadState(statePath, HOST);
    expect(Object.keys(state.resources)).toEqual([]);
  });
});

describe("ct adopt group --with-dynamic", () => {
  it("captures a dynamic group's normalized ruleset to rulesets/<key>.json and emits the dynamic block", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["group", "30", "--with-dynamic", "--state", statePath]);
    } finally {
      spy.mockRestore();
    }
    const rulesetPath = join(workDir, "rulesets", "all_mainz.json");
    const written = JSON.parse(await readFile(rulesetPath, "utf8"));
    expect(written).toEqual({ description: "x", query: { "==": [{ var: "a" }, 1] }, process: {} }); // coerced "1" -> 1

    const block = writes.join("");
    // #52 item A+B: an active dynamic group whose ruleset matches the ./rulesets/<key>.json convention
    // is emitted with the shortest `dynamic: true` sugar (round-trips to the same spec on load).
    expect(block).toContain("dynamic: true,");
    // groupType is reverse-sugared to its logical key against the mocked catalog...
    expect(block).toContain('groupType: "team",');
    // ...but groupStatusId is NOT (#67: no group-status catalog exists) — it stays numeric, with no
    // TODO comment (a TODO only fires when a catalog exists but the id doesn't match anything in it).
    expect(block).toContain("groupStatusId: 1,");
    expect(block).not.toContain("status:");
    expect(block).not.toContain("TODO");
    // And the group-status "catalog" is never fetched at all — there is no such catalog to fetch.
    expect(client.get).not.toHaveBeenCalledWith("/group/memberstatus");

    // The plain group fields (state snapshot) never carry "dynamic" — it's synthetic, not a managed field.
    const state = await loadState(statePath, HOST);
    expect(state.resources.all_mainz?.fields).not.toHaveProperty("dynamic");
  });

  it("skips a non-dynamic group silently: no file, no dynamic block, no error", async () => {
    await run(["group", "31", "--with-dynamic", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.static_group).toMatchObject({ id: 31 });
    await expect(readFile(join(workDir, "rulesets", "static_group.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("--dry-run --with-dynamic previews the dynamic block without writing the ruleset file", async () => {
    await run(["group", "30", "--with-dynamic", "--dry-run", "--state", statePath]);
    await expect(readFile(join(workDir, "rulesets", "all_mainz.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("works across a bulk selection: captures dynamic only for the groups that are actually dynamic", async () => {
    await run(["group", "30", "31", "--with-dynamic", "--state", statePath]);
    const rulesetPath = join(workDir, "rulesets", "all_mainz.json");
    await expect(readFile(rulesetPath, "utf8")).resolves.toBeTruthy();
    await expect(readFile(join(workDir, "rulesets", "static_group.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("end-to-end: adopting a dynamic group with --with-dynamic makes `ct plan` a no-op (#51 acceptance)", async () => {
    await run(["group", "30", "--with-dynamic", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const managed = state.resources.all_mainz!;

    // Reconstruct the config a user would paste from the printed snippet: the plain group fields
    // plus the emitted `dynamic` block, referencing the file `--with-dynamic` just wrote.
    const { ct, resources } = createContext();
    ct.group({
      key: "all_mainz",
      name: managed.fields.name as string,
      groupTypeId: managed.fields.groupTypeId as number,
      groupStatusId: managed.fields.groupStatusId as number,
      dynamic: { status: "active", ruleset: { ref: "./rulesets/all_mainz.json" } },
    });

    const { plan } = await buildPlan(client as unknown as Pick<CtClient, "get">, state, resources, {
      configDir: workDir,
    });
    expect(plan.items.every((i) => i.action === "no-op")).toBe(true);
  });
});

describe("ct adopt group --with-dynamic --portable-rulesets (#76 Stage 3)", () => {
  /** Adopt group 10 first (→ managed key "area_a") so the dynamic ruleset's ctgroup.id 10 is managed. */
  async function adoptWithManagedGroup(extraArgs: string[]): Promise<void> {
    await run(["group", "10", "--state", statePath]);
    await run(["group", "33", "--with-dynamic", ...extraArgs, "--state", statePath]);
  }

  it("rewrites managed group/campus/role ids to ref markers and leaves groupStatusId numeric", async () => {
    await adoptWithManagedGroup(["--portable-rulesets"]);
    const written = JSON.parse(await readFile(join(workDir, "rulesets", "portable_dynamic.json"), "utf8"));
    const and = (written.query as { and: Array<Record<string, unknown[]>> }).and;

    // ctgroup.id: 10 is managed (→ ref.group("area_a")); 999 is unmanaged (→ stays numeric).
    expect(and[0]!.oneof![1]).toEqual([{ __ctRef: true, kind: "group", key: "area_a" }, 999]);
    // campusId 0 → the Mainz campus marker (slug of the catalog name).
    expect(and[1]!["=="]![1]).toEqual({ __ctRef: true, kind: "campus", key: "mainz" });
    // role.id 7 → group-type-role marker keyed by (group type "team", role "Leiter"), NOT a bare
    // role-def name (which would be ambiguous — role names are not globally unique across group types, #76).
    expect(and[2]!.oneof![1]).toEqual([
      { __ctRef: true, kind: "group-type-role", groupType: "team", role: "Leiter" },
    ]);
    // groupStatusId has no catalog (#67) → left numeric, untouched.
    expect(and[3]!.oneof![1]).toEqual([1, 2]);
  });

  it("names every dimension it left numeric, with the reason (#101)", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
    try {
      await adoptWithManagedGroup([]);
    } finally {
      spy.mockRestore();
    }
    const warned = errs.join("");
    // The whole point of #101: not "left N ids numeric", but WHICH dimension, WHICH ids, and WHY.
    expect(warned).toContain("rulesets/portable_dynamic.json keeps");
    expect(warned).toContain("NOT portable to another host");
    // Detail is id-free: formatPortablizeWarnings prints the ids once, ahead of it, so a detail
    // naming one id would be stamped across every id merged into the line.
    expect(warned).toMatch(/ctgroup\.id: 999 left numeric — not under management/);
    expect(warned).toMatch(/ctgroup\.groupStatusId: 1, 2 left numeric — group statuses have no REST catalog/);
  });

  it("is ON by default since #101: a plain --with-dynamic capture emits ref markers", async () => {
    await adoptWithManagedGroup([]); // no flag at all
    const written = JSON.parse(await readFile(join(workDir, "rulesets", "portable_dynamic.json"), "utf8"));
    const and = (written.query as { and: Array<Record<string, unknown[]>> }).and;
    expect(and[0]!.oneof![1]).toEqual([{ __ctRef: true, kind: "group", key: "area_a" }, 999]);
  });

  it("--no-portable-rulesets opts out, keeping raw numeric ids — and says the capture is host-specific", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
    try {
      await adoptWithManagedGroup(["--no-portable-rulesets"]);
    } finally {
      spy.mockRestore();
    }
    const written = JSON.parse(await readFile(join(workDir, "rulesets", "portable_dynamic.json"), "utf8"));
    const and = (written.query as { and: Array<Record<string, unknown[]>> }).and;
    expect(and[0]!.oneof![1]).toEqual([10, 999]); // raw ids, no rewrite
    expect(JSON.stringify(written)).not.toContain("__ctRef");
    expect(errs.join("")).toContain("captured verbatim (--no-portable-rulesets)");
  });

  it("--strict-rulesets refuses to write a ruleset that still carries a host-specific id", async () => {
    await run(["group", "10", "--state", statePath]);
    await expect(
      run(["group", "33", "--with-dynamic", "--strict-rulesets", "--state", statePath]),
    ).rejects.toThrow(/--strict-rulesets/);
    // Nothing was written — the refusal must not leave a half-portable file behind.
    await expect(readFile(join(workDir, "rulesets", "portable_dynamic.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("--dry-run --portable-rulesets writes no file", async () => {
    await run(["group", "10", "--state", statePath]);
    await run(["group", "33", "--with-dynamic", "--portable-rulesets", "--dry-run", "--state", statePath]);
    await expect(readFile(join(workDir, "rulesets", "portable_dynamic.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("ct adopt group — idiomatic snippet round-trips to a no-op (#52 item A acceptance)", () => {
  it("pasting the VERBATIM emitted snippet into a config plans as a no-op, zero hand edits", async () => {
    // Adopt a real group, capturing exactly what the command prints to stdout.
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["group", "31", "--state", statePath]);
    } finally {
      spy.mockRestore();
    }

    // The printed block is a `// group` header + one idiomatic multi-line `group({ ... });` snippet
    // with campusId/groupTypeId reverse-sugared to campus/groupType keys; groupStatusId has no
    // catalog to reverse-sugar against (#67), so it stays numeric — not a TODO, just plain data.
    const block = writes.join("");
    const snippet = block.replace(/^\/\/ group\n/, "").trim();
    expect(snippet.startsWith("group({")).toBe(true);
    expect(snippet).toContain('campus: "mainz"'); // id 0 reverse-resolved
    expect(snippet).toContain('groupType: "team"');
    expect(snippet).toContain("groupStatusId: 1");
    expect(snippet).not.toContain("status:"); // never the group-status sugar (#67)
    expect(snippet).not.toContain("TODO"); // everything resolved — a clean, hand-edit-free paste

    // Paste it VERBATIM into a config (only wrapping boilerplate + the `ct.` receiver added).
    const configPath = join(workDir, "ct.config.ts");
    writeFileSync(configPath, `export default (ct) => {\n  ct.${snippet}\n};\n`);

    // Load it through the real loader and plan against the state the adopt just wrote.
    const { resources } = await loadConfig(configPath);
    const state = await loadState(statePath, HOST);
    const { plan } = await buildPlan(client as unknown as Pick<CtClient, "get">, state, resources, {
      configDir: workDir,
    });
    expect(plan.items.every((i) => i.action === "no-op")).toBe(true);
  });
});

describe("ct adopt group --with-member-fields (#135)", () => {
  /** Grab the `--dry-run` payload, which carries the generated config snippet verbatim. */
  async function snippetFor(args: string[]): Promise<string> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(args);
    } finally {
      spy.mockRestore();
    }
    const payload = JSON.parse(writes.join("")) as { config?: string } | Array<{ config?: string }>;
    return Array.isArray(payload) ? payload.map((p) => p.config).join("\n") : (payload.config ?? "");
  }

  it("is opt-in: a plain adopt emits no memberFields block and never reads the endpoint", async () => {
    const snippet = await snippetFor(["group", "31", "--dry-run", "--state", statePath]);
    expect(snippet).not.toContain("memberFields");
    expect(client.get).not.toHaveBeenCalledWith("/groups/31/memberfields");
  });

  it("emits every group-scoped field WITHOUT any ChurchTools id", async () => {
    const snippet = await snippetFor([
      "group",
      "31",
      "--with-member-fields",
      "--dry-run",
      "--state",
      statePath,
    ]);
    expect(snippet).toContain("memberFields:");
    expect(snippet).toContain('key: "wahl"');
    expect(snippet).toContain('name: "Wahl"');
    expect(snippet).toContain('fieldTypeCode: "text"');
    expect(snippet).toContain("requiredInRegistrationForm: true");
    expect(snippet).toContain('key: "notiz"');
    // The whole portability guarantee: no host-specific field id anywhere in the emitted config.
    expect(snippet).not.toContain("701");
    expect(snippet).not.toContain("702");
    expect(snippet).not.toMatch(/\bid:/);
    // …and a row that is not group-scoped is not manageable through /memberfields/group.
    expect(snippet).not.toContain("vorname");
  });

  it("stores field ids only in the owning group's instance state", async () => {
    await run(["group", "31", "--with-member-fields", "--state", statePath]);

    const state = await loadState(statePath, HOST);
    expect(state.resources.static_group!.memberFields).toEqual({ wahl: 701, notiz: 702 });
    expect(Object.values(state.resources).some((resource) => resource.type === "group-member-field")).toBe(
      false,
    );
  });

  it("replaces a stale owner-local map after a successful live read", async () => {
    await run(["group", "31", "--with-member-fields", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    state.resources.static_group!.memberFields = { alt: 999 };
    await saveState(statePath, state);

    await run(["group", "31", "--with-member-fields", "--state", statePath]);

    const refreshed = await loadState(statePath, HOST);
    expect(refreshed.resources.static_group!.memberFields).toEqual({ wahl: 701, notiz: 702 });
  });

  it("a 403 on one group's fields does not abort a bulk adoption — it warns and adopts without them", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });
    const original = client.get.getMockImplementation()!;
    client.get.mockImplementation((async (path: string) => {
      if (path === "/groups/31/memberfields") throw new CtApiError("forbidden", 403, null);
      return original(path);
    }) as never);
    try {
      const snippet = await snippetFor([
        "group",
        "31",
        "--with-member-fields",
        "--dry-run",
        "--state",
        statePath,
      ]);
      expect(snippet).toContain('key: "'); // the group itself was still adopted
      expect(snippet).not.toContain("memberFields");
      expect(warnings.join("")).toMatch(/member fields could not be read/);
    } finally {
      client.get.mockImplementation(original as never);
      spy.mockRestore();
    }
  });

  it("emits no memberFields block for a group that has none", async () => {
    const snippet = await snippetFor([
      "group",
      "10",
      "--with-member-fields",
      "--dry-run",
      "--state",
      statePath,
    ]);
    expect(snippet).not.toContain("memberFields");
  });

  it("records an empty owner-local map when the live read succeeds with no fields", async () => {
    await run(["group", "10", "--with-member-fields", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.area_a!.memberFields).toEqual({});
  });
});
