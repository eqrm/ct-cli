import { describe, expect, it, vi } from "vitest";
import type { CtApplicationError } from "../../src/application/errors.js";
import {
  executePreparedApply,
  prepareApply,
  type ApplyOperationDependencies,
  type PreparedApplyExecution,
} from "../../src/application/operations/apply.js";
import { PreparedOperationStore } from "../../src/application/prepared-operation-store.js";
import type { Clock } from "../../src/application/ports.js";
import type { Plan } from "../../src/engine/types.js";
import { emptyState } from "../../src/state/state.js";
import { ExternalReferenceError } from "../../src/resolve/external.js";

const host = "https://example.church.tools";
const statePath = "/project/ct-state.prod.json";
const resourcePlan: Plan = {
  items: [
    {
      type: "campus",
      key: "mainz",
      id: null,
      action: "create",
      changes: [{ field: "name", from: undefined, to: "Mainz" }],
    },
  ],
};

function harness(options: { protected?: boolean; environment?: string | null } = {}) {
  let now = new Date("2026-08-25T20:00:00.000Z");
  let stateFile = "state-v1";
  let configFile = "config-v1";
  const clock: Clock = { now: () => now };
  const store = new PreparedOperationStore<PreparedApplyExecution>(clock, {
    nextId: () => "prepared-1",
  });
  const order: string[] = [];
  const execute = vi.fn(async () => {
    order.push("execute");
    return { created: ["mainz"], updated: [], skippedDeletes: [] };
  });
  const backup = vi.fn(async () => {
    order.push("backup");
    return "/project/backups/backup.json";
  });
  const client = { version: "3.140.0", get: vi.fn(), request: vi.fn() };
  const dependencies: ApplyOperationDependencies = {
    clock,
    store,
    readStateFile: async (path) => (path === statePath ? stateFile : configFile),
    resolveProject: vi.fn(async () => ({
      cwd: "/project",
      configPath: "/project/ct.config.ts",
      statePath,
      environmentsPath: "/project/ct.envs.json",
      configDisplayPath: "ct.config.ts",
      stateDisplayPath: "ct-state.prod.json",
      environment: options.environment === undefined ? "prod" : options.environment,
      protected: options.protected ?? true,
      host,
    })),
    loadHostCatalog: vi.fn(async () => null),
    loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
    loadState: vi.fn(async () => emptyState(host)),
    authedSession: vi.fn(async () => ({
      client,
      me: { id: 1 },
    })) as unknown as ApplyOperationDependencies["authedSession"],
    buildPlan: vi.fn(async () => ({
      plan: resourcePlan,
      actual: new Map([["existing", { name: "Existing" }]]),
      fetchErrors: [],
    })),
    buildPermissionPlan: vi.fn(async () => ({ items: [], fetchErrors: [], warnings: [] })),
    writeBackup: backup,
    executePlan: execute,
    applyPermissionPlan: vi.fn(async () => ({ granted: 0, deleted: 0, failed: [] })),
  };
  return {
    dependencies,
    execute,
    backup,
    order,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    changeState(value: string) {
      stateFile = value;
    },
    changeConfig(value: string) {
      configFile = value;
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: CtApplicationError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "CtApplicationError", code });
}

