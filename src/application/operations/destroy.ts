import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { authedSession, type AuthedSession } from "../../api/session.js";
import { CtApiError, type CtClient } from "../../api/ctClient.js";
import { formatError } from "../../api/format.js";
import { loadState, saveState, type State } from "../../state/state.js";
import { RESOURCES, type CtWriteClient } from "../../resources/registry.js";
import { assertNotPeople } from "../../engine/guard.js";
import { orderKeys } from "../../engine/graph.js";
import { fetchActual } from "../../engine/build.js";
import { parentIdsByGroupId, managedParentKeys, type HierarchyEntry } from "../../engine/hierarchy.js";
import type { DesiredResource } from "../../engine/types.js";
import { writeBackup } from "../../engine/backup.js";
import {
  groupScopedRows,
  memberFieldStateKey,
  knownMemberFieldId,
  matchingMemberFieldRows,
  memberFieldItemPath,
  memberFieldRowId,
  memberFieldsReadPath,
  parseMemberFieldIdentity,
} from "../../engine/member-fields.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { CtApplicationError } from "../errors.js";
import { InMemoryMutationLock, PreparedOperationStore } from "../prepared-operation-store.js";
import {
  noopObserver,
  systemClock,
  type Clock,
  type MutationLock,
  type OperationObserver,
} from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";
import { resolveBackupDir, type ConfirmationProof, type ConfirmationRequirement } from "./apply.js";

const PREPARED_DESTROY_TTL_MS = 5 * 60 * 1000;

/**
 * Record an outcome AND report it the moment it happens.
 *
 * Destroy is irreversible, so the list of what has already been deleted must never depend on the
 * run reaching its `return`: a throw from `save()`, or from the `assertNotPeople` guard on a later
 * target, used to discard the whole array and leave the operator with no record (#156 review).
 */
function record(
  outcomes: DestroyOutcome[],
  observer: OperationObserver | undefined,
  outcome: DestroyOutcome,
): void {
  outcomes.push(outcome);
  observer?.emit({
    type: "outcome",
    outcome: {
      status: outcome.status === "destroyed" || outcome.status === "already-absent" ? "ok" : "failed",
      message: outcome.message,
    },
  });
}

export interface DestroyRequest extends ProjectRequest {
  targets?: string[];
  /** Group-scoped member fields to delete, by their portable `<groupKey>::<fieldKey>` identity (#135). */
  memberFields?: string[];
  backupDir?: string;
}

export interface DestroyOutcome {
  kind: "resource" | "member-field";
  key: string;
  id: number | null;
  status: "destroyed" | "already-absent" | "skipped" | "failed";
  message: string;
}

export interface PreparedDestroy {
  id: string;
  project: OperationResult<never>["project"];
  targets: string[];
  memberFields: string[];
  backupPath: string;
  warnings: CtWarning[];
  confirmation: ConfirmationRequirement & { expected?: string };
  /** `null` when the prepared operation has no wall-clock expiry (the CLI's own runs). */
  expiresAt: string | null;
}

export type DestroyResult = OperationResult<{
  backupPath: string;
  outcomes: DestroyOutcome[];
  complete: boolean;
}>;

export interface PreparedDestroyExecution {
  project: PreparedDestroy["project"];
  state: State;
  client: CtClient;
  ordered: string[];
  memberFieldTargets: MemberFieldTarget[];
  backupPath: string;
  warnings: CtWarning[];
  confirmation: PreparedDestroy["confirmation"];
  stateFingerprint: string;
}

export interface DestroyOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  saveState?: typeof saveState;
  authedSession?: () => Promise<AuthedSession>;
  fetchActual?: typeof fetchActual;
  writeBackup?: typeof writeBackup;
  store?: PreparedOperationStore<PreparedDestroyExecution>;
  lock?: MutationLock;
  observer?: OperationObserver;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  /** `null` disables the wall-clock expiry entirely; omit for the default TTL. */
  preparedTtlMs?: number | null;
  readStateFile?: (path: string) => Promise<string>;
}

const defaultStore = new PreparedOperationStore<PreparedDestroyExecution>();
const defaultLock = new InMemoryMutationLock();

