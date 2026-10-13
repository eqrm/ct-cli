import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawPermission } from "../src/permissions/grants.js";
import type { State } from "../src/state/state.js";

const rows: RawPermission[] = [
  { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
];
const getMock = vi.fn(async (): Promise<RawPermission[]> => rows);
const catalogs: Record<string, unknown[]> = {};
const getAllMock = vi.fn(async (path: string) => ({ data: catalogs[path] ?? [] }));

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock, getAll: getAllMock }, me: { id: 1 } })),
}));

const { adoptCommand } = await import("../src/commands/adopt.js");

const HOST = "https://mychurch.church.tools";
const originalHost = process.env.CT_HOST;

async function run(args: string[]): Promise<void> {
  await adoptCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
  getMock.mockClear();
  getAllMock.mockClear();
  for (const k of Object.keys(catalogs)) delete catalogs[k];
  process.env.CT_HOST = HOST;
});

afterEach(() => {
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
});

describe("ct adopt grants", () => {
  it("fetches the domain's rows and prints a config block to stdout", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["grants", "group_type_role", "42", "--state", "/does/not/exist.json"]);
    } finally {
      spy.mockRestore();
    }
    expect(getMock).toHaveBeenCalledWith("/permissions/group_type_role/42");
    expect(writes.join("")).toContain("ct.groupTypeRole({");
  });

  it("prints the portable groupType + role form for a group_type_role whose type and role map", async () => {
    catalogs["/group/roles"] = [{ id: 42, name: "Leiter", groupTypeId: 7 }];
    catalogs["/group/grouptypes"] = [{ id: 7, name: "Team" }];
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["grants", "group_type_role", "42", "--state", "/does/not/exist.json"]);
    } finally {
      spy.mockRestore();
    }
    const out = writes.join("");
    expect(out).toContain('groupType: "team"');
    expect(out).toContain('role: "Leiter"');
    expect(out).not.toMatch(/\bid: 42/);
  });

  it("falls back to the numeric id when the group_type_role cannot be mapped", async () => {
    catalogs["/group/roles"] = [{ id: 42, name: "Leiter", groupTypeId: 7 }]; // type 7 not in catalog
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["grants", "group_type_role", "42", "--state", "/does/not/exist.json"]);
    } finally {
      spy.mockRestore();
    }
    const out = writes.join("");
    expect(out).toContain("id: 42,");
    expect(out).not.toMatch(/^\s*groupType:/m);
  });

  it("accepts the hyphenated domain type spelling", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await run(["grants", "group-role", "7", "--state", "/does/not/exist.json"]);
    } finally {
      spy.mockRestore();
    }
    expect(getMock).toHaveBeenCalledWith("/permissions/group_role/7");
  });

  it("rejects an invalid domain type before any API call", async () => {
    await expect(run(["grants", "persons", "1"])).rejects.toThrow(/Invalid domain type/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer domainId before any API call", async () => {
    await expect(run(["grants", "group_role", "3abc"])).rejects.toThrow(/expected a non-negative integer/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("still runs the plain `adopt <type> <id>` action (subcommand does not shadow it)", async () => {
    // "campus" is not the "grants" subcommand → the base action runs and hits the resource path.
    getMock.mockResolvedValueOnce({ id: 0, name: "Mainz", shorty: "MZ" } as never);
    await run(["campus", "0", "--dry-run"]);
    expect(getMock).toHaveBeenCalledWith("/campuses/0");
  });

  it("actually honours --state (regression, #51): resolves a scoped grant's dataId to the group's key from the given state file, not the default", async () => {
    // Both `adopt` (the parent) and `grants` (this subcommand) declare `-s/--state` — a Commander
    // option-name collision that used to silently swallow the value into neither level's `.opts()`,
    // so `--state` was never actually honoured here (only ever exercised with the default/missing
    // state file, which no test caught). Prove it now by giving a scoped grant a group that is ONLY
    // resolvable via a real, non-default state file.
    const dir = mkdtempSync(join(tmpdir(), "ct-adopt-grants-state-"));
    const statePath = join(dir, "custom-state.json");
    const state: State = {
      version: 1,
      host: HOST,
      resources: { kids: { type: "group", id: 7, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" } },
    };
    writeFileSync(statePath, JSON.stringify(state));

    getMock.mockResolvedValueOnce([
      { authId: 1104, dataId: 7, type: "grant", domainId: 42 }, // churchgroup:view group, scoped to group #7
    ] as never);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["grants", "group_role", "42", "--state", statePath]);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    // Resolved via the custom state file's "kids" key — proves --state was actually read, not
    // silently ignored in favour of an empty default state (which would leave this as an "unmanaged"
    // WARNING comment instead of a real scope entry).
    expect(writes.join("")).toContain('scope: ["kids"]');
  });
});
