import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION, resolveEntry, versionLine } from "../src/version.js";
import { buildProgram } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("VERSION (#116)", () => {
  it("is the version declared in package.json, not the old 0.0.0 literal", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("0.0.0");
  });

  it("is what the program reports for --version", () => {
    expect(buildProgram().version()).toContain(VERSION);
  });
});

describe("resolveEntry", () => {
  it("returns the module's own path when it exists on disk", () => {
    const here = new URL("../src/version.ts", import.meta.url);
    expect(resolveEntry(here.href)).toBe(here.pathname);
  });

  it("falls back to the executable for bun's embedded filesystem", () => {
    // A compiled `bun build --compile` binary resolves to /$bunfs/..., which bun's
    // fs shim reports as existing but which means nothing to the user.
    expect(resolveEntry(pathToFileURL("/$bunfs/root/index.js").href)).toBe(process.execPath);
  });

  it("falls back to the executable for a path that is not on disk", () => {
    expect(resolveEntry(pathToFileURL("/no/such/place/index.js").href)).toBe(process.execPath);
  });

  it("falls back to the executable for a non-file URL", () => {
    expect(resolveEntry("https://example.invalid/index.js")).toBe(process.execPath);
  });
});

describe("versionLine", () => {
  it("answers both 'which version' and 'which ct'", () => {
    const here = new URL("../src/version.ts", import.meta.url);
    expect(versionLine(here.href)).toBe(`${VERSION} (${here.pathname})`);
  });
});
