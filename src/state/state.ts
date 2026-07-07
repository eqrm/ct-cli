/**
 * The state file: the set of **explicitly managed** resources.
 *
 * Everything not in here is invisible to the tool — never shown, never changed,
 * never proposed for deletion. It maps a logical key → CT id + the last-known
 * snapshot of the fields we manage (the desired-state baseline for diffing).
 *
 * The file belongs to the config repo (eqrm/ct-structure) and is meant to be
 * committed. Default path is `ct-state.json` in the cwd; override with
 * `--state <path>` or `CT_STATE`.
 *
 * CT ids can be `0` (the Mainz campus is `id: 0`), so every id comparison here
 * uses explicit null/undefined checks — never truthiness.
 */
import { readFile, writeFile } from "node:fs/promises";

export interface ManagedResource {
  type: string;
  id: number;
  key: string;
  /** Snapshot of the managed fields — the desired-state baseline. */
  fields: Record<string, unknown>;
  adoptedAt: string;
  updatedAt: string;
}

export interface State {
  version: 1;
  host: string;
  /** Keyed by logical key (e.g. "mainz", "mainz_kids_lead"). */
  resources: Record<string, ManagedResource>;
}

export const DEFAULT_STATE_PATH = "ct-state.json";

export function resolveStatePath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit?.trim() || env.CT_STATE?.trim() || DEFAULT_STATE_PATH;
}

export function emptyState(host: string): State {
  return { version: 1, host, resources: {} };
}

/**
 * Load the state file at `path`, validating its shape and asserting it belongs
 * to `host`. A missing file yields an empty state for `host`. `host` is the
 * instance the caller intends to operate on: a file recorded against a
 * different host is rejected here so no command (adopt, state list, …) can
 * silently mix instances.
 */
export async function loadState(path: string, host: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      return emptyState(host);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed state file ${path}: not valid JSON (${(err as Error).message}).`);
  }

  const state = validateState(parsed, path);
  if (state.host !== host) {
    throw new Error(
      `State file host (${state.host}) does not match CT_HOST (${host}). Refusing to mix instances.`,
    );
  }
  return state;
}

/** Assert the parsed JSON has the shape of a State; throw a friendly error otherwise. */
function validateState(parsed: unknown, path: string): State {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed state file ${path}: expected a JSON object at the top level.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Unsupported state file version ${String(obj.version)} in ${path}`);
  }
  if (typeof obj.host !== "string" || obj.host === "") {
    throw new Error(`Malformed state file ${path}: missing or empty "host".`);
  }
  if (typeof obj.resources !== "object" || obj.resources === null || Array.isArray(obj.resources)) {
    throw new Error(`Malformed state file ${path}: "resources" must be an object.`);
  }
  return obj as unknown as State;
}

export async function saveState(path: string, state: State): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Find a managed entry by CT type + id (id may legitimately be 0). */
export function findByTypeId(state: State, type: string, id: number): ManagedResource | undefined {
  return Object.values(state.resources).find((r) => r.type === type && r.id === id);
}

export function isManaged(state: State, type: string, id: number): boolean {
  return findByTypeId(state, type, id) !== undefined;
}

export interface UpsertInput {
  type: string;
  id: number;
  key: string;
  fields: Record<string, unknown>;
}

export type UpsertAction = "created" | "updated";

/**
 * Idempotently place a resource under management. Re-adopting the same
 * (type, id) updates it in place — and re-keys it if the logical key changed.
 * A key already taken by a *different* resource is a conflict, not an overwrite.
 */
export function upsert(state: State, input: UpsertInput, now: string): UpsertAction {
  const existing = findByTypeId(state, input.type, input.id);
  const collision = state.resources[input.key];
  if (collision && !(collision.type === input.type && collision.id === input.id)) {
    throw new Error(
      `Logical key "${input.key}" is already used by ${collision.type} #${collision.id}. ` +
        `Pass a different --key.`,
    );
  }

  if (existing) {
    if (existing.key !== input.key) {
      delete state.resources[existing.key];
    }
    state.resources[input.key] = {
      ...existing,
      key: input.key,
      fields: input.fields,
      updatedAt: now,
    };
    return "updated";
  }

  state.resources[input.key] = {
    type: input.type,
    id: input.id,
    key: input.key,
    fields: input.fields,
    adoptedAt: now,
    updatedAt: now,
  };
  return "created";
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
