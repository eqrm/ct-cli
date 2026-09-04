/**
 * The state file: explicitly managed ct-cli resources plus read-only external bindings.
 *
 * `resources` maps owned logical keys to ids and managed-field snapshots;
 * `externals` maps consumer keys to ids and minimal hard-identity snapshots. Only
 * the first partition participates in apply/destroy.
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

/** A read-only host binding. It is never part of desired/apply/destroy inputs. */
export interface ExternalResource {
  type: string;
  id: number;
  key: string;
  /** Optional coordination hint; ownership checks derive the real owner from visible managed states. */
  owner?: string;
  /** Minimal registry-defined hard identity. Display-only fields are deliberately not persisted. */
  identity: Record<string, unknown>;
  /** Creation time of this binding. Verification and identity acceptance never change it. */
  boundAt: string;
}

export interface State {
  /** Version 1 is accepted on in-memory test/adapter inputs; files always load/save as version 2. */
  version: 1 | 2;
  host: string;
  /** Keyed by logical key (e.g. "mainz", "mainz_kids_lead"). */
  resources: Record<string, ManagedResource>;
  /** Keyed by the same globally unique logical-key namespace as {@link resources}. */
  externals?: Record<string, ExternalResource>;
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
  return { version: 2, host, resources: {}, externals: {} };
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
  if (obj.version !== 1 && obj.version !== 2) {
    throw new Error(`Unsupported state file version ${String(obj.version)} in ${path}`);
  }
  if (typeof obj.host !== "string" || obj.host === "") {
    throw new Error(`Malformed state file ${path}: missing or empty "host".`);
  }
  if (typeof obj.resources !== "object" || obj.resources === null || Array.isArray(obj.resources)) {
    throw new Error(`Malformed state file ${path}: "resources" must be an object.`);
  }
  if (
    obj.version === 2 &&
    (typeof obj.externals !== "object" || obj.externals === null || Array.isArray(obj.externals))
  ) {
    throw new Error(`Malformed state file ${path}: "externals" must be an object in version 2.`);
  }
  validateManagedEntries(obj.resources as Record<string, unknown>, path);
  if (obj.version === 2) validateExternalEntries(obj.externals as Record<string, unknown>, path);
  return obj as unknown as State;
}

function entryObject(value: unknown, label: string, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Malformed state file ${path}: ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function validateCommonEntry(
  key: string,
  value: unknown,
  label: string,
  path: string,
): Record<string, unknown> {
  const entry = entryObject(value, label, path);
  if (entry.key !== key) {
    throw new Error(`Malformed state file ${path}: ${label}.key must equal its map key "${key}".`);
  }
  if (typeof entry.type !== "string" || entry.type === "") {
    throw new Error(`Malformed state file ${path}: ${label}.type must be a non-empty string.`);
  }
  if (typeof entry.id !== "number" || !Number.isSafeInteger(entry.id) || entry.id < 0) {
    throw new Error(`Malformed state file ${path}: ${label}.id must be a non-negative safe integer.`);
  }
  return entry;
}

function validateManagedEntries(resources: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(resources)) {
    const entry = validateCommonEntry(key, value, `resources.${key}`, path);
    entryObject(entry.fields, `resources.${key}.fields`, path);
  }
}

function validateExternalEntries(externals: Record<string, unknown>, path: string): void {
  for (const [key, value] of Object.entries(externals)) {
    const entry = validateCommonEntry(key, value, `externals.${key}`, path);
    entryObject(entry.identity, `externals.${key}.identity`, path);
    if (typeof entry.boundAt !== "string" || entry.boundAt === "") {
      throw new Error(`Malformed state file ${path}: externals.${key}.boundAt must be a non-empty string.`);
    }
    if (entry.owner !== undefined && (typeof entry.owner !== "string" || entry.owner === "")) {
      throw new Error(`Malformed state file ${path}: externals.${key}.owner must be a non-empty string.`);
    }
  }
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
  if (state.version === 1) {
    state.version = 2;
    state.externals = {};
  } else if (!state.externals) {
    state.externals = {};
  }
  assertStateKeyUniqueness(state);
  return state;
}

export async function saveState(path: string, state: State): Promise<void> {
  assertStateKeyUniqueness(state);
  const persisted: State = { ...state, version: 2, externals: state.externals ?? {} };
  await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

/** External entries, normalized for legacy in-memory callers. */
export function externalResources(state: State): Record<string, ExternalResource> {
  return state.externals ?? (state.externals = {});
}

/** Managed then external, matching the resolver's precedence. */
export function findByKey(state: State, key: string): ManagedResource | ExternalResource | undefined {
  return state.resources[key] ?? externalResources(state)[key];
}

export function findExternalByTypeId(state: State, type: string, id: number): ExternalResource | undefined {
  return Object.values(externalResources(state)).find((r) => r.type === type && r.id === id);
}

export function assertStateKeyUniqueness(state: State): void {
  for (const key of Object.keys(externalResources(state))) {
    if (state.resources[key]) {
      throw new Error(`Logical key "${key}" is used by both a managed and an external entry.`);
    }
  }
  const seen = new Map<string, string>();
  for (const [kind, entries] of [
    ["managed", Object.values(state.resources)],
    ["external", Object.values(externalResources(state))],
  ] as const) {
    for (const entry of entries) {
      const identity = `${entry.type}\0${entry.id}`;
      const prior = seen.get(identity);
      if (prior) {
        throw new Error(
          `${entry.type} #${entry.id} appears more than once in state (${prior} and ${kind} "${entry.key}").`,
        );
      }
      seen.set(identity, `${kind} "${entry.key}"`);
    }
  }
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
  const externalCollision = externalResources(state)[input.key];
  if (externalCollision) {
    throw new Error(
      `Logical key "${input.key}" is already used by external ${externalCollision.type} #${externalCollision.id}. ` +
        `Remove or rekey that binding first.`,
    );
  }
  const externalAlias = findExternalByTypeId(state, input.type, input.id);
  if (externalAlias) {
    throw new Error(
      `${input.type} #${input.id} is already external as "${externalAlias.key}". Remove that binding before adopting it.`,
    );
  }
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
