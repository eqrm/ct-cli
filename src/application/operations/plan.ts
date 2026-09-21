import { join } from "node:path";
import { authedSession, type AuthedSession } from "../../api/session.js";
import { loadConfig } from "../../config/load.js";
import { buildPlan } from "../../engine/build.js";
import { summarize, type Plan, type PlanAction } from "../../engine/types.js";
import { STRICT_CATALOG, setStrictCatalog } from "../../permissions/catalog.js";
import { CATALOG_DIR, loadHostCatalog } from "../../permissions/catalog-store.js";
import { buildPermissionPlan, type PermissionPlanItem } from "../../permissions/plan.js";
import { loadIdMap } from "../../resolve/idMap.js";
import { Resolver } from "../../resolve/resolver.js";
import { loadState, type State } from "../../state/state.js";
import type { CtClient } from "../../api/ctClient.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { noopObserver, type OperationObserver } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface PlanRequest extends ProjectRequest {
  /**
   * `--strict-catalog` (#178): treat a declared right (or `preserveUnknown` dimension) the active
   * permission catalog does not define as a hard error, even when ct's bundled catalog defines it.
   *
   * The default is the skip-with-warning posture, which is what lets ONE config serve two instances
   * with different modules installed. This flag is for a repo that would rather planning failed than
   * have any declaration silently not apply.
   */
  strictCatalog?: boolean;
}

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
  /** The committed OpenTofu id map this plan resolved through (#181), when the repo has one. */
  tofuIdMapPath: string | null;
}

export type PlanResult = OperationResult<PlanValue>;

type ResolverOptions = ConstructorParameters<typeof Resolver>[0];

export interface PlanOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadHostCatalog?: typeof loadHostCatalog;
  loadIdMap?: typeof loadIdMap;
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
  // Set BEFORE the catalog and the config load: the config's own `preserveUnknown` validation reads
  // it at eval time (config/context.ts), and it must describe the catalog that is about to be loaded.
  //
  // Restored in the `finally` below, so the flag lives no longer than the build that asked for it.
  // For a one-shot CLI that is merely tidy, but `contracts.ts` anticipates an HTTP adapter, and in a
  // long-lived process one `--strict-catalog` plan would otherwise leave EVERY later plan strict —
  // a setting silently outliving its request, on the exact flag whose whole job is to decide whether
  // a plan fails or warns.
  const previousStrict = STRICT_CATALOG;
  setStrictCatalog(request.strictCatalog ?? false);
  try {
    const catalogPath = await (dependencies.loadHostCatalog ?? loadHostCatalog)(
      project.host,
      join(project.cwd, CATALOG_DIR),
    );
    // Loaded beside the permission catalog and from the same directory: both are committed, per-host
    // artefacts a consumer repo keeps under `.ct/`.
    const idMap = await (dependencies.loadIdMap ?? loadIdMap)(project.host, join(project.cwd, CATALOG_DIR));
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
      idMap,
    });

    observer.emit({ type: "phase-started", phase: "build-plan" });
    const [resourceResult, permissionResult] = await Promise.all([
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
          tofuIdMapPath: idMap?.path ?? null,
        },
      },
    };
  } finally {
    setStrictCatalog(previousStrict);
  }
}
