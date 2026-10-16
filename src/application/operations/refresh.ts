import type { CtClient } from "../../api/ctClient.js";
import { CtApiError } from "../../api/ctClient.js";
import { fetchDynamicGroupIds } from "../../api/dynamicGroups.js";
import { authedSession, type AuthedSession } from "../../api/session.js";
import { assertNotPeople } from "../../engine/guard.js";
import { join } from "node:path";
import { CATALOG_DIR } from "../../permissions/catalog-store.js";
import { loadIdMap, type IdMap } from "../../resolve/idMap.js";
import { loadState, type ManagedResource, type State } from "../../state/state.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { noopObserver, type OperationObserver } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface RefreshRequest extends ProjectRequest {
  group?: string;
  all?: boolean;
}

export interface RefreshCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface RefreshOutcome {
  key: string;
  id: number;
  counts: RefreshCounts | null;
  error: string | null;
}

export interface RefreshValue {
  outcomes: RefreshOutcome[];
  failed: number;
  fanOut: boolean;
}

export type RefreshResult = OperationResult<RefreshValue>;

export interface RefreshOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  loadIdMap?: typeof loadIdMap;
  authedSession?: () => Promise<AuthedSession>;
  selectTargets?: typeof selectRefreshTargets;
  observer?: OperationObserver;
}

/** Select only managed dynamic groups; the host-wide refresh endpoint remains unreachable. */
export async function selectRefreshTargets(
  client: Pick<CtClient, "getAll">,
  state: State,
  groupKey: string | undefined,
  idMap: Pick<IdMap, "ids"> | null = null,
): Promise<ManagedResource[]> {
  const dynamicIds = await fetchDynamicGroupIds(client);
  if (groupKey !== undefined) {
    let managed = state.resources[groupKey];
    if (!managed || managed.type !== "group") {
      // A group OpenTofu owns is in the id map, not in ct's state (#202); its ruleset is still ours.
      const mapped = idMap?.ids.get(`group\u0000${groupKey}`);
      if (mapped === undefined) {
        throw new Error(
          `--group "${groupKey}" is not a managed group in this state file or the OpenTofu id map. ` +
            `Adopt or declare it first.`,
        );
      }
      const at = new Date(0).toISOString();
      managed = { type: "group", id: mapped, key: groupKey, fields: {}, adoptedAt: at, updatedAt: at };
    }
    if (!dynamicIds.has(managed.id)) {
      throw new Error(
        `--group "${groupKey}" (#${managed.id}) is not a dynamic group on this host — there is no ruleset to evaluate.`,
      );
    }
    return [managed];
  }
  return Object.values(state.resources).filter(
    (resource) => resource.type === "group" && dynamicIds.has(resource.id),
  );
}

/** Canonical guarded refresh mutation used by CLI and future HTTP adapters. */
export async function runRefresh(
  request: RefreshRequest,
  dependencies: RefreshOperationDependencies = {},
): Promise<RefreshResult> {
  if (!request.group && !request.all) {
    throw new Error(
      "Specify --group <key> for one group, or --all to refresh every managed dynamic group. " +
        "Refreshing recomputes membership, so the fan-out is never the default.",
    );
  }
  if (request.group && request.all) throw new Error("Specify only one of: --group, --all.");

  const observer = dependencies.observer ?? noopObserver;
  observer.emit({ type: "phase-started", phase: "resolve-project" });
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  const idMap = await (dependencies.loadIdMap ?? loadIdMap)(project.host, join(project.cwd, CATALOG_DIR));
  const { client } = await (dependencies.authedSession ?? authedSession)();
  observer.emit({ type: "phase-started", phase: "select-refresh-targets" });
  const targets = await (dependencies.selectTargets ?? selectRefreshTargets)(
    client,
    state,
    request.group,
    idMap,
  );

  const outcomes: RefreshOutcome[] = [];
  // The caution has to reach the operator BEFORE membership is recomputed. Returning it in
  // `warnings[]` put it on screen after all N groups had already been refreshed (#156 review).
  const warnings: CtWarning[] =
    request.all && targets.length > 0
      ? [
          {
            code: "REFRESH_FAN_OUT",
            message: `Refreshing ${targets.length} managed dynamic group(s) — this recomputes membership.`,
          },
        ]
      : [];
  for (const warning of warnings) observer.emit({ type: "warning", warning });
  observer.emit({ type: "phase-started", phase: "refresh-groups" });
  for (const target of targets) {
    const path = `/dynamicgroups/${target.id}/refresh`;
    assertNotPeople(path);
    try {
      const response = await client.request<RefreshCounts[]>("POST", path);
      const counts = response?.[0] ?? null;
      outcomes.push({ key: target.key, id: target.id, counts, error: null });
      observer.emit({
        type: "outcome",
        outcome: {
          status: "ok",
          message: counts
            ? `refreshed ${target.key} (#${target.id}): +${counts.created} ~${counts.updated} -${counts.deleted}`
            : `refreshed ${target.key} (#${target.id})`,
        },
      });
    } catch (caught) {
      const message = caught instanceof CtApiError ? `HTTP ${caught.status}` : (caught as Error).message;
      outcomes.push({ key: target.key, id: target.id, counts: null, error: message });
      observer.emit({
        type: "outcome",
        outcome: { status: "failed", message: `Failed to refresh ${target.key} (#${target.id}): ${message}` },
      });
    }
  }

  return {
    operation: "refresh",
    project,
    warnings,
    value: {
      outcomes,
      failed: outcomes.filter((outcome) => outcome.error !== null).length,
      fanOut: request.all ?? false,
    },
  };
}
