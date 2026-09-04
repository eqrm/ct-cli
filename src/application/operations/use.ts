import { authedSession, type AuthedSession } from "../../api/session.js";
import { resourceType, slug, type CtWriteClient } from "../../resources/registry.js";
import {
  externalResources,
  findByTypeId,
  findExternalByTypeId,
  loadState,
  saveState,
  type ExternalResource,
} from "../../state/state.js";
import { identityDifferences, type ExternalCandidate } from "../../resolve/external.js";
import type { OperationResult, ProjectRequest } from "../contracts.js";
import { CtApplicationError } from "../errors.js";
import { InMemoryMutationLock } from "../prepared-operation-store.js";
import { systemClock, type Clock, type MutationLock } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface UseOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  saveState?: typeof saveState;
  authedSession?: () => Promise<AuthedSession>;
  clock?: Clock;
  lock?: MutationLock;
}

export interface DiscoverExternalRequest extends ProjectRequest {
  type: string;
  search: string;
}

export type DiscoverExternalResult = OperationResult<{
  type: string;
  search: string;
  candidates: ExternalCandidate[];
}>;

export type InspectExternalResult = OperationResult<{
  type: string;
  candidate: ExternalCandidate;
  /** Existing consumer key wins over a newly derived slug. */
  suggestedKey: string;
}>;

export interface UseResourceRequest extends ProjectRequest {
  type: string;
  id: string | number;
  key: string;
  owner?: string;
  acceptChanges?: boolean;
  dryRun?: boolean;
}

export type UseAction = "created" | "no-op" | "identity-updated" | "rebound" | "metadata-updated";

export type UseResourceResult = OperationResult<{
  action: UseAction;
  binding: ExternalResource;
  live: ExternalCandidate;
  previous?: ExternalResource;
  previousLive?: ExternalCandidate;
  identityDiff: ReturnType<typeof identityDifferences>;
  written: boolean;
  churchToolsWritten: false;
}>;

const defaultLock = new InMemoryMutationLock();

function parseId(raw: string | number): number {
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) throw new Error(`Invalid id "${raw}" — expected a non-negative integer.`);
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id)) throw new Error(`Invalid id "${raw}" — expected a safe integer.`);
  return id;
}

function requireKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("External logical key must be non-empty. Pass --key <key>.");
  if (/\s/.test(key)) throw new Error(`Logical key ${JSON.stringify(key)} must not contain whitespace.`);
  return key;
}

async function readOne(
  client: AuthedSession["client"],
  type: string,
  id: number,
): Promise<Record<string, unknown>> {
  const spec = resourceType(type);
  const row = spec.fetchOne
    ? await spec.fetchOne(client as CtWriteClient, id)
    : await client.get<Record<string, unknown>>(spec.itemPath(id));
  if (!row) throw new Error(`No ${type} with id ${id} exists in ChurchTools.`);
  return row;
}

function candidate(type: string, row: Record<string, unknown>): ExternalCandidate {
  const spec = resourceType(type);
  const id = row.id;
  if (typeof id !== "number") throw new Error(`Live ${type} candidate carries no numeric id.`);
  return {
    id,
    name: typeof row.name === "string" ? row.name : `#${id}`,
    identity: spec.external.identity(row),
    display: spec.external.display(row),
  };
}

/** Read-only fuzzy discovery for the terminal adapter. Never persists or resolves a reference. */
export async function discoverExternalCandidates(
  request: DiscoverExternalRequest,
  dependencies: UseOperationDependencies = {},
): Promise<DiscoverExternalResult> {
  const spec = resourceType(request.type);
  const search = request.search.trim();
  if (!search) throw new Error("Interactive search must be non-empty.");
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const { client } = await (dependencies.authedSession ?? authedSession)();
  const page = await client.getAll<Record<string, unknown>>(spec.collectionPath);
  const needle = search.toLocaleLowerCase();
  const needleSlug = slug(search);
  const matches = page.data.filter((row) => {
    const name = typeof row.name === "string" ? row.name : "";
    return name.toLocaleLowerCase().includes(needle) || slug(name).includes(needleSlug);
  });
  return {
    operation: "use",
    project,
    warnings: [],
    value: { type: request.type, search, candidates: matches.map((row) => candidate(request.type, row)) },
  };
}

/** Inspect one exact live id for interactive key proposal and replacement presentation. */
export async function inspectExternalCandidate(
  request: ProjectRequest & { type: string; id: string | number },
  dependencies: UseOperationDependencies = {},
): Promise<InspectExternalResult> {
  resourceType(request.type);
  const id = parseId(request.id);
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  const { client } = await (dependencies.authedSession ?? authedSession)();
  const row = await readOne(client, request.type, id);
  const live = candidate(request.type, { ...row, id });
  const existing = findExternalByTypeId(state, request.type, id);
  return {
    operation: "use",
    project,
    warnings: [],
    value: {
      type: request.type,
      candidate: live,
      suggestedKey: existing?.key ?? resourceType(request.type).deriveKey({ ...row, id }),
    },
  };
}

