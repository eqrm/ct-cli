import { describe, it, expect } from "vitest";
import { resolveBackupDir } from "../src/commands/apply.js";

describe("resolveBackupDir", () => {
  it("prefers the explicit flag", () => {
    expect(resolveBackupDir("./out", "cfg/ct-state.json", {})).toBe("./out");
  });
  it("falls back to CT_BACKUP_DIR", () => {
    expect(resolveBackupDir(undefined, "cfg/ct-state.json", { CT_BACKUP_DIR: "/b" })).toBe("/b");
  });
  it("defaults to a backups/ dir beside the state file", () => {
    expect(resolveBackupDir(undefined, "cfg/ct-state.json", {})).toBe("cfg/backups");
  });
});
