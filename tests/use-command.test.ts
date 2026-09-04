import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const host = "https://example.church.tools";
const request = vi.fn(async () => {
  throw new Error("ct use must never write ChurchTools");
});
const get = vi.fn(async (path: string) => {
  if (path === "/groups/4711") {
    return { id: 4711, name: "OJAHR Fuzzies", information: { groupTypeId: 17, campusId: 2 } };
  }
  throw new Error(`unexpected GET ${path}`);
});

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get, request }, me: { id: 1 } })),
}));

const { useCommand } = await import("../src/commands/use.js");

describe("ct use", () => {
  let directory: string;
  let statePath: string;
  const originalHost = process.env.CT_HOST;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ct-use-command-"));
    statePath = join(directory, "ct-state.json");
    process.env.CT_HOST = host;
    request.mockClear();
    get.mockClear();
  });

  afterEach(async () => {
    if (originalHost === undefined) delete process.env.CT_HOST;
    else process.env.CT_HOST = originalHost;
    await rm(directory, { recursive: true, force: true });
  });

  it("supports the deterministic form and is byte-idempotent without a ChurchTools write", async () => {
    await useCommand().parseAsync(["group", "4711", "--key", "ojahr_fuzzies", "--state", statePath], {
      from: "user",
    });
    const first = await readFile(statePath, "utf8");
    await useCommand().parseAsync(["group", "4711", "--key", "ojahr_fuzzies", "--state", statePath], {
      from: "user",
    });
    expect(await readFile(statePath, "utf8")).toBe(first);
    expect(JSON.parse(first).externals.ojahr_fuzzies).toMatchObject({
      type: "group",
      id: 4711,
      identity: { name: "OJAHR Fuzzies", groupTypeId: 17 },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses fuzzy selection without a TTY before contacting ChurchTools", async () => {
    await expect(
      useCommand().parseAsync(["group", "OJAHR", "--state", statePath], { from: "user" }),
    ).rejects.toThrow(/Non-interactive use requires an exact numeric id and --key/);
    expect(get).not.toHaveBeenCalled();
  });
});
