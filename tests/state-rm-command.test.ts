/**
 * `ct state rm` — the missing inverse of `ct adopt` (#122).
 *
 * `ct adopt` wrote a state entry and nothing removed one. `ct destroy` is the opposite of what
 * un-adopting means (it deletes the resource IN ChurchTools), so backing out an adoption meant
 * hand-editing `ct-state.<env>.json` — the very file the tool insists is its own. Adopt-then-declare
 * is the documented loop, so a wrong adoption is normal, not exotic: leaving the entry in makes
 * `plan` report a DESTROY on a host where nothing is wrong, and the offline config-matches-state
 * check cannot be satisfied without editing the file the check is checking.
 *
 * The load-bearing property is the one asserted first: NO ChurchTools call, ever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, loadState, saveState } from "../src/state/state.js";

const authedSession = vi.fn(async () => {
  throw new Error("ct state rm must never contact ChurchTools");
});
vi.mock("../src/api/session.js", () => ({ authedSession }));

const { stateCommand } = await import("../src/commands/state.js");

const HOST = "https://mychurch.church.tools";
let dir: string;
let statePath: string;
let configPath: string;
const originalHost = process.env.CT_HOST;
const originalConfig = process.env.CT_CONFIG;

async function run(args: string[]): Promise<void> {
  const key = args[1];
  await stateCommand().parseAsync(
    ["rm", ...args, ...(key && !args.includes("--dry-run") ? ["--confirm-key", key] : [])],
    { from: "user" },
  );
}

/** A state file holding two adopted role definitions and one campus. */
async function seedState(): Promise<void> {
  const state = emptyState(HOST);
  for (const [key, id] of [
    ["appmodule_write", 51],
    ["appmodule_read", 52],
  ] as const) {
    state.resources[key] = {
      type: "group-role",
      id,
      key,
      fields: { name: key },
      adoptedAt: "t",
      updatedAt: "t",
    };
  }
  state.resources.mainz = {
    type: "campus",
    id: 0,
    key: "mainz",
    fields: { name: "Mainz" },
    adoptedAt: "t",
    updatedAt: "t",
  };
  state.resources.youth = {
    type: "group",
    id: 3090,
    key: "youth",
    fields: { name: "Youth" },
    adoptedAt: "t",
    updatedAt: "t",
  };
  await saveState(statePath, state);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-state-rm-"));
  statePath = join(dir, "ct-state.json");
  configPath = join(dir, "ct.config.ts");
  process.env.CT_HOST = HOST;
  process.env.CT_CONFIG = configPath;
  // A config that declares NOTHING — the normal state after deleting a wrong declaration.
  await writeFile(configPath, "export default () => {};");
  await seedState();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
  if (originalConfig === undefined) delete process.env.CT_CONFIG;
  else process.env.CT_CONFIG = originalConfig;
  await rm(dir, { recursive: true, force: true });
});

describe("ct state rm (#122)", () => {
  it("requires typed confirmation before the low-level state mutation", async () => {
    await stateCommand().parseAsync(["rm", "group", "youth", "--state", statePath], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
    expect((await loadState(statePath, HOST)).resources.youth).toBeDefined();
    process.exitCode = 0;
  });

  it("removes the entry and contacts nothing", async () => {
    await run(["group-role", "appmodule_write", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.appmodule_write).toBeUndefined();
    expect(authedSession).not.toHaveBeenCalled();
  });

  it("leaves every other entry untouched", async () => {
    await run(["group-role", "appmodule_write", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(Object.keys(state.resources).sort()).toEqual(["appmodule_read", "mainz", "youth"]);
    expect(state.resources.mainz?.id).toBe(0);
  });

  // A key can be named by a PERMISSION declaration without being declared as a resource. A
  // resources-only guard waves those through, and the breakage surfaces one command later as a
  // `ct plan` hard error ("does not resolve to a managed group") — after the state file was written.
  it("refuses a key a permission DOMAIN still names, not just a declared resource", async () => {
    await writeFile(
      configPath,
      `export default (ct) => { ct.groupRole({ key: "youth_leiter", group: "youth", role: "Leiter", grants: ["churchcore:administer settings"] }); };`,
    );
    await expect(run(["group", "youth", "--state", statePath])).rejects.toThrow(
      /still declared or referenced in the config/,
    );
    const state = await loadState(statePath, HOST);
    expect(state.resources.youth).toBeDefined();
  });

  it("refuses a key a permission SCOPE still names", async () => {
    await writeFile(
      configPath,
      `export default (ct) => { ct.groupRole({ key: "p", id: 77, grants: [{ right: "churchgroup:view group", scope: ["youth"] }] }); };`,
    );
    await expect(run(["group", "youth", "--state", statePath])).rejects.toThrow(
      /still declared or referenced in the config/,
    );
    const state = await loadState(statePath, HOST);
    expect(state.resources.youth).toBeDefined();
  });

  it("still removes a key no declaration — resource or permission — mentions", async () => {
    await writeFile(
      configPath,
      `export default (ct) => { ct.groupRole({ key: "p", id: 77, grants: [{ right: "churchgroup:view group", scope: ["someone_else"] }] }); };`,
    );
    await run(["group", "youth", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.youth).toBeUndefined();
  });

  it("refuses a key the config still declares — that would plan a CREATE for a live resource", async () => {
    await writeFile(
      configPath,
      `export default (ct) => { ct.roleDefinition({ key: "appmodule_write", name: "Write", groupTypeId: 2 }); };`,
    );
    await expect(run(["group-role", "appmodule_write", "--state", statePath])).rejects.toThrow(
      /still declared or referenced in the config/,
    );
    const state = await loadState(statePath, HOST);
    expect(state.resources.appmodule_write).toBeDefined();
  });

  it("--force removes it anyway, for deleting both in one change", async () => {
    await writeFile(
      configPath,
      `export default (ct) => { ct.roleDefinition({ key: "appmodule_write", name: "Write", groupTypeId: 2 }); };`,
    );
    await run(["group-role", "appmodule_write", "--state", statePath, "--force"]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.appmodule_write).toBeUndefined();
  });

  it("--dry-run writes nothing", async () => {
    await run(["group-role", "appmodule_write", "--state", statePath, "--dry-run"]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.appmodule_write).toBeDefined();
  });

  it("rejects a key that is not in state, pointing at `ct state list`", async () => {
    await expect(run(["group-role", "nope", "--state", statePath])).rejects.toThrow(/ct state list/);
  });

  it("rejects a type/key mismatch instead of removing the wrong entry", async () => {
    await expect(run(["campus", "appmodule_write", "--state", statePath])).rejects.toThrow(
      /is a group-role \(#51\), not a campus/,
    );
    const state = await loadState(statePath, HOST);
    expect(state.resources.appmodule_write).toBeDefined();
  });

  it("rejects an unknown resource type", async () => {
    await expect(run(["widget", "appmodule_write", "--state", statePath])).rejects.toThrow(/Adoptable types/);
  });

  it("still works when the config cannot be read — that is when you need it most", async () => {
    // Backing out an adoption is exactly what you do while the config is mid-edit.
    await writeFile(configPath, "export default (ct) => { throw new Error('broken'); };");
    await run(["group-role", "appmodule_write", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.appmodule_write).toBeUndefined();
  });
});
