import type { ExternalResource, ManagedResource } from "../../state/state.js";
import { CtApplicationError } from "../errors.js";
import { PreparedOperationStore } from "../prepared-operation-store.js";
import {
  removeStateEntry,
  type StateOperationDependencies,
  type StateRemoveRequest,
  type StateRemoveResult,
} from "./state.js";

export type ReleaseKind = "managed" | "external";
export type ReleaseOperation = "unadopt" | "unuse";
export type ReleaseConfirmation =
  { type: "environment"; expected: string } | { type: "key"; expected: string };
export type ReleaseConfirmationProof =
  { type: "environment"; value: string } | { type: "key"; value: string };

export interface ReleaseRequest extends StateRemoveRequest {
  kind: ReleaseKind;
}

export interface PreparedReleaseExecution {
  request: StateRemoveRequest;
  entry: ManagedResource | ExternalResource;
  confirmation: ReleaseConfirmation;
}

export interface PreparedRelease {
  id: string;
  preview: StateRemoveResult;
  confirmation: ReleaseConfirmation;
}

export interface ReleaseOperationDependencies extends StateOperationDependencies {
  store?: PreparedOperationStore<PreparedReleaseExecution>;
  /** `null` disables wall-clock expiry for a CLI prompt; adapters get a bounded default. */
  preparedTtlMs?: number | null;
}

const PREPARED_RELEASE_TTL_MS = 5 * 60 * 1000;
const defaultStore = new PreparedOperationStore<PreparedReleaseExecution>();

function operation(kind: ReleaseKind): ReleaseOperation {
  return kind === "managed" ? "unadopt" : "unuse";
}

function assertConfirmation(requirement: ReleaseConfirmation, proof?: ReleaseConfirmationProof): void {
  if (proof?.type === requirement.type && proof.value === requirement.expected) return;
  throw new CtApplicationError(
    "STATE_RELEASE_CONFIRMATION_REQUIRED",
    `${requirement.type === "environment" ? "Environment" : "Logical key"} ` +
      `${JSON.stringify(requirement.expected)} was not confirmed. State was not changed.`,
    { details: { confirmationType: requirement.type, expected: requirement.expected } },
  );
}

/** Prepare and retain the exact state entry the adapter must present for confirmation. */
export async function prepareRelease(
  request: ReleaseRequest,
  dependencies: ReleaseOperationDependencies = {},
): Promise<PreparedRelease> {
  const op = operation(request.kind);
  const stateRequest: StateRemoveRequest = {
    type: request.type,
    key: request.key,
    cwd: request.cwd,
    configPath: request.configPath,
    statePath: request.statePath,
    environment: request.environment,
    force: request.force,
    expectedKind: request.kind,
    requireReadableConfig: true,
    operation: op,
    dryRun: true,
  };
  const preview = await removeStateEntry(stateRequest, dependencies);
  const confirmation: ReleaseConfirmation = preview.project.environment
    ? { type: "environment", expected: preview.project.environment }
    : { type: "key", expected: request.key };
  const stored = (dependencies.store ?? defaultStore).put(
    {
      request: { ...stateRequest, dryRun: false },
      entry: preview.value.entry,
      confirmation,
    },
    dependencies.preparedTtlMs === undefined ? PREPARED_RELEASE_TTL_MS : dependencies.preparedTtlMs,
  );
  return { id: stored.id, preview, confirmation };
}

/** Execute only the immutable entry that was previewed, after application-level proof validation. */
export async function executePreparedRelease(
  prepared: Pick<PreparedRelease, "id">,
  proof: ReleaseConfirmationProof | undefined,
  dependencies: ReleaseOperationDependencies = {},
): Promise<StateRemoveResult> {
  const store = dependencies.store ?? defaultStore;
  const candidate = store.peek(prepared.id);
  assertConfirmation(candidate.confirmation, proof);
  store.take(prepared.id);
  return removeStateEntry({ ...candidate.request, expectedEntry: candidate.entry }, dependencies);
}
