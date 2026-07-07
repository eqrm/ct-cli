import { describe, it, expect } from "vitest";
import { isMainModule } from "../src/isMain.js";

const moduleUrl = "file:///repo/dist/index.js"; // → /repo/dist/index.js

describe("isMainModule", () => {
  it("is true when invoked directly (paths already equal)", () => {
    expect(isMainModule("/repo/dist/index.js", moduleUrl, (p) => p)).toBe(true);
  });

  it("is true when invoked via a symlink that resolves to the module (the ct/brew case)", () => {
    const realpath = (p: string) => (p === "/opt/homebrew/bin/ct" ? "/repo/dist/index.js" : p);
    expect(isMainModule("/opt/homebrew/bin/ct", moduleUrl, realpath)).toBe(true);
  });

  it("is false when imported by another entrypoint (e.g. the test runner)", () => {
    expect(isMainModule("/repo/node_modules/.bin/vitest", moduleUrl, (p) => p)).toBe(false);
  });

  it("is false when argv1 is undefined", () => {
    expect(isMainModule(undefined, moduleUrl)).toBe(false);
  });

  it("falls back to a plain comparison when realpath throws", () => {
    const realpath = () => {
      throw new Error("ENOENT");
    };
    expect(isMainModule("/repo/dist/index.js", moduleUrl, realpath)).toBe(true);
  });
});
