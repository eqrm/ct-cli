import { join } from "node:path";
import type { CtClient } from "../../api/ctClient.js";
import { parseDynamicGroupIds } from "../../api/dynamicGroups.js";
import { authedSession, type AuthedSession } from "../../api/session.js";
import { buildCoverageReport, decodeGroupsWithRoles, type CoverageReport } from "../../coverage/report.js";
import { CATALOG_DIR, loadHostCatalog } from "../../permissions/catalog-store.js";
import { fetchPermissionRows, type PermissionReader } from "../../permissions/fetch.js";
import { loadIdMap, type IdMap } from "../../resolve/idMap.js";
import { slug } from "../../resources/registry.js";
import { loadState, type State } from "../../state/state.js";
import type { OperationResult, ProjectRequest } from "../contracts.js";
import { noopObserver, type OperationObserver } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

const GROUPS_WITH_ROLES = "/groups?include[]=roles";

export interface CoverageRequest extends ProjectRequest {
  type?: string;
  declarable?: boolean;
  blocked?: boolean;
}

export interface CoverageValue {
  report: CoverageReport;
  permissionCatalogPath: string | null;
}

export type CoverageResult = OperationResult<CoverageValue>;

export interface CoverageOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadHostCatalog?: typeof loadHostCatalog;
  loadState?: typeof loadState;
  loadIdMap?: typeof loadIdMap;
  authedSession?: () => Promise<AuthedSession>;
  collectCoverage?: typeof collectCoverage;
  observer?: OperationObserver;
}

/** Fetch the fixed, bounded set of host-wide reads needed by the pure coverage report builder. */
export async function collectCoverage(
  client: PermissionReader & Pick<CtClient, "getAll">,
  host: string,
  state: State,
  idMap: Pick<IdMap, "entries"> | null = null,
): Promise<CoverageReport> {
  const [groupRows, groupTypeRows, dynamicRows, roleDefRows] = await Promise.all([
    client.getAll<Record<string, unknown>>(GROUPS_WITH_ROLES),
    client.getAll<Record<string, unknown>>("/group/grouptypes"),
    client.getAll<unknown>("/dynamicgroups"),
    client.getAll<Record<string, unknown>>("/group/roles"),
  ]);
  const groupRolePermissions = await fetchPermissionRows(client, "/permissions/group_role");

  const groupTypeNames = new Map<number, string>();
  for (const row of groupTypeRows.data) {
    const id = Number(row.id);
    if (Number.isFinite(id) && typeof row.name === "string") groupTypeNames.set(id, row.name);
  }
  const roleNamesById = new Map<number, string>();
  for (const row of roleDefRows.data) {
    const id = Number(row.id);
    if (Number.isFinite(id) && typeof row.name === "string") roleNamesById.set(id, row.name);
  }

  return buildCoverageReport({
    host,
    state,
    groups: decodeGroupsWithRoles(groupRows.data, roleNamesById),
    groupTypeNames,
    dynamicGroupIds: parseDynamicGroupIds(dynamicRows.data),
    groupRolePermissions: Array.isArray(groupRolePermissions) ? groupRolePermissions : [],
    idMapGroupKeys: new Map(
      (idMap?.entries ?? []).filter((e) => e.type === "group").map((e) => [e.id, e.key] as const),
    ),
  });
}

/** Canonical coverage query shared by terminal and future HTTP projections. */
export async function runCoverage(
  request: CoverageRequest = {},
  dependencies: CoverageOperationDependencies = {},
): Promise<CoverageResult> {
  const observer = dependencies.observer ?? noopObserver;
  observer.emit({ type: "phase-started", phase: "resolve-project" });
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  observer.emit({ type: "phase-started", phase: "load-project" });
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  const catalogPath = await (dependencies.loadHostCatalog ?? loadHostCatalog)(
    project.host,
    join(project.cwd, CATALOG_DIR),
  );
  const idMap = await (dependencies.loadIdMap ?? loadIdMap)(project.host, join(project.cwd, CATALOG_DIR));
  const { client } = await (dependencies.authedSession ?? authedSession)();
  observer.emit({ type: "phase-started", phase: "build-coverage" });
  const complete = await (dependencies.collectCoverage ?? collectCoverage)(
    client,
    project.host,
    state,
    idMap,
  );

  let roleInstances = complete.roleInstances;
  if (request.type) {
    const wanted = request.type.trim();
    const typeIds = new Set(
      complete.byType
        .filter((item) => item.name === wanted || slug(item.name) === slug(wanted))
        .map((item) => item.groupTypeId),
    );
    if (typeIds.size === 0) {
      throw new Error(
        `--type "${request.type}": no group type matches (checked by name and slug against this host).`,
      );
    }
    roleInstances = roleInstances.filter((item) => typeIds.has(item.groupTypeId));
  }
  if (request.declarable) roleInstances = roleInstances.filter((item) => item.verdict.declarable);
  if (request.blocked) roleInstances = roleInstances.filter((item) => !item.verdict.declarable);

  return {
    operation: "coverage",
    project,
    warnings: [],
    value: { report: { ...complete, roleInstances }, permissionCatalogPath: catalogPath },
  };
}