describe("prepared apply operation", () => {
  it("blocks before backup and writes when an external prerequisite diagnostic is raised", async () => {
    const test = harness();
    const diagnostic = new ExternalReferenceError({
      reason: "EXTERNAL_BINDING_MISSING",
      type: "group",
      key: "shared",
      site: 'group "consumer".parents',
      context: { host, consumer: "consumer", environment: "prod" },
      evidence: ["No persisted external binding exists."],
      consequence: "Apply is blocked before writes.",
      remediation: [{ command: "ct use group 77 --key shared", description: "Bind the live group." }],
      verification: "ct plan --env prod",
    });
    test.dependencies.buildPlan = vi.fn(async () => {
      throw diagnostic;
    });

    await expect(prepareApply({}, test.dependencies)).rejects.toMatchObject({
      code: "EXTERNAL_REFERENCE_BLOCKED",
      details: {
        reason: "EXTERNAL_BINDING_MISSING",
        remediation: [{ command: "ct use group 77 --key shared" }],
      },
    });
    expect(test.backup).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("requires the exact protected environment and writes the backup before resources", async () => {
    const test = harness();
    const prepared = await prepareApply({}, test.dependencies);

    expect(prepared).toMatchObject({
      id: "prepared-1",
      changeCount: 1,
      confirmation: { type: "environment", environment: "prod" },
    });
    await expectCode(
      executePreparedApply(prepared, { type: "yes" }, test.dependencies),
      "PROTECTED_ENV_CONFIRMATION_REQUIRED",
    );
    expect(test.execute).not.toHaveBeenCalled();

    const result = await executePreparedApply(
      prepared,
      { type: "environment", value: "prod" },
      test.dependencies,
    );
    expect(test.order).toEqual(["backup", "execute"]);
    expect(result).toMatchObject({
      operation: "apply",
      value: {
        backupPath: "/project/backups/backup.json",
        resources: { created: ["mainz"] },
      },
    });
  });

  it("refuses an expired prepared operation before backup or mutation", async () => {
    const test = harness();
    const prepared = await prepareApply({}, { ...test.dependencies, preparedTtlMs: 100 });
    test.advance(100);

    await expectCode(
      executePreparedApply(prepared, { type: "environment", value: "prod" }, test.dependencies),
      "OPERATION_EXPIRED",
    );
    expect(test.backup).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("carries the catalog path and plan warnings on an incomplete plan", async () => {
    const test = harness();
    const dependencies: ApplyOperationDependencies = {
      ...test.dependencies,
      loadHostCatalog: vi.fn(async () => "/project/.ct/catalog/example.json"),
      buildPlan: vi.fn(async () => ({
        plan: resourcePlan,
        actual: new Map(),
        fetchErrors: ["group.broken: HTTP 500"],
      })),
      buildPermissionPlan: vi.fn(async () => ({
        items: [],
        fetchErrors: [],
        warnings: ["permission catalog is stale"],
      })),
    };
    // Aborting is right; aborting SILENTLY about a stale catalog is not — the adapter never sees
    // the plan that carries these, so they travel on the error (#156 review).
    await expect(prepareApply({}, dependencies)).rejects.toMatchObject({
      code: "PLAN_INCOMPLETE",
      details: {
        cwd: "/project",
        permissionCatalogPath: "/project/.ct/catalog/example.json",
        warnings: ["permission catalog is stale"],
      },
    });
  });

  it("does not expire a prepared apply the caller keeps across a blocking confirmation", async () => {
    const test = harness();
    const prepared = await prepareApply({}, { ...test.dependencies, preparedTtlMs: null });
    expect(prepared.expiresAt).toBeNull();
    // Far longer than the default 5-minute TTL: an operator may read a long diff before typing y.
    test.advance(60 * 60 * 1000);

    const result = await executePreparedApply(
      prepared,
      { type: "environment", value: "prod" },
      test.dependencies,
    );
    expect(result.value.resources.created).toEqual(["mainz"]);
  });

  it("is single-use", async () => {
    const test = harness({ protected: false, environment: "dev" });
    const prepared = await prepareApply({}, test.dependencies);
    await executePreparedApply(prepared, { type: "yes" }, test.dependencies);

    await expectCode(
      executePreparedApply(prepared, { type: "yes" }, test.dependencies),
      "OPERATION_ALREADY_USED",
    );
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses when the state file changed after prepare", async () => {
    const test = harness({ protected: false, environment: "dev" });
    const prepared = await prepareApply({}, test.dependencies);
    test.changeState("state-v2");

    await expectCode(
      executePreparedApply(prepared, { type: "yes" }, test.dependencies),
      "PLAN_CONFIRMATION_MISMATCH",
    );
    expect(test.backup).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("binds execution to the exact config digest", async () => {
    const test = harness({ protected: false, environment: "dev" });
    const prepared = await prepareApply({}, test.dependencies);
    expect(prepared.bindings.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.bindings.planDigest).toMatch(/^[a-f0-9]{64}$/);
    test.changeConfig("config-v2");

    await expectCode(
      executePreparedApply(prepared, { type: "yes" }, test.dependencies),
      "PLAN_CONFIRMATION_MISMATCH",
    );
    expect(test.backup).not.toHaveBeenCalled();
  });
});
