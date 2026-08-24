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
import { resolveWithEnv } from "../util/resolve.js";

export interface ManagedResource {
  type: string;
  id: number;
  key: string;
  /** Snapshot of the managed fields — the desired-state baseline. */
  fields: Record<string, unknown>;
  adoptedAt: string;
  updatedAt: string;
  /**
   * Lifecycle flag mirrored from the config's `preventDestroy` at apply time.
   * State — not the ephemeral config — is the source of truth for destroy
   * protection, so a resource stays protected after it is dropped from config
   * (the exact moment it becomes a destroy candidate). Missing = not protected.
   */
  preventDestroy?: boolean;
  /**
   * Groups only (#135): local member-field key → this host's ChurchTools member-field id.
   *
   * NOT a managed-field snapshot — it is never diffed and never written to ChurchTools. It exists
   * because a group-scoped member field has no logical key of its own in `resources` (it belongs to
   * exactly one group and is not globally reusable), yet a same-run reference to a field created in
   * THIS apply — a dynamic ruleset naming `<group>::<field>` — has to be completed from somewhere
   * once the field exists. `ct destroy --member-field` reads it too, so an explicit teardown does
   * not need a live lookup to find the id it is about to delete.
   */
  memberFields?: Record<string, number>;
}

export interface State {
  version: 1;
  host: string;
  /** Keyed by logical key (e.g. "mainz", "mainz_kids_lead"). */
  resources: Record<string, ManagedResource>;
}

export const DEFAULT_STATE_PATH = "ct-state.json";

/**
 * State-file precedence: explicit `--state` → `CT_STATE` → `fallback`.
 * `fallback` defaults to `ct-state.json` (single-host); under `--env`, the caller
 * passes the env profile's state path (e.g. `ct-state.<env>.json`) as the fallback.
 */
export function resolveStatePath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = DEFAULT_STATE_PATH,
): string {
  return resolveWithEnv(explicit, env.CT_STATE, fallback);
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

  const state = migrateState(validateState(parsed, path));
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

/**
 * In-place, version-preserving migrations for state loaded from disk.
 *
 * The campus registry field was renamed `shortName → shorty` (Phase 4) without a
 * state-version bump, so a campus adopted before the rename carries a stale
 * `shortName` key. Left alone it drifts forever (`shortName → undefined` on every
 * plan) and a real update PUTs the vestigial `shortName` while omitting the
 * create-required `shorty`. Rename the key on load — only when `shorty` is absent,
 * so a post-rename snapshot is never clobbered. The next apply re-writes the real
 * value; this just clears the phantom drift so the diff can converge.
 *
 * Contrast with an *additive* managed field (e.g. group `campusId`, #21): a snapshot from
 * before the field was managed simply lacks the key. That produces NO phantom drift and needs
 * no migration here, because the diff is desired-driven (`diffFields` only walks the config's
 * fields) and drift is snapshot-driven (`driftFields` only walks the old snapshot's keys) — a
 * key absent from both sides is never surfaced. The write body comes from the fetched actual
 * (#27), so an unrelated update never omits or reverts the new field, and the post-write snapshot
 * self-heals to include it. Only a *renamed/removed* key can drift forever; an added one cannot.
 */
function migrateState(state: State): State {
  for (const resource of Object.values(state.resources)) {
    if (resource.type !== "campus") continue;
    const fields = resource.fields;
    if ("shortName" in fields && !("shorty" in fields)) {
      fields.shorty = fields.shortName;
      delete fields.shortName;
    }
  }
  return state;
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

/**
 * The key a re-adoption should actually use, and whether it differs from the derived one (#123).
 *
 * `ct adopt group <id…> --with-dynamic` is the documented way to refresh a dynamic group's ruleset
 * once its scope targets become managed, and it runs over a LIST of ids — the one mode where `-k` is
 * rejected ("only valid when exactly one group is resolved"). Any resource whose adopted key differed
 * from the derived key was therefore silently re-keyed by that refresh: the config's declaration
 * matched nothing in state, a state entry existed that nothing declared, and the next plan read as
 * "one to create, one to destroy" for a resource that was fine and untouched on the host. The message
 * said only that the snapshot was "refreshed", which reads as *nothing else changed*.
 *
 * An adopted key was chosen deliberately — very likely with `-k`, to match the config's naming — so a
 * refresh touches the snapshot, not the identity.
 */
export interface AdoptKeyChoice {
  /** The key to store under. */
  key: string;
  /** Set when the derived key differs from the kept one — the caller warns with this. */
  wouldBecome?: string;
}

/**
 * Choose the key for an adoption. A resource already in state keeps its key unless `rekey` is set;
 * an explicit `--key` is an explicit intent and always wins. New resources just take `derived`.
 */
export function chooseAdoptKey(
  state: State,
  type: string,
  id: number,
  derived: string,
  opts: { explicitKey?: string; rekey?: boolean } = {},
): AdoptKeyChoice {
  const explicit = opts.explicitKey?.trim();
  if (explicit) return { key: explicit };
  const existing = findByTypeId(state, type, id);
  if (!existing || opts.rekey || existing.key === derived) return { key: derived };
  return { key: existing.key, wouldBecome: derived };
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
    // State is machine-only (#52): `updatedAt` bumps ONLY when the managed fields actually change, so
    // an apply that writes an identical snapshot leaves the committed state file byte-for-byte
    // unchanged (no churn). When unchanged, keep the EXISTING `fields` object (not the freshly-built
    // input one) so serialization order is preserved too — a mere key-order difference must not churn
    // the diff. `adoptedAt` is set once at first adoption and never touched again.
    const unchanged = fieldsEqual(existing.fields, input.fields);
    state.resources[input.key] = {
      ...existing,
      key: input.key,
      fields: unchanged ? existing.fields : input.fields,
      updatedAt: unchanged ? existing.updatedAt : now,
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

/**
 * Structural, order-independent equality for two managed-field bags (#52). Kept local so state — a
 * foundational module that imports no engine code — stays self-contained (mirrors the engine's
 * `deepEqual`, but a key-order difference between two structurally-identical snapshots must not be
 * seen as a change here either).
 *
 * Undefined-valued keys are treated as absent (`undefined === missing`), on both sides and
 * recursively at every level. This mirrors `JSON.stringify`/`JSON.parse` round-tripping, which is
 * how state is actually persisted and reloaded: a fresh snapshot built from `managedFields` can carry
 * explicit `foo: undefined` for an optional field the API omitted (e.g. group-type `nameTranslated`),
 * while the persisted snapshot loaded from disk simply lacks the key. Without this, re-adopting an
 * unchanged resource sees a key-count mismatch and spuriously bumps `updatedAt`.
 */
function fieldsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => fieldsEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => bo[k] !== undefined && fieldsEqual(ao[k], bo[k]));
}
