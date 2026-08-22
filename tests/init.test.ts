import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeConfigRepository } from "../src/init.js";
import { loadEnvProfile } from "../src/env/envs.js";
import { loadConfig } from "../src/config/load.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ct-init-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("initializeConfigRepository", () => {
  it("creates a minimal config repository with a usable environment", async () => {
    const directory = await temporaryDirectory();

    const result = await initializeConfigRepository(directory, {
      host: "https://example.church.tools/",
      environment: "prod",
      git: false,
      yes: true,
    });

    expect(result.files).toEqual(["ct.config.ts", "ct.envs.json", ".gitignore"]);
    await expect(access(join(directory, "config"))).resolves.toBeUndefined();
    await expect(access(join(directory, "blueprints"))).resolves.toBeUndefined();
    expect(await loadEnvProfile("prod", join(directory, "ct.envs.json"))).toMatchObject({
      host: "https://example.church.tools",
      name: "prod",
      statePath: "ct-state.prod.json",
    });
    await expect(loadConfig(join(directory, "ct.config.ts"))).resolves.toMatchObject({
      resources: [],
      permissions: [],
    });
    expect(await readFile(join(directory, ".gitignore"), "utf8")).not.toMatch(/^ct-state/m);
  });

  it("creates an empty, valid environments map when no host is supplied", async () => {
    const directory = await temporaryDirectory();
    await initializeConfigRepository(directory, { yes: true });

    expect(JSON.parse(await readFile(join(directory, "ct.envs.json"), "utf8"))).toEqual({
      environments: {},
    });
  });

  it("collects optional answers interactively", async () => {
    const directory = await temporaryDirectory();
    const answers = ["https://example.church.tools", "dev", "yes"];
    const gitInit = vi.fn(async () => undefined);

    const result = await initializeConfigRepository(directory, {
      isTTY: true,
      ask: async () => answers.shift()!,
      runGitInit: gitInit,
    });

    expect(result.environment).toBe("dev");
    expect(result.gitInitialized).toBe(true);
    expect(gitInit).toHaveBeenCalledWith(directory);
  });

  it("refuses to overwrite existing scaffold files before writing anything", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "ct.envs.json"), "keep me", "utf8");

    await expect(initializeConfigRepository(directory, { yes: true })).rejects.toThrow(
      /refusing to overwrite existing ct\.envs\.json/,
    );
    await expect(readFile(join(directory, "ct.config.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(directory, "ct.envs.json"), "utf8")).toBe("keep me");
  });

  it("checks for conflicts before asking questions", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "ct.config.ts"), "keep me", "utf8");
    const ask = vi.fn(async () => "");

    await expect(initializeConfigRepository(directory, { isTTY: true, ask })).rejects.toThrow(
      /refusing to overwrite/,
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it("validates host and environment options", async () => {
    const directory = await temporaryDirectory();
    await expect(initializeConfigRepository(directory, { host: "not a url", yes: true })).rejects.toThrow(
      /Invalid ChurchTools URL/,
    );
    await expect(initializeConfigRepository(directory, { environment: "prod", yes: true })).rejects.toThrow(
      /--env requires --host/,
    );
  });
});
