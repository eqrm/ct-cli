import { describe, it, expect } from "vitest";
import { confirm, confirmTyped } from "../src/ui/prompt.js";

describe("confirm", () => {
  it("short-circuits true with assumeYes", async () => {
    expect(await confirm("go?", { assumeYes: true })).toBe(true);
  });
  it("returns false on a non-TTY without assumeYes", async () => {
    expect(await confirm("go?", { isTTY: false })).toBe(false);
  });
  it("accepts y/yes", async () => {
    expect(await confirm("go?", { isTTY: true, ask: async () => "y" })).toBe(true);
    expect(await confirm("go?", { isTTY: true, ask: async () => "Yes" })).toBe(true);
  });
  it("rejects anything else", async () => {
    expect(await confirm("go?", { isTTY: true, ask: async () => "" })).toBe(false);
    expect(await confirm("go?", { isTTY: true, ask: async () => "n" })).toBe(false);
  });
});

describe("confirmTyped", () => {
  it("short-circuits true with force", async () => {
    expect(await confirmTyped("old_team", { force: true })).toBe(true);
  });
  it("requires an exact match", async () => {
    expect(await confirmTyped("old_team", { isTTY: true, ask: async () => "old_team" })).toBe(true);
    expect(await confirmTyped("old_team", { isTTY: true, ask: async () => "nope" })).toBe(false);
  });
  it("returns false on a non-TTY without force", async () => {
    expect(await confirmTyped("x", { isTTY: false })).toBe(false);
  });
});
