import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeBackup } from "../../engine/backup.js";
import { executePlan, type ExecuteResult } from "../../engine/execute.js";
import { runPostApplyHooks } from "../../engine/synthetic.js";
import { applyPermissionPlan, type PermissionApplyResult } from "../../permissions/apply.js";
import { saveState } from "../../state/state.js";
import { resolveWithEnv } from "../../util/resolve.js";
import type { OperationResult } from "../contracts.js";
import { CtApplicationError } from "../errors.js";
import { InMemoryMutationLock, PreparedOperationStore } from "../prepared-operation-store.js";
import {
  noopObserver,
  systemClock,
  type Clock,
  type MutationLock,
  type OperationObserver,
} from "../ports.js";
import {
  buildPlanContext,
  type BuiltPlanContext,
  type PlanOperationDependencies,
  type PlanRequest,
  type PlanResult,
} from "./plan.js";

const PREPARED_APPLY_TTL_MS = 5 * 60 * 1000;

export interface ApplyRequest extends PlanRequest {
  backupDir?: string;
  refresh?: boolean;
}

export type ConfirmationRequirement =
  { type: "none" } | { type: "yes" } | { type: "environment"; environment: string };

export type ConfirmationProof = { type: "yes" } | { type: "environment"; value: string };

export interface PreparedApply {
  id: string;
  plan: PlanResult;
  changeCount: number;
  confirmation: ConfirmationRequirement;
  /** `null` when the prepared operation has no wall-clock expiry (the CLI's own runs). */
  expiresAt: string | null;
  bindings: {
    environment: string | null;
    configDigest: string;
    stateDigest: string;
    planDigest: string;
  };
}

export interface ApplyValue {
  backupPath: string | null;
  resources: ExecuteResult;
  permissions: PermissionApplyResult;
  refreshed: boolean;
  dynamicGroupKeys: string[];
}

export type ApplyResult = OperationResult<ApplyValue>;

/** Internal prepared payload retained by the process-local store, never sent over HTTP. */
export interface PreparedApplyExecution {
  context: BuiltPlanContext;
  stateFingerprint: string;
  configFingerprint: string;
  planDigest: string;
  backupDir?: string;
  refresh: boolean;
  confirmation: ConfirmationRequirement;
}

export interface ApplyOperationDependencies extends PlanOperationDependencies {
  clock?: Clock;
  observer?: OperationObserver;
  store?: PreparedOperationStore<PreparedApplyExecution>;
  lock?: MutationLock;
  readStateFile?: (path: string) => Promise<string>;
  writeBackup?: typeof writeBackup;
  executePlan?: typeof executePlan;
  applyPermissionPlan?: typeof applyPermissionPlan;
  runPostApplyHooks?: typeof runPostApplyHooks;
  saveState?: typeof saveState;
  env?: NodeJS.ProcessEnv;
  /** `null` disables the wall-clock expiry entirely; omit for the default TTL. */
  preparedTtlMs?: number | null;
}

const defaultStore = new PreparedOperationStore<PreparedApplyExecution>();
const defaultLock = new InMemoryMutationLock();

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function stateFingerprint(
  path: string,
  read: (path: string) => Promise<string> = (value) => readFile(value, "utf8"),
): Promise<string> {
  try {
    return createHash("sha256")
      .update("present\0")
      .update(await read(path))
      .digest("hex");
  } catch (error) {
    if (isNotFound(error)) return createHash("sha256").update("missing").digest("hex");
    throw error;
  }
}

function preparedPlanDigest(context: BuiltPlanContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: {
          environment: context.result.project.environment,
          host: context.result.project.host,
          configPath: context.result.project.configPath,
          statePath: context.result.project.statePath,
        },
        plan: context.result.value.plan,
        permissions: context.result.value.permissions,
      }),
    )
    .digest("hex");
}

/** backups/ dir: explicit flag → CT_BACKUP_DIR → `backups/` beside the state file. */
export function resolveBackupDir(
  explicit: string | undefined,
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveWithEnv(explicit, env.CT_BACKUP_DIR, join(dirname(statePath), "backups"));
}

