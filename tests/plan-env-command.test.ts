/**
 * Command-level `ct plan --env` (#22): one config repo drives two hosts with two
 * state files and NO file edits. Mocks the session + config + plan pipeline (like
 * apply-refresh-command.test.ts) so the real env→host→state wiring runs:
 *  - `--env dev` and `--env prod` each resolve their own host + state file.
 *  - the header surfaces the env name and the target CT version (per-env gate).
 *  - cross-contamination is impossible: an env whose state file was recorded
 *    against a DIFFERENT host is rejected by the state host-check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/engine/types.js";

const plan: Plan = { items: [] };

const versionByHost: Record<string, string> = {
  "https://mychurch-dev.church.tools": "3.100.0",
  "https://mychurch.church.tools": "3.123.0",
};

// authedSession is mocked, but resolveConfig (real) has already read CT_HOST that prepareEnv wired,
// so we echo a per-host CT version off process.env.CT_HOST to prove the header reflects the target.
vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({
    client: { get: vi.fn(), version: versionByHost[process.env.CT_HOST ?? ""] ?? null },
    me: { id: 1 },
  })),
}));

vi.mock("../src/config/load.js", () => ({
  DEFAULT_CONFIG_PATH: "ct.config.ts",
  resolveConfigPath: (explicit?: string) => explicit ?? "ct.config.ts",
  loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "." })),
}));

vi.mock("../src/engine/build.js", () => ({
  buildPlan: vi.fn(async () => ({ plan, actual: new Map(), fetchErrors: [] })),
}));

vi.mock("../src/permissions/plan.js", () => ({
  buildPermissionPlan: vi.fn(async () => ({ items: [], fetchErrors: [], warnings: [] })),
}));

const { planCommand } = await import("../src/commands/plan.js");
const { buildPlan } = await import("../src/engine/build.js");
const { saveState, emptyState } = await import("../src/state/state.js");

const DEV = "https://mychurch-dev.church.tools";
const PROD = "https://mychurch.church.tools";
const envsPath = join(tmpdir(), `ct-cli-planenv-envs-${process.pid}.json`);
const devState = join(tmpdir(), `ct-cli-planenv-dev-${process.pid}.json`);
const prodState = join(tmpdir(), `ct-cli-planenv-prod-${process.pid}.json`);

const saved = { host: process.env.CT_HOST, envs: process.env.CT_ENVS };

let stderr = "";
let stderrSpy: { mockRestore: () => void };
let stdout = "";
let stdoutSpy: { mockRestore: () => void };

async function runPlan(args: string[]): Promise<void> {
  await planCommand().parseAsync(args, { from: "user" });
}

beforeEach(async () => {
  vi.mocked(buildPlan).mockClear();
  delete process.env.CT_HOST;
  process.env.CT_ENVS = envsPath;
  await writeFile(
    envsPath,
    JSON.stringify({
      environments: {
        dev: { host: DEV, state: devState },
        prod: { host: PROD, state: prodState },
      },
    }),
    "utf8",
  );
  await saveState(devState, emptyState(DEV));
  await saveState(prodState, emptyState(PROD));
  stderr = "";
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as (typeof process.stderr)["write"]);
  stdout = "";
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as (typeof process.stdout)["write"]);
});

afterEach(async () => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  if (saved.host === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = saved.host;
  if (saved.envs === undefined) delete process.env.CT_ENVS;
  else process.env.CT_ENVS = saved.envs;
  await rm(envsPath, { force: true });
  await rm(devState, { force: true });
  await rm(prodState, { force: true });
});

describe("ct plan --env", () => {
  it("plans against dev's host + state and shows the env + CT version in the header", async () => {
    await runPlan(["--env", "dev"]);
    expect(stderr).toContain("env: dev");
    expect(stderr).toContain(`host: ${DEV}`);
    expect(stderr).toContain("ChurchTools 3.100.0");
    expect(stderr).toContain(`state host: ${DEV}`);
  });

  it("plans against prod's host + state from the SAME checkout (no file edits)", async () => {
    await runPlan(["--env", "prod"]);
    expect(stderr).toContain("env: prod");
    expect(stderr).toContain(`host: ${PROD}`);
    expect(stderr).toContain("ChurchTools 3.123.0");
    expect(stderr).toContain(`state host: ${PROD}`);
  });

  it("renders the same env-bound plan as a self-contained Markdown report (#144)", async () => {
    await runPlan(["--env", "dev", "--format", "markdown", "--locale", "de-DE"]);
    expect(stdout).toContain("# ChurchTools-Änderungsplan");
    expect(stdout).toContain("> Dieser Bericht beschreibt nur den Plan.");
    expect(stdout).toContain(`| ChurchTools-Instanz | ${DEV} |`);
    expect(stdout).toContain("| Umgebung | dev |");
    expect(stdout).toContain("ChurchTools-Version | 3.100.0");
    expect(stdout).toContain("Es sind keine Änderungen erforderlich");
  });

  it("writes text, JSON and Markdown sidecars after one plan computation (#144)", async () => {
    const outputBase = join(tmpdir(), `ct-cli-planenv-report-${process.pid}`);
    try {
      await runPlan([
        "--env",
        "dev",
        "--format",
        "text",
        "--format",
        "json",
        "--format",
        "markdown",
        "--output-base",
        outputBase,
      ]);
      expect(buildPlan).toHaveBeenCalledTimes(1);
      expect(stdout).toBe("");
      expect(await readFile(`${outputBase}.txt`, "utf8")).toContain("No changes");
      expect(JSON.parse(await readFile(`${outputBase}.json`, "utf8"))).toMatchObject({
        summary: { hasChanges: false },
      });
      expect(await readFile(`${outputBase}.md`, "utf8")).toContain("# ChurchTools-Änderungsplan");
    } finally {
      await Promise.all(
        ["txt", "json", "md"].map((extension) => rm(`${outputBase}.${extension}`, { force: true })),
      );
    }
  });

  it("refuses when an env's state file was recorded against a different host (no cross-contamination)", async () => {
    // Point prod's profile at dev's state file: prod host vs a dev-bound state file must be rejected.
    await writeFile(
      envsPath,
      JSON.stringify({ environments: { prod: { host: PROD, state: devState } } }),
      "utf8",
    );
    await expect(runPlan(["--env", "prod"])).rejects.toThrow(/Refusing to mix instances/);
  });
});
