/**
 * Command-level behaviour for `ct destroy` (#17 items 1–3), mocking only the
 * session + backup so the real command wiring runs:
 *  - preventDestroy is read from STATE, and destroy loads NO config file at all
 *    (no loadConfig mock, no config on disk) — so protection survives dropping a
 *    resource from config, and a config eval error can never block a teardown.
 *  - delete ordering honours the live /groups/hierarchies edges: a child group is
 *    deleted before its parent even when --target lists the parent first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { CtApiError } from "../src/api/ctClient.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Call {
  method: string;
  path: string;
}

const calls: Call[] = [];
const getMock = vi.fn(async (path: string) => {
  if (path === "/groups/hierarchies") {
    return [
      { groupId: 1, parents: [] },
      { groupId: 2, parents: [1] }, // kids (2) → area (1)
    ];
  }
  return { name: path }; // itemPath backup fetch — any body
});
const requestMock = vi.fn(async (method: string, path: string) => {
  calls.push({ method, path });
  return {};
});

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock, request: requestMock }, me: { id: 1 } })),
}));

vi.mock("../src/engine/backup.js", () => ({
  writeBackup: vi.fn(async () => "backup.json"),
}));

const { destroyCommand } = await import("../src/commands/destroy.js");
const { saveState, loadState, emptyState } = await import("../src/state/state.js");

const statePath = join(tmpdir(), `ct-cli-destroy-cmd-${process.pid}.json`);
const HOST = "https://mychurch.church.tools";
const originalHost = process.env.CT_HOST;

function group(key: string, id: number, extra: Record<string, unknown> = {}) {
  return { type: "group", id, key, fields: {}, adoptedAt: "t", updatedAt: "t", ...extra };
}

async function runDestroy(args: string[]): Promise<void> {
  await destroyCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
  calls.length = 0;
  requestMock.mockClear();
  getMock.mockClear();
  process.env.CT_HOST = HOST;
});

afterEach(async () => {
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
  await rm(statePath, { force: true });
});

describe("ct destroy (command level)", () => {
  it("blocks a target protected in STATE — with no config file loaded at all (#17 items 2+3)", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1, { preventDestroy: true });
    await saveState(statePath, state);

    await expect(runDestroy(["--target", "area", "--state", statePath, "--force"])).rejects.toThrow(
      /preventDestroy is set \(in state\) for: area/,
    );
    // Nothing was deleted, and no config was consulted (the mock set has no loadConfig).
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("deletes a child before its parent using live hierarchy edges, ignoring --target order (#17 item 1)", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1);
    state.resources.kids = group("kids", 2);
    await saveState(statePath, state);

    // --target lists the PARENT first; a tier-only order would DELETE /groups/1 while kids still refs it.
    await runDestroy(["--target", "area,kids", "--state", statePath, "--force"]);

    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual(["/groups/2", "/groups/1"]); // child (kids #2) before parent (area #1)
    const after = await loadState(statePath, HOST);
    expect(after.resources).toEqual({});
  });

  it("aborts before any DELETE when a target's backup fetch fails with a non-404", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1);
    state.resources.kids = group("kids", 2);
    await saveState(statePath, state);

    const { CtApiError } = await import("../src/api/ctClient.js");
    getMock.mockImplementation(async (path: string) => {
      if (path === "/groups/hierarchies") {
        return [
          { groupId: 1, parents: [] },
          { groupId: 2, parents: [1] },
        ];
      }
      if (path === "/groups/2") throw new CtApiError("Server Error", 500, null);
      return { name: path };
    });
    const originalExitCode = process.exitCode;

    try {
      await runDestroy(["--target", "area,kids", "--state", statePath, "--force"]);

      // The 500 on kids' backup fetch must abort the whole run before any DELETE:
      // deleting an unbacked-up target is exactly what the pre-destroy backup guards against.
      expect(requestMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      const after = await loadState(statePath, HOST);
      expect(Object.keys(after.resources).sort()).toEqual(["area", "kids"]);
    } finally {
      process.exitCode = originalExitCode;
      getMock.mockImplementation(async (path: string) => {
        if (path === "/groups/hierarchies") {
          return [
            { groupId: 1, parents: [] },
            { groupId: 2, parents: [1] },
          ];
        }
        return { name: path };
      });
    }
  });
});

/**
 * The EXPLICIT destructive operation for a group member field (#135). `apply` can never delete one
 * — a field dropped from config produces no desired key, so the diff engine is structurally unable
 * to propose it — so this command is the only path, and it inherits the group's guardrails.
 */
