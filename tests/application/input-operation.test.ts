import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInputSnapshot,
  getInputSnapshot,
  listInputSnapshots,
  validateProcessInput,
} from "../../src/application/operations/input.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("versioned process input", () => {
  it("validates required envelope fields", () => {
    expect(validateProcessInput({ schemaVersion: "", payload: {} })).toMatchObject({
      valid: false,
      digest: null,
      errors: expect.arrayContaining([
        { path: "/schemaVersion", message: expect.any(String) },
        { path: "/clientRevision", message: expect.any(String) },
      ]),
    });
  });

  it("uses a canonical digest independent of object key order", async () => {
    const left = await createInputSnapshot({
      schemaVersion: "1",
      clientRevision: "a",
      payload: { b: 2, a: 1 },
      persist: false,
    });
    const right = await createInputSnapshot({
      schemaVersion: "1",
      clientRevision: "a",
      payload: { a: 1, b: 2 },
      persist: false,
    });
    expect(left.value.digest).toBe(right.value.digest);
  });

  it("persists immutable snapshots and returns the original record on duplicate writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ct-input-"));
    directories.push(cwd);
    const request = { schemaVersion: "1", clientRevision: "r1", payload: { ok: true }, cwd };
    const first = await createInputSnapshot(request, { now: () => new Date("2026-01-01T00:00:00Z") });
    const second = await createInputSnapshot(request, { now: () => new Date("2027-01-01T00:00:00Z") });
    expect(second.value).toEqual(first.value);
    expect((await getInputSnapshot(cwd, first.value.digest)).value).toEqual(first.value);
    expect((await listInputSnapshots(cwd)).snapshots).toEqual([first.value]);
  });
});