/** Validate and persist one explicit read-only binding. Never writes to ChurchTools. */
export async function runUseResource(
  request: UseResourceRequest,
  dependencies: UseOperationDependencies = {},
): Promise<UseResourceResult> {
  resourceType(request.type);
  const id = parseId(request.id);
  const key = requireKey(request.key);
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const lock = dependencies.lock ?? defaultLock;
  return lock.runExclusive(project.statePath, async () => {
    const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
    const managedKey = state.resources[key];
    if (managedKey) {
      throw new Error(
        `Logical key "${key}" is already managed as ${managedKey.type} #${managedKey.id}; it cannot also be external.`,
      );
    }
    const managedId = findByTypeId(state, request.type, id);
    if (managedId) {
      throw new Error(
        `${request.type} #${id} is already managed by this ct project as "${managedId.key}"; use is read-only and cannot duplicate ownership.`,
      );
    }
    const alias = findExternalByTypeId(state, request.type, id);
    if (alias && alias.key !== key) {
      throw new Error(
        `${request.type} #${id} is already external as "${alias.key}". Rekey that binding instead of creating a second alias.`,
      );
    }
    const { client } = await (dependencies.authedSession ?? authedSession)();
    const row = await readOne(client, request.type, id);
    const live = candidate(request.type, { ...row, id });
    const entries = externalResources(state);
    const existing = entries[key];
    if (existing && existing.type !== request.type) {
      throw new Error(
        `Logical key "${key}" is already external as ${existing.type} #${existing.id}, not ${request.type}.`,
      );
    }

    const now = (dependencies.clock ?? systemClock).now().toISOString();
    let action: UseAction;
    let binding: ExternalResource;
    let diff: ReturnType<typeof identityDifferences> = [];
    let previousLive: ExternalCandidate | undefined;
    if (!existing) {
      action = "created";
      binding = {
        type: request.type,
        key,
        id,
        ...(request.owner?.trim() ? { owner: request.owner.trim() } : {}),
        identity: live.identity,
        boundAt: now,
      };
    } else if (existing.id !== id) {
      action = "rebound";
      diff = identityDifferences(existing.identity, live.identity);
      try {
        const oldRow = await readOne(client, request.type, existing.id);
        previousLive = candidate(request.type, { ...oldRow, id: existing.id });
      } catch {
        // A stale old target is still useful evidence: the persisted snapshot remains in `previous`.
      }
      binding = {
        ...existing,
        id,
        identity: live.identity,
        boundAt: now,
        ...(request.owner?.trim() ? { owner: request.owner.trim() } : {}),
      };
    } else {
      diff = identityDifferences(existing.identity, live.identity);
      const owner = request.owner?.trim() || existing.owner;
      if (diff.length > 0) action = "identity-updated";
      else if (owner !== existing.owner) action = "metadata-updated";
      else action = "no-op";
      binding = {
        ...existing,
        ...(owner ? { owner } : {}),
        identity: diff.length > 0 ? live.identity : existing.identity,
      };
    }

    if ((action === "identity-updated" || action === "rebound") && !request.acceptChanges) {
      throw new CtApplicationError(
        "EXTERNAL_CONFIRMATION_REQUIRED",
        action === "rebound"
          ? `${request.type}.${key} is bound to #${existing!.id} (${JSON.stringify(previousLive ?? existing!.identity)}), not #${id} (${JSON.stringify(live)}). Explicit confirmation is required to replace it.`
          : `${request.type}.${key} #${id} changed hard identity: ${diff.map((item) => `${item.field}: ${JSON.stringify(item.expected)} -> ${JSON.stringify(item.actual)}`).join(", ")}. Explicit confirmation is required to accept the field diff.`,
        {
          details: {
            action,
            type: request.type,
            key,
            oldId: existing!.id,
            newId: id,
            identityDiff: diff as never,
            previous: existing as never,
            live: live as never,
            proposed: binding as never,
            previousLive: (previousLive ?? null) as never,
          },
        },
      );
    }

    const written = action !== "no-op" && !request.dryRun;
    if (written) {
      entries[key] = binding;
      await (dependencies.saveState ?? saveState)(project.statePath, state);
    }
    return {
      operation: "use",
      project,
      warnings: [],
      value: {
        action,
        binding,
        live,
        ...(existing ? { previous: existing } : {}),
        ...(previousLive ? { previousLive } : {}),
        identityDiff: diff,
        written,
        churchToolsWritten: false,
      },
    };
  });
}
