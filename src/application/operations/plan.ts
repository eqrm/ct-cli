import { join } from "node:path";
import { authedSession, type AuthedSession } from "../../api/session.js";
import { loadConfig } from "../../config/load.js";
import { buildPlan } from "../../engine/build.js";
import { summarize, type Plan, type PlanAction } from "../../engine/types.js";
import { CATALOG_DIR, loadHostCatalog } from "../../permissions/catalog-store.js";
import { buildPermissionPlan, type PermissionPlanItem } from "../../permissions/plan.js";
import { Resolver } from "../../resolve/resolver.js";
import { ExternalReferenceError } from "../../resolve/external.js";
import { loadState, type State } from "../../state/state.js";
import type { CtClient } from "../../api/ctClient.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { noopObserver, type OperationObserver } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";
import { CtApplicationError } from "../errors.js";
import type { JsonValue } from "../contracts.js";

export type PlanRequest = ProjectRequest;

export interface PlanSummary {
  resources: Record<PlanAction, number>;
  drifted: number;
  unreadable: number;
  permissions: {
    toPut: number;
    toDelete: number;
    preserved: number;
  };
  hasChanges: boolean;
}

export interface PlanValue {
  plan: Plan;
  permissions: PermissionPlanItem[];
  summary: PlanSummary;
  complete: boolean;
  fetchErrors: string[];
  churchToolsVersion: string | null;
  stateHost: string;
  /**
   * Informational registry/portability warnings from plan building. The builder already wrote
   * these to stderr, so an adapter must NOT print them again — they are carried so non-terminal
   * projections (the Markdown report, a future HTTP response) can include them.
   */
  buildWarnings: string[];
  permissionCatalogPath: string | null;
}

export type PlanResult = OperationResult<PlanValue>;

type ResolverOptions = ConstructorParameters<typeof Resolver>[0];

export interface PlanOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadHostCatalog?: typeof loadHostCatalog;
  loadConfig?: typeof loadConfig;
  loadState?: typeof loadState;
  authedSession?: () => Promise<AuthedSession>;
  buildPlan?: typeof buildPlan;
  buildPermissionPlan?: typeof buildPermissionPlan;
  createResolver?: (options: ResolverOptions) => Resolver;
  observer?: OperationObserver;
}

/** Internal execution context shared with prepared mutations; never serialize this object. */
export interface BuiltPlanContext {
  result: PlanResult;
  client: CtClient;
  state: State;
  actual: Map<string, Record<string, unknown>>;
}

function summarizePlan(plan: Plan, permissions: PermissionPlanItem[]): PlanSummary {
  const hasResourceChanges = plan.items.some((item) => item.action !== "no-op");
  const hasPermissionChanges = permissions.some(
    (item) => item.diff.toPut.length > 0 || item.diff.toDelete.length > 0,
  );
  return {
    resources: summarize(plan),
    drifted: plan.items.filter((item) => item.drift && item.drift.length > 0).length,
    unreadable: plan.items.filter((item) => item.note === "fetch-failed").length,
    permissions: {
      toPut: permissions.reduce((count, item) => count + item.diff.toPut.length, 0),
      toDelete: permissions.reduce((count, item) => count + item.diff.toDelete.length, 0),
      preserved: permissions.reduce((count, item) => count + item.diff.preserved.length, 0),
    },
    hasChanges: hasResourceChanges || hasPermissionChanges,
  };
}

/** Build the canonical read-only plan consumed by CLI and future HTTP/UI adapters. */
export async function runPlan(
  request: PlanRequest = {},
  dependencies: PlanOperationDependencies = {},
): Promise<PlanResult> {
  return (await buildPlanContext(request, dependencies)).result;
}

/** Build once for both the read-only plan and the exact snapshot later consumed by apply. */
export async function buildPlanContext(
  request: PlanRequest = {},
  dependencies: PlanOperationDependencies = {},
): Promise<BuiltPlanContext> {
  const observer = dependencies.observer ?? noopObserver;
  observer.emit({ type: "phase-started", phase: "resolve-project" });
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);

  observer.emit({ type: "phase-started", phase: "load-project" });
  const catalogPath = await (dependencies.loadHostCatalog ?? loadHostCatalog)(
    project.host,
    join(project.cwd, CATALOG_DIR),
  );
  const {
    resources: desired,
    permissions,
    configDir,
  } = await (dependencies.loadConfig ?? loadConfig)(project.configPath);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  const { client } = await (dependencies.authedSession ?? authedSession)();
  const resolver = (dependencies.createResolver ?? ((options) => new Resolver(options)))({
    client,
    state,
    desired,
    host: project.host,
    context: {
      consumer: project.cwd.split(/[\\/]/).filter(Boolean).at(-1),
      cwd: project.cwd,
      configPath: project.configPath,
      statePath: project.statePath,
      environment: project.environment,
    },
  });

  observer.emit({ type: "phase-started", phase: "build-plan" });
  let resourceResult: Awaited<ReturnType<typeof buildPlan>>;
  let permissionResult: Awaited<ReturnType<typeof buildPermissionPlan>>;
  try {
    [resourceResult, permissionResult] = await Promise.all([
      (dependencies.buildPlan ?? buildPlan)(client, state, desired, { configDir, resolver }),
      (dependencies.buildPermissionPlan ?? buildPermissionPlan)(
        client,
        state,
        permissions,
        desired,
        resolver,
        client.version ?? undefined,
      ),
    ]);
  } catch (error) {
    if (error instanceof ExternalReferenceError) {
      throw new CtApplicationError("EXTERNAL_REFERENCE_BLOCKED", error.message, {
        details: error.details as unknown as Record<string, JsonValue>,
        cause: error,
      });
    }
    throw error;
  }
  const fetchErrors = [...resourceResult.fetchErrors, ...permissionResult.fetchErrors];
  const warnings: CtWarning[] = permissionResult.warnings.map((message) => ({
    code: "PERMISSION_CATALOG",
    message,
  }));

  return {
    client,
    state,
    actual: resourceResult.actual,
    result: {
      operation: "plan",
      project,
      warnings,
      value: {
        plan: resourceResult.plan,
        permissions: permissionResult.items,
        summary: summarizePlan(resourceResult.plan, permissionResult.items),
        complete: fetchErrors.length === 0,
        fetchErrors,
        churchToolsVersion: client.version,
        stateHost: state.host,
        buildWarnings: resourceResult.warnings ?? [],
        permissionCatalogPath: catalogPath,
      },
    },
  };
}
