import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { __resetDeprecationWarning, warnConfigDeprecated } from "../../src/config/deprecation.js";

afterEach(() => {
  __resetDeprecationWarning();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TypeScript config DSL deprecation", () => {
  it("names the successor and the removal version", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnConfigDeprecated();
    const message = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(message).toContain("terraform-provider-churchtools");
    expect(message).toContain("ct export tf");
    expect(message).toContain("5.0");
  });

  it("warns once per process, not once per resource", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnConfigDeprecated();
    warnConfigDeprecated();
    warnConfigDeprecated();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each(["1", "true", "yes"])("can be suppressed with %s so CI logs stay readable", (value) => {
    vi.stubEnv("CT_NO_DEPRECATION_WARNING", value);
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnConfigDeprecated();
    expect(spy).not.toHaveBeenCalled();
  });

  it("still warns when the variable is set to an empty value", () => {
    vi.stubEnv("CT_NO_DEPRECATION_WARNING", "");
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnConfigDeprecated();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("writes to stderr, never stdout — stdout carries --json payloads", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    warnConfigDeprecated();
    expect(err).toHaveBeenCalledTimes(1);
    expect(outSpy).not.toHaveBeenCalled();
  });
});

describe("the call site that makes the warning visible", () => {
  it("fires when a config is loaded — the only DSL entry point", async () => {
    __resetDeprecationWarning();
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await loadConfig(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/sample.config.ts"));
    const message = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(message).toContain("frozen");
  });
});