async function stateFingerprint(
  path: string,
  read: (path: string) => Promise<string> = (value) => readFile(value, "utf8"),
): Promise<string> {
  return createHash("sha256")
    .update(await read(path))
    .digest("hex");
}

/** Flatten repeated/comma-separated `--target` values into a deduped key list. */
export function parseTargets(raw: string[]): string[] {
  const out: string[] = [];
  for (const chunk of raw) {
    for (const part of chunk.split(",")) {
      const key = part.trim();
      if (key && !out.includes(key)) {
        out.push(key);
      }
    }
  }
  return out;
}

/**
 * Reverse dependency order for destroy: highest tier first (leaves before their
 * base metadata) and, within the group tier, a child before its parent.
 *
 * The state file carries no hierarchy edges (the synthetic `parents` field is
 * stripped from snapshots — see execute.ts), so the caller passes `parentKeysByKey`
 * discovered live from `/groups/hierarchies` (managed groups only). We reuse
 * `orderKeys` — the very topological apply order plan uses — with those edges,
 * then reverse it, so destroy is the exact inverse of apply and honours intra-tier
 * parent edges. Pass an empty map (or omit) to fall back to tier-only ordering.
 */
export function orderDestroy(
  state: State,
  keys: string[],
  parentKeysByKey: Map<string, string[]> = new Map(),
): string[] {
  const entries: DesiredResource[] = keys.map((key) => ({
    type: state.resources[key]!.type,
    key,
    fields: {},
    dependsOn: parentKeysByKey.get(key) ?? [],
  }));
  return orderKeys(entries).reverse();
}

/**
 * Discover managed group→parent edges from the live `/groups/hierarchies`, so
 * `orderDestroy` can put a child before its parent. Only the group targets need
 * edges; every managed group is mapped id→key so a parent edge to a not-targeted
 * managed group is still resolvable (harmless — `orderKeys` ignores deps outside
 * the target set). Best-effort: a fetch failure warns and returns no edges, so
 * ordering degrades to tier-only rather than aborting the destroy.
 */
async function fetchParentEdges(
  client: Pick<CtClient, "get">,
  state: State,
  keys: string[],
  warnings: CtWarning[],
): Promise<Map<string, string[]>> {
  const groupKeys = keys.filter((k) => state.resources[k]?.type === "group");
  if (groupKeys.length === 0) return new Map();
  const groupIdToKey = new Map<number, string>();
  for (const m of Object.values(state.resources)) {
    if (m.type === "group") groupIdToKey.set(m.id, m.key);
  }
  try {
    const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
    const parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
    const edges = new Map<string, string[]>();
    for (const key of groupKeys) {
      edges.set(key, managedParentKeys(parentIds.get(state.resources[key]!.id) ?? [], groupIdToKey));
    }
    return edges;
  } catch (err) {
    warnings.push({
      code: "DESTROY_HIERARCHY_UNREADABLE",
      message: `Failed to fetch group hierarchies for destroy ordering: ${formatError(err)}. Falling back to tier-only order.`,
    });
    return new Map();
  }
}

/**
 * Type-level teardown warnings for the targets of this run (#99 review) — one line per target whose
 * resource type declares a `destroyWarning`. A non-empty result also means `--force` must NOT skip
 * the typed confirmation: these are the deletes whose blast radius leaves the managed surface (today:
 * `person-status`, whose deletion mutates every person carrying it), so an unattended `--force`
 * teardown is exactly the run that should stop and ask.
 */
/** One `--member-field` target, resolved against state. */
export interface MemberFieldTarget {
  /** The portable `<groupKey>::<fieldKey>` identity, as typed. */
  identity: string;
  groupKey: string;
  fieldKey: string;
  groupId: number;
}

/**
 * Resolve `--member-field <group>::<field>` targets against the state file (#135).
 *
 * This is the EXPLICIT destructive operation a group member field can only ever be removed by.
 * `apply` never deletes one — a field dropped from config produces no desired key at all, so the
 * diff engine is structurally unable to propose it (see engine/synthetic.ts) — and `ct destroy
 * --target` addresses whole managed resources, which a member field is not: it has no state entry
 * of its own because it belongs to exactly one group.
 *
 * Guardrails are the group's: the owning group must be managed, and `preventDestroy` on it blocks
 * its fields too — protecting a group protects what it owns.
 */
