import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeConfigRepository } from "../src/init.js";
import { initCommand } from "../src/commands/init.js";
import { loadEnvProfile } from "../src/env/envs.js";
import { loadConfig } from "../src/config/load.js";
import { loadState } from "../src/state/state.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ct-init-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("initializeConfigRepository", () => {
  it("keeps the standard init scaffold and environment defaults unchanged", async () => {
    const directory = await temporaryDirectory();

    const result = await initializeConfigRepository(directory, {
      host: "https://example.church.tools/",
      environment: "prod",
      git: false,
      yes: true,
    });

    expect(result.files).toEqual(["ct.config.ts", "ct.envs.json", ".gitignore"]);
    expect(result.template).toBe("standard");
    expect(result.directories).toEqual(["config", "blueprints"]);
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
    await expect(access(join(directory, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, "instances"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a portable process quickstart with a root config and host-bound instance", async () => {
    const directory = await temporaryDirectory();

    const result = await initializeConfigRepository(directory, {
      template: "process",
      host: "https://Example.Church.Tools/",
      environment: "prod",
      protected: true,
      git: false,
      yes: true,
    });

    const statePath = "instances/example.church.tools/ct-state.example.church.tools.json";
    expect(result).toMatchObject({
      template: "process",
      host: "https://example.church.tools",
      hostname: "example.church.tools",
      environment: "prod",
      protected: true,
      gitInitialized: false,
    });
    expect(result.files).toEqual(["ct.config.ts", "ct.envs.json", ".gitignore", "README.md", statePath]);
    expect(result.directories).toEqual([
      "blueprint",
      "configs",
      "instances",
      "instances/example.church.tools/backups",
      "instances/example.church.tools/reference",
      "instances/example.church.tools/reports",
    ]);

    await expect(loadConfig(join(directory, "ct.config.ts"))).resolves.toMatchObject({
      resources: [],
      permissions: [],
    });
    await expect(loadEnvProfile("prod", join(directory, "ct.envs.json"))).resolves.toEqual({
      name: "prod",
      host: "https://example.church.tools",
      statePath,
      protected: true,
    });
    await expect(loadState(join(directory, statePath), "https://example.church.tools")).resolves.toEqual({
      version: 2,
      host: "https://example.church.tools",
      resources: {},
      externals: {},
    });
    await expect(access(join(directory, "ct-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a process inside an existing Git repository without nesting .git under --no-git", async () => {
    const repository = await temporaryDirectory();
    await mkdir(join(repository, ".git"));
    const directory = join(repository, "processes", "example-process");

    const result = await initializeConfigRepository(directory, {
      template: "process",
      host: "https://example.church.tools",
      environment: "test",
      git: false,
      yes: true,
    });

    expect(result.gitInitialized).toBe(false);
    await expect(access(join(repository, ".git"))).resolves.toBeUndefined();
    await expect(access(join(directory, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes no secrets and gives explicit environment next steps", async () => {
    const directory = await temporaryDirectory();
    await initializeConfigRepository(directory, {
      template: "process",
      host: "https://example.church.tools",
      environment: "test",
      yes: true,
    });

    const envs = JSON.parse(await readFile(join(directory, "ct.envs.json"), "utf8")) as {
      environments: Record<string, Record<string, unknown>>;
    };
    expect(envs.environments.test).toEqual({
      host: "https://example.church.tools",
      state: "instances/example.church.tools/ct-state.example.church.tools.json",
      protected: false,
    });
    expect(envs.environments.test).not.toHaveProperty("token");
    expect(envs.environments.test).not.toHaveProperty("tokenEnv");

    const readme = await readFile(join(directory, "README.md"), "utf8");
    expect(readme).toContain("ct plan -e test");
    expect(readme).toContain("ct apply -e test");
    expect(readme).toContain("ct plan -c configs/<bootstrap-config>.ts -e test");
    expect(readme).toContain("Always pass `-e test`");
    expect(readme).not.toContain("OJBP");

    const gitignore = await readFile(join(directory, ".gitignore"), "utf8");
    expect(gitignore).toContain("instances/*/reports/");
    expect(gitignore).toContain("instances/*/backups/");
    expect(gitignore).toContain("instances/*/reference/");
    expect(gitignore).not.toMatch(/^ct-state/m);
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

  it("refuses a process-specific conflict without partially writing the scaffold", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "README.md"), "keep me", "utf8");

    await expect(
      initializeConfigRepository(directory, {
        template: "process",
        host: "https://example.church.tools",
        yes: true,
      }),
    ).rejects.toThrow(/refusing to overwrite existing README\.md/);
    expect(await readFile(join(directory, "README.md"), "utf8")).toBe("keep me");
    await expect(readFile(join(directory, "ct.config.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, "blueprint"))).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(initializeConfigRepository(directory, { protected: true, yes: true })).rejects.toThrow(
      /--protected requires --host/,
    );
    await expect(
      initializeConfigRepository(directory, {
        host: "https://user:secret@example.church.tools",
        yes: true,
      }),
    ).rejects.toThrow(/must not contain credentials/);
    await expect(initializeConfigRepository(directory, { template: "unknown", yes: true })).rejects.toThrow(
      /Available templates: standard, process/,
    );
  });

  it("rejects a URL copied out of the browser address bar", async () => {
    const directory = await temporaryDirectory();
    await expect(
      initializeConfigRepository(directory, {
        host: "https://example.church.tools/?q=churchdb#/churchdb",
        yes: true,
      }),
    ).rejects.toThrow(/Drop the "\?"\/"#" part/);
    await expect(access(join(directory, "ct.envs.json"))).rejects.toMatchObject({ code: "ENOENT" });

    // A path is a sub-path installation, not junk, and stays intact.
    const result = await initializeConfigRepository(directory, {
      host: "https://example.church.tools/churchtools",
      yes: true,
    });
    expect(result.host).toBe("https://example.church.tools/churchtools");
  });

  it("does not ask about git in a directory that is already a repository", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, ".git"), { recursive: true });
    const ask = vi.fn((question: string) => Promise.resolve(question.startsWith("Initialize") ? "y" : ""));
    const gitInit = vi.fn(async () => undefined);

    const result = await initializeConfigRepository(directory, { isTTY: true, ask, runGitInit: gitInit });

    expect(ask.mock.calls.flat()).not.toContain("Initialize a Git repository? [y/N] ");
    expect(result.gitInitialized).toBe(false);
    expect(gitInit).not.toHaveBeenCalled();
  });

  it("gitignores the default backup directory of the standard scaffold", async () => {
    const directory = await temporaryDirectory();
    await initializeConfigRepository(directory, {
      host: "https://example.church.tools",
      yes: true,
    });

    // `ct apply` writes backups next to the state file, which the standard
    // scaffold puts at the repository root.
    expect((await readFile(join(directory, ".gitignore"), "utf8")).split("\n")).toContain("backups/");
  });

  it("prints non-interactive process next steps with an explicit environment", async () => {
    const directory = await temporaryDirectory();
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    await initCommand().parseAsync(
      [
        directory,
        "--template",
        "process",
        "--host",
        "https://example.church.tools",
        "--env",
        "test",
        "--no-git",
        "--yes",
      ],
      { from: "user" },
    );

    expect(stderr).toContain("ct plan -e test");
    expect(stderr).not.toContain("ct plan`");
  });
});