function confirmationFor(context: BuiltPlanContext, changeCount: number): ConfirmationRequirement {
  if (changeCount === 0) return { type: "none" };
  if (context.result.project.protected) {
    const environment = context.result.project.environment;
    if (!environment) {
      throw new CtApplicationError(
        "PROTECTED_ENV_CONFIRMATION_REQUIRED",
        "A protected project must name its environment before apply.",
      );
    }
    return { type: "environment", environment };
  }
  return { type: "yes" };
}

function assertConfirmation(requirement: ConfirmationRequirement, proof?: ConfirmationProof): void {
  if (requirement.type === "none") return;
  if (requirement.type === "yes" && proof?.type === "yes") return;
  if (
    requirement.type === "environment" &&
    proof?.type === "environment" &&
    proof.value === requirement.environment
  ) {
    return;
  }
  if (requirement.type === "environment") {
    throw new CtApplicationError(
      "PROTECTED_ENV_CONFIRMATION_REQUIRED",
      `Protected environment "${requirement.environment}" was not confirmed.`,
      { details: { environment: requirement.environment } },
    );
  }
  throw new CtApplicationError("PLAN_CONFIRMATION_MISMATCH", "Apply confirmation was not provided.");
}

/** Prepare the exact immutable proposal that a CLI or HTTP adapter asks a user to confirm. */
export async function prepareApply(
  request: ApplyRequest = {},
  dependencies: ApplyOperationDependencies = {},
): Promise<PreparedApply> {
  const context = await buildPlanContext(request, dependencies);
  if (!context.result.value.complete) {
    throw new CtApplicationError(
      "PLAN_INCOMPLETE",
      `Aborting: ${context.result.value.fetchErrors.length} resource(s) could not be fetched — the plan is incomplete. Re-run when resolved.`,
      {
        details: {
          fetchErrors: context.result.value.fetchErrors,
          // An incomplete plan aborts before the plan (and therefore its diagnostics) is ever
          // returned, so the catalog path and the plan warnings travel on the error itself.
          // Without them a stale per-instance catalog (#25) goes unmentioned in exactly the run
          // that ends in "could not be fetched" (#156 review).
          cwd: context.result.project.cwd,
          permissionCatalogPath: context.result.value.permissionCatalogPath ?? null,
          warnings: context.result.warnings.map((warning) => warning.message),
        },
      },
    );
  }

  const summary = context.result.value.summary;
  const changeCount =
    summary.resources.create +
    summary.resources.update +
    summary.permissions.toPut +
    summary.permissions.toDelete;
  const confirmation = confirmationFor(context, changeCount);
  const fingerprint = await stateFingerprint(context.result.project.statePath, dependencies.readStateFile);
  const configFingerprint = await stateFingerprint(
    context.result.project.configPath,
    dependencies.readStateFile,
  );
  const planDigest = preparedPlanDigest(context);
  const store = dependencies.store ?? defaultStore;
  const stored = store.put(
    {
      context,
      stateFingerprint: fingerprint,
      configFingerprint,
      planDigest,
      backupDir: request.backupDir,
      refresh: request.refresh ?? false,
      confirmation,
    },
    dependencies.preparedTtlMs === undefined ? PREPARED_APPLY_TTL_MS : dependencies.preparedTtlMs,
  );

  return {
    id: stored.id,
    plan: context.result,
    changeCount,
    confirmation,
    expiresAt: stored.expiresAt === null ? null : stored.expiresAt.toISOString(),
    bindings: {
      environment: context.result.project.environment,
      configDigest: configFingerprint,
      stateDigest: fingerprint,
      planDigest,
    },
  };
}

