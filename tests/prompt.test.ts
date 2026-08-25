import { PassThrough } from "node:stream";
import { describe, it, expect } from "vitest";
import { askSecret, confirm, confirmTyped, confirmEnv } from "../src/ui/prompt.js";

describe("askSecret", () => {
  it("returns the secret without echoing it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let displayed = "";
    output.on("data", (chunk) => {
      displayed += chunk.toString();
    });

    const answer = askSecret("Token: ", { input, output });
    input.end("super-secret\n");

    await expect(answer).resolves.toBe("super-secret");
    expect(displayed).toBe("Token: \n");
    expect(displayed).not.toContain("super-secret");
  });
});

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

describe("confirmEnv (protected environment)", () => {
  it("accepts a --confirm-env flag that exactly matches the env name", async () => {
    expect(await confirmEnv("prod", { confirmFlag: "prod" })).toBe(true);
  });

  it("rejects a --confirm-env flag that does not match", async () => {
    expect(await confirmEnv("prod", { confirmFlag: "dev" })).toBe(false);
    expect(await confirmEnv("prod", { confirmFlag: "" })).toBe(false);
  });

  it("requires a typed match interactively, even when a force/assumeYes would normally skip", async () => {
    // No confirmFlag → the typed environment name is mandatory. There is no force/assumeYes escape:
    // confirmEnv exposes none, so a protected apply/destroy can never auto-approve past it.
    expect(await confirmEnv("prod", { isTTY: true, ask: async () => "prod" })).toBe(true);
    expect(await confirmEnv("prod", { isTTY: true, ask: async () => "nope" })).toBe(false);
  });

  it("refuses on a non-TTY with no --confirm-env (CI must pass the flag)", async () => {
    expect(await confirmEnv("prod", { isTTY: false })).toBe(false);
  });
});