export function resolveMemberFieldTargets(state: State, raw: string[]): MemberFieldTarget[] {
  const out: MemberFieldTarget[] = [];
  for (const identity of parseTargets(raw)) {
    const parsed = parseMemberFieldIdentity(identity);
    if (!parsed) {
      throw new Error(
        `"${identity}" is not a group member field identity. Use "<groupKey>::<fieldKey>" ` +
          `(e.g. "ojbp_2026_27_praktikum_1::wahl").`,
      );
    }
    const managed = state.resources[parsed.group];
    if (!managed || managed.type !== "group") {
      throw new Error(
        `"${identity}": no managed group "${parsed.group}" in the state file. A member field can only ` +
          `be destroyed through the group that owns it.`,
      );
    }
    if (managed.preventDestroy) {
      throw new Error(
        `preventDestroy is set (in state) for group "${parsed.group}", which owns "${identity}". ` +
          `Clear the protection first — protecting a group protects its member fields too.`,
      );
    }
    out.push({
      identity,
      groupKey: parsed.group,
      fieldKey: parsed.field,
      groupId: managed.id,
    });
  }
  return out;
}

/**
 * Delete each resolved member field, dropping its id from the owning group's state entry and saving
 * after every success. A field that is already gone in ChurchTools (no live row, or a 404 on the
 * DELETE) is success-with-note, mirroring `runDeleteLoop`; any other error stops the run with state
 * saved up to that point.
 *
 * Returns structured outcomes and `complete:false` if any target failed, so the caller can hold back
 * the group deletes that follow. That gate matters: the groups being destroyed are the very groups
 * these fields belong to, so carrying on would delete a field the run just reported it could not delete.
 */
export async function runMemberFieldDeleteLoop(ctx: {
  client: Pick<CtClient, "get" | "request">;
  state: State;
  statePath: string;
  targets: MemberFieldTarget[];
  save?: (path: string, state: State) => Promise<void>;
  observer?: OperationObserver;
}): Promise<{ outcomes: DestroyOutcome[]; complete: boolean }> {
  const { client, state, statePath, targets } = ctx;
  const save = ctx.save ?? saveState;
  const outcomes: DestroyOutcome[] = [];
  for (const target of targets) {
    const forget = async (): Promise<void> => {
      const managed = state.resources[target.groupKey];
      // Slugged, exactly as the apply that wrote it keyed the entry (`memberFieldStateKey`) and as
      // the live row was resolved above — otherwise `--member-field g::Wahl` deletes the field in
      // ChurchTools but leaves `memberFields.wahl` pointing at the id it just destroyed.
      const stateKey = memberFieldStateKey(target.fieldKey);
      if (managed?.memberFields && stateKey in managed.memberFields) {
        const rest = { ...managed.memberFields };
        delete rest[stateKey];
        if (Object.keys(rest).length > 0) managed.memberFields = rest;
        else delete managed.memberFields;
      }
      await save(statePath, state);
    };
    let fieldId: number | undefined;
    try {
      const rows = groupScopedRows(await client.get(memberFieldsReadPath(target.groupId)));
      // The state binding wins where there is one. `--member-field g::wahl` is exactly the command
      // every identity-mismatch message hands the operator, and those are the cases where the live
      // row's name or referenceName has drifted away from the local key: matching on the key alone
      // would report "already absent", drop the binding, and let the next apply POST a duplicate.
      const matches = matchingMemberFieldRows(
        rows,
        target.fieldKey,
        undefined,
        knownMemberFieldId(state, target.groupKey, target.fieldKey),
      );
      if (matches.length > 1) {
        record(outcomes, ctx.observer, {
          kind: "member-field",
          key: target.identity,
          id: null,
          status: "failed",
          message:
            `${target.identity}: ${matches.length} member fields on group #${target.groupId} answer to ` +
            `"${target.fieldKey}" — refusing to guess which one to delete. Rename one in ChurchTools first.`,
        });
        continue;
      }
      fieldId = matches.length === 1 ? memberFieldRowId(matches[0]!) : undefined;
    } catch (err) {
      record(outcomes, ctx.observer, {
        kind: "member-field",
        key: target.identity,
        id: null,
        status: "failed",
        message: `Stopped at ${target.identity}: ${formatError(err)}. Nothing further was deleted.`,
      });
      return { outcomes, complete: false };
    }
    if (fieldId === undefined) {
      await forget();
      record(outcomes, ctx.observer, {
        kind: "member-field",
        key: target.identity,
        id: null,
        status: "already-absent",
        message: `${target.identity} already absent in ChurchTools — nothing to delete`,
      });
      continue;
    }
    const path = memberFieldItemPath(target.groupId, fieldId);
    assertNotPeople(path);
    try {
      await client.request("DELETE", path);
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        await forget();
        record(outcomes, ctx.observer, {
          kind: "member-field",
          key: target.identity,
          id: fieldId,
          status: "already-absent",
          message: `${target.identity} (#${fieldId}) already deleted in ChurchTools`,
        });
        continue;
      }
      record(outcomes, ctx.observer, {
        kind: "member-field",
        key: target.identity,
        id: fieldId,
        status: "failed",
        message: `Stopped at ${target.identity}: ${formatError(err)}. State saved up to this point — re-run to resume.`,
      });
      return { outcomes, complete: false };
    }
    await forget();
    ctx.observer?.emit({
      type: "resource-destroyed",
      resourceType: "group-member-field",
      key: target.identity,
      id: fieldId,
    });
    record(outcomes, ctx.observer, {
      kind: "member-field",
      key: target.identity,
      id: fieldId,
      status: "destroyed",
      message: `Destroyed group member field ${target.identity} (#${fieldId})`,
    });
  }
  return { outcomes, complete: outcomes.every((outcome) => outcome.status !== "failed") };
}