/** Validate and consume one prepared apply, then own every write from backup through refresh. */
export async function executePreparedApply(
  prepared: Pick<PreparedApply, "id">,
  proof?: ConfirmationProof,
  dependencies: ApplyOperationDependencies = {},
): Promise<ApplyResult> {
  const store = dependencies.store ?? defaultStore;
  const candidate = store.peek(prepared.id);
  assertConfirmation(candidate.confirmation, proof);
  const statePath = candidate.context.result.project.statePath;
  const lock = dependencies.lock ?? defaultLock;

  return lock.runExclusive(statePath, async () => {
    const stored = store.take(prepared.id);
    const currentFingerprint = await stateFingerprint(statePath, dependencies.readStateFile);
    if (currentFingerprint !== stored.stateFingerprint) {
      throw new CtApplicationError(
        "PLAN_CONFIRMATION_MISMATCH",
        "The state file changed after this apply was prepared. Prepare and confirm a new plan.",
        { details: { statePath } },
      );
    }
    const currentConfigFingerprint = await stateFingerprint(
      stored.context.result.project.configPath,
      dependencies.readStateFile,
    );
    if (currentConfigFingerprint !== stored.configFingerprint) {
      throw new CtApplicationError(
        "PLAN_CONFIRMATION_MISMATCH",
        "The config file changed after this apply was prepared. Prepare and confirm a new plan.",
        { details: { configPath: stored.context.result.project.configPath } },
      );
    }

    const observer = dependencies.observer ?? noopObserver;
    const { context } = stored;
    const { project, warnings } = context.result;
    const { plan, permissions } = context.result.value;
    const dynamicGroupKeys = plan.items
      .filter(
        (item) =>
          item.action !== "no-op" &&
          item.action !== "delete" &&
          item.changes.some((change) => change.field === "dynamic"),
      )
      .map((item) => item.key);

    if (candidate.confirmation.type === "none") {
      return {
        operation: "apply",
        project,
        warnings,
        value: {
          backupPath: null,
          resources: { created: [], updated: [], skippedDeletes: [] },
          permissions: { granted: 0, deleted: 0, failed: [] },
          refreshed: false,
          dynamicGroupKeys,
        },
      };
    }

    observer.emit({ type: "phase-started", phase: "backup" });
    const backupPath = await (dependencies.writeBackup ?? writeBackup)(
      resolveBackupDir(stored.backupDir, statePath, dependencies.env),
      project.host,
      context.actual,
      (dependencies.clock ?? systemClock).now(),
    );
    observer.emit({ type: "backup-written", path: backupPath });

    observer.emit({ type: "phase-started", phase: "apply-resources" });
    const resources = await (dependencies.executePlan ?? executePlan)(plan, {
      client: context.client,
      state: context.state,
      statePath,
      save: dependencies.saveState ?? saveState,
    });
    for (const key of resources.created) {
      const item = plan.items.find((candidate) => candidate.key === key);
      const id = context.state.resources[key]?.id;
      if (item && id !== undefined) {
        observer.emit({ type: "resource-created", resourceType: item.type, key, id });
      }
    }
    for (const key of resources.updated) {
      const item = plan.items.find((candidate) => candidate.key === key);
      const id = context.state.resources[key]?.id;
      if (item && id !== undefined) {
        observer.emit({ type: "resource-updated", resourceType: item.type, key, id });
      }
    }
    let permissionResult: PermissionApplyResult = { granted: 0, deleted: 0, failed: [] };
    let refreshed = false;
    if (!resources.failed) {
      observer.emit({ type: "phase-started", phase: "apply-permissions" });
      permissionResult = await (dependencies.applyPermissionPlan ?? applyPermissionPlan)(
        permissions,
        context.client,
        context.state,
      );
      if (permissionResult.failed.length === 0 && stored.refresh) {
        observer.emit({ type: "phase-started", phase: "post-apply" });
        await (dependencies.runPostApplyHooks ?? runPostApplyHooks)(plan, context.state, context.client);
        refreshed = true;
      }
    }

    return {
      operation: "apply",
      project,
      warnings,
      value: {
        backupPath,
        resources,
        permissions: permissionResult,
        refreshed,
        dynamicGroupKeys,
      },
    };
  });
}
