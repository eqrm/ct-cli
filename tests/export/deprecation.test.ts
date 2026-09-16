import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("can be suppressed so CI logs stay readable", () => {
    vi.stubEnv("CT_NO_DEPRECATION_WARNING", "1");
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    warnConfigDeprecated();
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes to stderr, never stdout — stdout carries --json payloads", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    warnConfigDeprecated();
    expect(err).toHaveBeenCalledTimes(1);
    expect(outSpy).not.toHaveBeenCalled();
  });
});
