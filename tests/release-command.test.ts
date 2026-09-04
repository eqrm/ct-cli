import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, loadState, saveState } from "../src/state/state.js";
import { unadoptCommand, unuseCommand } from "../src/commands/release.js";

const HOST = "https://example.church.tools";
const saved = { host: process.env.CT_HOST, envs: process.env.CT_ENVS, config: process.env.CT_CONFIG };

describe("ct unuse / ct unadopt", () => {
  let directory: string;
  let statePath: string;
  let configPath: string;
  let envsPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ct-release-"));
    statePath = join(directory, "state.json");
    configPath = join(directory, "ct.config.ts");
    envsPath = join(directory, "ct.envs.json");
    delete process.env.CT_HOST;
    process.env.CT_ENVS = envsPath;
    process.env.CT_CONFIG = configPath;
    await writeFile(
      envsPath,
      JSON.stringify({ environments: { prod: { host: HOST, state: statePath, protected: true } } }),
    );
    await writeFile(configPath, "export default () => {};");
    const state = emptyState(HOST);
    state.resources.owned = {
      type: "group",
      key: "owned",
      id: 10,
      fields: { name: "Owned" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    state.externals!.shared = {
      type: "group",
      key: "shared",
      id: 20,
      identity: { name: "Shared", groupTypeId: 2 },
      boundAt: "t",
    };
    await saveState(statePath, state);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (saved.host === undefined) delete process.env.CT_HOST;
    else process.env.CT_HOST = saved.host;
    if (saved.envs === undefined) delete process.env.CT_ENVS;
    else process.env.CT_ENVS = saved.envs;
    if (saved.config === undefined) delete process.env.CT_CONFIG;
    else process.env.CT_CONFIG = saved.config;
    await rm(directory, { recursive: true, force: true });
  });

  it("unuses only an external after exact environment confirmation", async () => {
    await unuseCommand().parseAsync(["group", "shared", "--env", "prod", "--confirm-env", "prod"], {
      from: "user",
    });
    const state = await loadState(statePath, HOST);
    expect(state.externals?.shared).toBeUndefined();
    expect(state.resources.owned).toBeDefined();
  });

  it("unadopts only a managed entry after exact environment confirmation", async () => {
    await unadoptCommand().parseAsync(["group", "owned", "--env", "prod", "--confirm-env", "prod"], {
      from: "user",
    });
    const state = await loadState(statePath, HOST);
    expect(state.resources.owned).toBeUndefined();
    expect(state.externals?.shared).toBeDefined();
  });

  it("refuses missing or mismatching confirmation without changing state", async () => {
    await unuseCommand().parseAsync(["group", "shared", "--env", "prod"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect((await loadState(statePath, HOST)).externals?.shared).toBeDefined();

    process.exitCode = 0;
    await unuseCommand().parseAsync(["group", "shared", "--env", "prod", "--confirm-env", "dev"], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
    expect((await loadState(statePath, HOST)).externals?.shared).toBeDefined();
  });

  it("fails closed while the external key is referenced, unless --force is explicit", async () => {
    await writeFile(
      configPath,
      `export default (ct) => { ct.groupRole({ key: "reader", group: "shared", role: "Reader", grants: [] }); };`,
    );
    await expect(
      unuseCommand().parseAsync(["group", "shared", "--env", "prod", "--confirm-env", "prod"], {
        from: "user",
      }),
    ).rejects.toThrow(/still declared or referenced/);
    expect((await loadState(statePath, HOST)).externals?.shared).toBeDefined();

    await unuseCommand().parseAsync(
      ["group", "shared", "--env", "prod", "--confirm-env", "prod", "--force"],
      { from: "user" },
    );
    expect((await loadState(statePath, HOST)).externals?.shared).toBeUndefined();
  });

  it("recognizes hierarchy references outside permission declarations", async () => {
    await writeFile(
      configPath,
      `export default (ct) => { ct.group({ key: "child", name: "Child", parents: ["shared"] }); };`,
    );
    await expect(
      unuseCommand().parseAsync(["group", "shared", "--env", "prod", "--confirm-env", "prod"], {
        from: "user",
      }),
    ).rejects.toThrow(/still declared or referenced/);
    expect((await loadState(statePath, HOST)).externals?.shared).toBeDefined();
  });

  it("rejects crossing the managed/external boundary", async () => {
    await expect(
      unuseCommand().parseAsync(["group", "owned", "--env", "prod", "--confirm-env", "prod"], {
        from: "user",
      }),
    ).rejects.toThrow(/is managed, not external/);
    await expect(
      unadoptCommand().parseAsync(["group", "shared", "--env", "prod", "--confirm-env", "prod"], {
        from: "user",
      }),
    ).rejects.toThrow(/is external, not managed/);
  });

  it("keeps dry-run side-effect free and requires no confirmation", async () => {
    await unuseCommand().parseAsync(["group", "shared", "--env", "prod", "--dry-run"], {
      from: "user",
    });
    expect((await loadState(statePath, HOST)).externals?.shared).toBeDefined();
  });
});