describe("ct destroy --member-field (#135)", () => {
  const rows = [{ id: 701, type: "group", referenceName: "wahl", name: "Wahl", fieldTypeCode: "text" }];

  beforeEach(() => {
    getMock.mockImplementation((async (path: string) => {
      if (path === "/groups/hierarchies") return [];
      if (path === "/groups/1/memberfields") return rows;
      return { name: path };
    }) as never);
  });

  it("deletes the field through its group-scoped path and drops it from state", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1, { memberFields: { wahl: 701 } });
    await saveState(statePath, state);

    await runDestroy(["--member-field", "area::wahl", "--state", statePath, "--force"]);

    expect(calls).toEqual([{ method: "DELETE", path: "/groups/1/memberfields/group/701" }]);
    const after = await loadState(statePath, HOST);
    // The owning GROUP survives — only the field it owns was destroyed.
    expect(after.resources.area).toBeDefined();
    expect(after.resources.area!.memberFields).toBeUndefined();
  });

  it("is refused when the owning group is protected — protecting a group protects its fields", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1, { preventDestroy: true });
    await saveState(statePath, state);

    await expect(
      runDestroy(["--member-field", "area::wahl", "--state", statePath, "--force"]),
    ).rejects.toThrow(/preventDestroy is set \(in state\) for group "area"/);
    expect(calls).toEqual([]);
  });

  it("rejects a malformed identity and an unmanaged group before any network call", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1);
    await saveState(statePath, state);

    await expect(runDestroy(["--member-field", "wahl", "--state", statePath, "--force"])).rejects.toThrow(
      /not a group member field identity/,
    );
    await expect(
      runDestroy(["--member-field", "nope::wahl", "--state", statePath, "--force"]),
    ).rejects.toThrow(/no managed group "nope"/);
    expect(calls).toEqual([]);
  });

  it("a field that could not be deleted holds back its owning group's destroy", async () => {
    // Otherwise the group destroy takes the field with it as collateral — right after the run
    // printed "Nothing further was deleted" — and the failure the user was told about becomes an
    // irreversible delete they were told did not happen.
    const state = emptyState(HOST);
    state.resources.area = group("area", 1, { memberFields: { wahl: 701 } });
    await saveState(statePath, state);
    requestMock.mockImplementationOnce((async (method: string, path: string) => {
      calls.push({ method, path });
      throw new CtApiError("boom", 500, null);
    }) as never);

    await runDestroy(["--member-field", "area::wahl", "--target", "area", "--state", statePath, "--force"]);

    expect(calls).toEqual([{ method: "DELETE", path: "/groups/1/memberfields/group/701" }]);
    expect(process.exitCode).toBe(1);
    const after = await loadState(statePath, HOST);
    expect(after.resources.area).toBeDefined(); // the group was NOT destroyed
    process.exitCode = 0;
  });

  it("matches the state entry in its normalised spelling, so no stale id is left behind", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1, { memberFields: { wahl: 701 } });
    await saveState(statePath, state);

    // `--member-field area::Wahl` matches the live row (matchesLocalKey slugs), so it must also
    // match the state entry the apply wrote under the slugged key.
    await runDestroy(["--member-field", "area::Wahl", "--state", statePath, "--force"]);

    expect(calls).toEqual([{ method: "DELETE", path: "/groups/1/memberfields/group/701" }]);
    const after = await loadState(statePath, HOST);
    expect(after.resources.area!.memberFields).toBeUndefined();
  });

  it("still refuses to delete anything with neither --target nor --member-field", async () => {
    await saveState(statePath, emptyState(HOST));
    await expect(runDestroy(["--state", statePath, "--force"])).rejects.toThrow(
      /Destroy never deletes implicitly/,
    );
  });
});