export function destroyWarnings(state: State, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const type = state.resources[key]?.type;
    const warning = type ? RESOURCES[type]?.destroyWarning : undefined;
    if (warning) out.push(`${type}.${key}: ${warning}`);
  }
  return out;
}

export async function prepareDestroy(
  request: DestroyRequest,
  dependencies: DestroyOperationDependencies = {},
): Promise<PreparedDestroy> {
  const targets = parseTargets(request.targets ?? []);
  const memberFieldArgs = parseTargets(request.memberFields ?? []);
  if (targets.length === 0 && memberFieldArgs.length === 0) {
    throw new Error("No --target or --member-field given. Destroy never deletes implicitly.");
  }

  const observer = dependencies.observer ?? noopObserver;
  observer.emit({ type: "phase-started", phase: "resolve-project" });
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  for (const key of targets) {
    if (!state.resources[key]) {
      throw new Error(`"${key}" is not managed (not in the state file). Nothing to destroy.`);
    }
  }
  const blocked = targets.filter((key) => state.resources[key]!.preventDestroy);
  if (blocked.length > 0) {
    throw new CtApplicationError(
      "PREVENT_DESTROY",
      `preventDestroy is set (in state) for: ${blocked.join(", ")}. ` +
        `Set preventDestroy:false in config and re-apply (or clear it in the state file) first.`,
      { details: { targets: blocked } },
    );
  }

  const memberFieldTargets = resolveMemberFieldTargets(state, memberFieldArgs);
  const { client } = await (dependencies.authedSession ?? authedSession)();
  const warnings: CtWarning[] = [];
  const parentEdges = await fetchParentEdges(client, state, targets, warnings);
  const ordered = orderDestroy(state, targets, parentEdges);

  observer.emit({ type: "phase-started", phase: "backup" });
  const { actual, fetchErrors } = await (dependencies.fetchActual ?? fetchActual)(
    client,
    ordered.map((key) => state.resources[key]!),
  );
  if (fetchErrors.length > 0) {
    throw new CtApplicationError(
      "DESTROY_BACKUP_FAILED",
      `Backup fetch failed for: ${fetchErrors.join("; ")}. Nothing was deleted — resolve the error (or wait out the outage) and re-run.`,
      { details: { fetchErrors } },
    );
  }
  for (const target of memberFieldTargets) {
    try {
      const rows = groupScopedRows(await client.get(memberFieldsReadPath(target.groupId)));
      // Same resolution as the delete loop below, so the backup holds the row that is deleted.
      const match = matchingMemberFieldRows(
        rows,
        target.fieldKey,
        undefined,
        knownMemberFieldId(state, target.groupKey, target.fieldKey),
      )[0];
      if (match) actual.set(target.identity, match);
    } catch (err) {
      throw new CtApplicationError(
        "DESTROY_BACKUP_FAILED",
        `Backup fetch failed for ${target.identity}: ${formatError(err)}. Nothing was deleted — resolve the error and re-run.`,
        { cause: err, details: { target: target.identity } },
      );
    }
  }
  const backupPath = await (dependencies.writeBackup ?? writeBackup)(
    resolveBackupDir(request.backupDir, project.statePath, dependencies.env),
    project.host,
    actual,
    (dependencies.clock ?? systemClock).now(),
  );
  observer.emit({ type: "backup-written", path: backupPath });

  const risky = destroyWarnings(state, ordered);
  warnings.push(...risky.map((message) => ({ code: "DESTROY_RISK", message: `RISK — ${message}` })));
  const expected =
    targets.length === 1 && memberFieldTargets.length === 0
      ? targets[0]!
      : targets.length === 0 && memberFieldTargets.length === 1
        ? memberFieldTargets[0]!.identity
        : "destroy";
  const confirmation: PreparedDestroy["confirmation"] = project.protected
    ? { type: "environment", environment: project.environment!, expected: project.environment! }
    : { type: "yes", expected };
  const store = dependencies.store ?? defaultStore;
  const fingerprint = await stateFingerprint(project.statePath, dependencies.readStateFile);
  const stored = store.put(
    {
      project,
      state,
      client,
      ordered,
      memberFieldTargets,
      backupPath,
      warnings,
      confirmation,
      stateFingerprint: fingerprint,
    },
    dependencies.preparedTtlMs === undefined ? PREPARED_DESTROY_TTL_MS : dependencies.preparedTtlMs,
  );
  return {
    id: stored.id,
    project,
    targets: ordered,
    memberFields: memberFieldTargets.map((target) => target.identity),
    backupPath,
    warnings,
    confirmation,
    expiresAt: stored.expiresAt === null ? null : stored.expiresAt.toISOString(),
  };
}

