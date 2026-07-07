import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBackup } from "../src/engine/backup.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

describe("writeBackup", () => {
  it("writes a timestamped JSON snapshot of actual resources", async () => {
    dir = await mkdtemp(join(tmpdir(), "ct-backup-test-"));
    const actual = new Map<string, Record<string, unknown>>([["mainz", { name: "Mainz" }]]);
    const now = new Date("2026-07-07T14:30:00.000Z");
    const path = await writeBackup(dir, "https://x.church.tools", actual, now);
    expect(path).toBe(join(dir, "ct-backup-2026-07-07T14-30-00.000Z.json"));
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed).toEqual({
      host: "https://x.church.tools",
      capturedAt: "2026-07-07T14:30:00.000Z",
      resources: { mainz: { name: "Mainz" } },
    });
  });

  it("creates the backup directory if it does not exist", async () => {
    const base = await mkdtemp(join(tmpdir(), "ct-backup-test-"));
    dir = base;
    const nested = join(base, "backups");
    const path = await writeBackup(nested, "h", new Map(), new Date("2026-01-01T00:00:00.000Z"));
    expect(await readFile(path, "utf8")).toContain('"resources": {}');
  });
});
