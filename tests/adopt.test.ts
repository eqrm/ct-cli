import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeCampus = { id: 0, name: "Mainz", shorty: "MZ" };
const getMock = vi.fn(async () => fakeCampus);

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock }, me: { id: 1 } })),
}));

const { adoptCommand } = await import("../src/commands/adopt.js");
const { loadState } = await import("../src/state/state.js");

const statePath = join(tmpdir(), `ct-cli-adopt-${process.pid}.json`);
const HOST = "https://eqrm.church.tools";

async function runAdopt(args: string[]): Promise<void> {
  await adoptCommand().parseAsync(args, { from: "user" });
}

const originalHost = process.env.CT_HOST;

beforeEach(() => {
  getMock.mockClear();
  process.env.CT_HOST = HOST; // host is now resolved from env/stored login, not a hardcoded default
});

afterEach(async () => {
  if (originalHost === undefined) {
    delete process.env.CT_HOST;
  } else {
    process.env.CT_HOST = originalHost;
  }
  await rm(statePath, { force: true });
});

describe("ct adopt", () => {
  it("adopts a campus (id 0) into the state file", async () => {
    await runAdopt(["campus", "0", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.mz).toMatchObject({
      type: "campus",
      id: 0,
      key: "mz",
      fields: { name: "Mainz", shorty: "MZ" },
    });
  });

  it("is idempotent — re-adopting keeps a single entry", async () => {
    await runAdopt(["campus", "0", "--state", statePath]);
    await runAdopt(["campus", "0", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(Object.keys(state.resources)).toHaveLength(1);
  });

  it("honours an explicit --key", async () => {
    await runAdopt(["campus", "0", "--key", "mainz", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.mainz?.id).toBe(0);
  });

  it("--dry-run does not write the state file", async () => {
    await runAdopt(["campus", "0", "--dry-run", "--state", statePath]);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unknown resource type before any API call", async () => {
    await expect(runAdopt(["widget", "1", "--state", statePath])).rejects.toThrow(/Adoptable types/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer id (trailing garbage) before any API call", async () => {
    await expect(runAdopt(["campus", "3abc", "--state", statePath])).rejects.toThrow(
      /expected a non-negative integer/,
    );
    await expect(runAdopt(["campus", "0x10", "--state", statePath])).rejects.toThrow(
      /expected a non-negative integer/,
    );
    expect(getMock).not.toHaveBeenCalled();
  });
});