function assertDestroyConfirmation(
  requirement: PreparedDestroy["confirmation"],
  proof: ConfirmationProof | undefined,
): void {
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
  throw new CtApplicationError("PLAN_CONFIRMATION_MISMATCH", "Destroy confirmation was not provided.");
}

export async function executePreparedDestroy(
  prepared: Pick<PreparedDestroy, "id">,
  proof: ConfirmationProof | undefined,
  dependencies: DestroyOperationDependencies = {},
): Promise<DestroyResult> {
  const store = dependencies.store ?? defaultStore;
  const candidate = store.peek(prepared.id);
  assertDestroyConfirmation(candidate.confirmation, proof);
  const lock = dependencies.lock ?? defaultLock;
  return lock.runExclusive(candidate.project.statePath, async () => {
    const stored = store.take(prepared.id);
    const currentFingerprint = await stateFingerprint(stored.project.statePath, dependencies.readStateFile);
    if (currentFingerprint !== stored.stateFingerprint) {
      throw new CtApplicationError(
        "PLAN_CONFIRMATION_MISMATCH",
        "The state file changed after this destroy was prepared. Prepare and confirm it again.",
        { details: { statePath: stored.project.statePath } },
      );
    }
    const outcomes: DestroyOutcome[] = [];
    const observer = dependencies.observer ?? noopObserver;
    if (stored.memberFieldTargets.length > 0) {
      observer.emit({ type: "phase-started", phase: "destroy-member-fields" });
      const fields = await runMemberFieldDeleteLoop({
        client: stored.client,
        state: stored.state,
        statePath: stored.project.statePath,
        targets: stored.memberFieldTargets,
        save: dependencies.saveState,
        observer,
      });
      outcomes.push(...fields.outcomes);
      if (!fields.complete) {
        if (stored.ordered.length > 0) {
          record(outcomes, observer, {
            kind: "resource",
            key: stored.ordered.join(", "),
            id: null,
            status: "skipped",
            message: `Not destroying ${stored.ordered.join(", ")} — a member field on it could not be deleted first.`,
          });
        }
        return {
          operation: "destroy",
          project: stored.project,
          warnings: stored.warnings,
          value: { backupPath: stored.backupPath, outcomes, complete: false },
        };
      }
    }
    if (stored.ordered.length > 0) {
      observer.emit({ type: "phase-started", phase: "destroy-resources" });
    }
    outcomes.push(
      ...(await runDeleteLoop({
        client: stored.client,
        state: stored.state,
        statePath: stored.project.statePath,
        ordered: stored.ordered,
        save: dependencies.saveState,
        observer,
      })),
    );
    return {
      operation: "destroy",
      project: stored.project,
      warnings: stored.warnings,
      value: {
        backupPath: stored.backupPath,
        outcomes,
        complete: outcomes.every((outcome) => outcome.status !== "failed" && outcome.status !== "skipped"),
      },
    };
  });
}

export interface DeleteLoopCtx {
  client: Pick<CtClient, "request">;
  state: State;
  statePath: string;
  ordered: string[];
  /** Injection seam for tests; defaults to the real state writer. */
  save?: (path: string, state: State) => Promise<void>;
  observer?: OperationObserver;
}

/**
 * Delete each ordered target, removing it from state and saving after each success.
 *
 * A 404 means the target was already deleted in ChurchTools (e.g. by hand in the UI):
 * treat it as success-with-note — drop the state entry, save, and continue to the next
 * target. Any non-404 error stops the run with state saved up to that point, so a re-run
 * can resume with the remaining targets. (Mirrors the backup loop's 404 tolerance.)
 */
export async function runDeleteLoop(ctx: DeleteLoopCtx): Promise<DestroyOutcome[]> {
  const { client, state, statePath, ordered } = ctx;
  const save = ctx.save ?? saveState;
  const outcomes: DestroyOutcome[] = [];
  for (const key of ordered) {
    const managed = state.resources[key]!;
    const spec = RESOURCES[managed.type];
    if (!spec) {
      // Skipped, not destroyed: the resource is still in ChurchTools AND still in state, so the
      // structured result must remain incomplete.
      record(outcomes, ctx.observer, {
        kind: "resource",
        key,
        id: managed.id,
        status: "skipped",
        message: `No write spec for type "${managed.type}" — skipping ${key}.`,
      });
      continue;
    }
    const path = spec.itemPath(managed.id);
    assertNotPeople(path);
    try {
      if (spec.writer) {
        // A type whose writes are not REST (#108: Bereiche). Without a `remove` it has no delete path
        // at all — say so instead of issuing a DELETE the endpoint does not implement, which would
        // 404/405 and read as "already deleted".
        if (!spec.writer.remove) {
          record(outcomes, ctx.observer, {
            kind: "resource",
            key,
            id: managed.id,
            status: "skipped",
            message:
              `${managed.type}.${key} (#${managed.id}) cannot be deleted by \`ct\` — ChurchTools exposes ` +
              `no delete for this type. Remove it in the ChurchTools admin UI, then re-run to drop it from state.`,
          });
          continue;
        }
        await spec.writer.remove({ client: client as CtWriteClient, id: managed.id });
      } else {
        await client.request("DELETE", path);
      }
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        delete state.resources[key];
        await save(statePath, state);
        record(outcomes, ctx.observer, {
          kind: "resource",
          key,
          id: managed.id,
          status: "already-absent",
          message: `${managed.type}.${key} (#${managed.id}) already deleted in ChurchTools — removed from state`,
        });
        continue;
      }
      // Same formatter the top-level handler uses (#50) so a non-404 CtApiError's HTTP status +
      // response body survive into the stop message (#71), not just the bare "... failed" text.
      record(outcomes, ctx.observer, {
        kind: "resource",
        key,
        id: managed.id,
        status: "failed",
        message: `Stopped at ${key}: ${formatError(err)}. State saved up to this point — re-run with the remaining targets to resume.`,
      });
      return outcomes;
    }
    delete state.resources[key];
    await save(statePath, state);
    ctx.observer?.emit({
      type: "resource-destroyed",
      resourceType: managed.type,
      key,
      id: managed.id,
    });
    record(outcomes, ctx.observer, {
      kind: "resource",
      key,
      id: managed.id,
      status: "destroyed",
      message: `Destroyed ${managed.type}.${key} (#${managed.id})`,
    });
  }
  return outcomes;
}
