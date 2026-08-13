/**
 * The config DSL. A config file default-exports a function that receives this
 * context and declares resources:
 *
 *   export default (ct: ConfigContext) => {
 *     ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
 *     ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupTypeId: 2 });
 *     ct.group({ key: "mainz_kids", name: "Mainz · Kids", groupTypeId: 2, parents: ["mainz_area"] });
 *   };
 *
 * The context is injected (no global state), so blueprints are just functions
 * and loops, and the whole thing is trivially testable without file I/O.
 */
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesiredResource, DynamicSpec, DynamicStatus } from "../engine/types.js";
import type { DomainType } from "../permissions/grants.js";
import type { DesiredPermission, Grant } from "../permissions/types.js";
import { GROUP_STATUS_NO_CATALOG, isRef, ref, refKey, type Ref } from "../resolve/refs.js";
import { normalizeScopeEntry } from "../permissions/scope.js";
import { conventionalRulesetRef, knownFields } from "../resources/registry.js";
import { warn } from "../ui.js";
// Re-exported so a config file can pull the query DSL from the same module as
// `ConfigContext`: `import { q, churchQuery } from "../../src/config/context.js"`.
export { q, churchQuery } from "./query.js";
export type { QueryNode } from "./query.js";
// Re-exported so a config can pull the logical-reference helper from the same module: it turns a
// name/key into an inert `Ref` sentinel the per-host resolver later maps to a numeric id (#20).
export { ref } from "../resolve/refs.js";

const DYNAMIC_STATUSES = ["active", "inactive", "manual", "none"] as const;

/** This module's own filesystem path — used to skip our own frames when locating a user call site. */
const SELF_FILE = fileURLToPath(import.meta.url);

/**
 * Best-effort source location of the user's `ct.*(...)` call, for located config errors/warnings (#52).
 * Walks `new Error().stack` for the first frame outside this module, node internals, and node_modules.
 * jiti transpiles the user's `.ts` config but maps stack frames back to the ORIGINAL file + line
 * (verified against the real loader), so the frame yields the author's actual location. Returns
 * `basename:line` (e.g. `ct.config.ts:42`), or `undefined` when no user frame is identifiable — callers
 * then omit the location rather than crash (V8-only `.stack`; a runtime without it degrades gracefully).
 */
function captureCallSite(): string | undefined {
  const stack = new Error().stack;
  if (typeof stack !== "string") return undefined;
  for (const raw of stack.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    // `at fn (PATH:LINE:COL)` (function named) or `at PATH:LINE:COL` (top-level/anonymous).
    const m = /\((.+):(\d+):(\d+)\)$/.exec(line) ?? /^at\s+(.+):(\d+):(\d+)$/.exec(line);
    if (!m) continue;
    let file = m[1]!;
    if (file.startsWith("file://")) file = fileURLToPath(file);
    if (file === SELF_FILE) continue; // our own wrapper / helper frames
    if (file.startsWith("node:")) continue; // node internals
    if (file.includes("/node_modules/")) continue; // jiti & other deps
    return `${basename(file)}:${m[2]}`;
  }
  return undefined;
}

/** Prefix a config error/warning message with its source location when known (#52). */
function located(location: string | undefined, message: string): string {
  return location ? `${location} — ${message}` : message;
}

/**
 * Prefix a thrown eval-time config error with its user call site (#52), once. Mutating `.message`
 * (rather than wrapping) keeps the original stack; the `__ctLocated` marker guards against a second
 * prefix if the same error somehow passes through another wrapper.
 */
function relocate(err: unknown, location: string | undefined): unknown {
  if (location && err instanceof Error && !(err as { __ctLocated?: boolean }).__ctLocated) {
    err.message = located(location, err.message);
    (err as { __ctLocated?: boolean }).__ctLocated = true;
  }
  return err;
}

/**
 * A group's `dynamic` (auto-group) declaration (#52 item B). Three interchangeable forms:
 *  - `true` — dynamic with `status: "active"` and the conventional `./rulesets/<key>.json` ruleset ref.
 *  - `"<path>.json"` — dynamic with `status: "active"` and an explicit ruleset-file ref.
 *  - `{ status, ruleset }` — the explicit form (a RuleSet object, a `{ ref }`, or a typed-query build).
 */
export type DynamicInput = boolean | string | { status: DynamicStatus; ruleset: unknown };

export interface ResourceInput {
  key: string;
  /** Ordering hint: apply this resource after `parent`. A dependency edge only — NOT managed hierarchy. */
  parent?: string;
  /** Auto-group config (opt-in; omit for a plain group). Only valid on `ct.group(...)`. See {@link DynamicInput}. */
  dynamic?: DynamicInput;
  /**
   * Managed parent groups (group→group hierarchy). Opt-in: omit to leave a group's hierarchy
   * unmanaged; `[]` means "managed with no parents". Each key must reference a group declared
   * in the same config.
   */
  parents?: string[];
  dependsOn?: string[];
  /**
   * Block `ct destroy` for this resource. Mirrored to the state entry on `apply`,
   * so protection survives the resource being dropped from config; clear it by
   * setting `false` (or removing it) and re-applying before you destroy.
   */
  preventDestroy?: boolean;
  /**
   * Group-only (#75): opt in to CT's `force` create flag so a group can be created with the same
   * name as an existing one. `POST /groups` otherwise 400s (`forbidden.duplicate.group`) whenever
   * a same-named group already exists — CT's guard is name-based, not key-based, so two
   * legitimately same-named groups (e.g. an archived and an active event signup) need this to
   * both be creatable. Create-time only: never diffed, never in state, never sent on update.
   * NEVER force by default — omit (or `false`) to keep CT's guard on.
   */
  allowDuplicateName?: boolean;
  [field: string]: unknown;
}

export interface PermissionInput {
  key: string;
  /** Numeric domainId (the escape hatch). Mutually exclusive with the logical forms below. */
  id?: number;
  /** `group_type_role`: the group type by name/key — sugars into a Ref-valued domainId (#20). */
  groupType?: string;
  /** `group_role`: the group by key (paired with `role`) — resolves to the pairing domainId (#25). */
  group?: string;
  /** `group_role`: the role name (paired with `group`) — resolves to the pairing domainId (#25). */
  role?: string;
  /** `status`: the PERSON status by name/key (`/statuses`) — sugars into a Ref-valued domainId (#90). */
  personStatus?: string;
  grants: Grant[];
}

/** Logical id-field sugar for declarations: a named string field → a Ref-valued numeric id field.
 *  `status` (→ `groupStatusId`) is deliberately NOT here (#67): ChurchTools exposes no REST catalog
 *  for group statuses — `/group/memberstatus` is a different dimension (member statuses, string
 *  ids), verified live 2026-07-10. A declared `status:` field fails fast in {@link toDesired} instead
 *  of silently resolving against the wrong dimension. `ref.status`/`RefKind: "group-status"` remain
 *  in src/resolve/refs.ts so the sugar can return if CT ever ships a real group-status endpoint. */
const ID_SUGAR: Record<string, { idField: string; make: (key: string) => Ref }> = {
  campus: { idField: "campusId", make: ref.campus },
  groupType: { idField: "groupTypeId", make: ref.groupType },
};

/** The numeric id fields a declaration may carry — each accepts a number, `null`, or a {@link Ref}. */
const ID_FIELDS = ["campusId", "groupTypeId", "groupStatusId"] as const;

/** Canonical string for a domainId (number or Ref) — keys the eval-time duplicate-target guard. */
function domainKeyPart(domainId: number | Ref): string {
  return typeof domainId === "number" ? String(domainId) : refKey(domainId);
}

/**
 * Resolve a permission declaration's domain to a numeric id (escape hatch) or a {@link Ref} (#20):
 *  - `group_type_role`: numeric `id`, or logical `groupType: "<key>"` → `ref.groupType(...)`.
 *  - `group_role`: numeric `id`, or logical `group` + `role` → `ref.groupRole(...)` (the resolver
 *    maps the pair to its pairing domainId at plan time; see #25).
 *  - `status`: numeric `id`, or logical `personStatus: "<key>"` → `ref.personStatus(...)`, resolved
 *    against the `/statuses` catalog (#90).
 * Declaring both a numeric `id` and a logical form is a conflict.
 */
/** The logical field name each domain type offers, for the "provide id or ..." error message. */
const LOGICAL_FIELD: Record<DomainType, string> = {
  group_type_role: '"groupType"',
  group_role: '"group" + "role"',
  status: '"personStatus"',
};

function resolveDomainInput(domainType: DomainType, input: PermissionInput): number | Ref {
  const hasId = input.id !== undefined;
  const bothError = (logical: string): Error =>
    new Error(
      `${domainType} "${input.key}": declare either "id" (numeric) or ${logical} (logical), not both.`,
    );
  if (domainType === "group_type_role") {
    if (input.groupType !== undefined) {
      if (hasId) throw bothError('"groupType"');
      if (typeof input.groupType !== "string" || !input.groupType)
        throw new Error(`${domainType} "${input.key}": "groupType" must be a non-empty group-type key.`);
      return ref.groupType(input.groupType);
    }
  } else if (domainType === "status") {
    if (input.personStatus !== undefined) {
      if (hasId) throw bothError('"personStatus"');
      if (typeof input.personStatus !== "string" || !input.personStatus)
        throw new Error(`${domainType} "${input.key}": "personStatus" must be a non-empty person-status key.`);
      return ref.personStatus(input.personStatus);
    }
  } else {
    // group_role
    if (input.group !== undefined || input.role !== undefined) {
      if (hasId) throw bothError('"group" + "role"');
      if (typeof input.group !== "string" || !input.group || typeof input.role !== "string" || !input.role)
        throw new Error(`${domainType} "${input.key}": "group" and "role" must both be non-empty strings.`);
      return ref.groupRole(input.group, input.role);
    }
  }
  // A person status id may legitimately be 0 ("Unbekannt"), so this guard must stay a type/finite
  // check — never a truthiness one.
  if (typeof input.id !== "number" || !Number.isFinite(input.id)) {
    throw new Error(
      `${domainType} "${input.key}": provide a numeric "id" (the domainId) or the logical ${LOGICAL_FIELD[domainType]} form.`,
    );
  }
  return input.id;
}

export interface ConfigContext {
  campus(input: ResourceInput): void;
  group(input: ResourceInput): void;
  groupType(input: ResourceInput): void;
  ageGroup(input: ResourceInput): void;
  targetGroup(input: ResourceInput): void;
  relationshipType(input: ResourceInput): void;
  /**
   * A PERSON status (`/statuses` — "0 - First", "3 - Group Active", …), #96. Declaring one makes a
   * config that grants ON a status self-sufficient across hosts: without it the status had to be
   * created by hand on every target instance before `ct.status` could resolve `personStatus: "…"`.
   * Master data, not people — a status is the enumeration, never a person or a membership.
   */
  personStatus(input: ResourceInput): void;
  /** Master-data group role (`/group/roles`). Named `roleDefinition` to avoid colliding
   *  with the `groupRole` permission function below. */
  roleDefinition(input: ResourceInput): void;
  groupRole(input: PermissionInput): void;
  groupTypeRole(input: PermissionInput): void;
  /**
   * Grants on a PERSON status (`status` domain, #90) — they apply to every person carrying that
   * status, so this is the instance-wide lever. Addressed by `personStatus: "<name/key>"` (resolved
   * against `/statuses`) or the numeric `id:` escape hatch. Note that person statuses are a different
   * dimension from group statuses (`groupStatusId`), which have no catalog at all (#67).
   */
  status(input: PermissionInput): void;
}

export type ConfigModule = (ct: ConfigContext) => void | Promise<void>;

/**
 * Eval-time desugaring of a group's `dynamic` field (#52 item B) — the engine is untouched; every
 * form collapses to the same {@link DynamicSpec}. Three authoring forms:
 *  - `dynamic: true`            → `{ status: "active", ruleset: { ref: "./rulesets/<key>.json" } }`
 *  - `dynamic: "<path>.json"`   → `{ status: "active", ruleset: { ref: "<path>" } }`
 *  - `dynamic: { status, ruleset }` (explicit) — validated as before.
 * Returns `undefined` for `undefined` (opt-in: not a dynamic group). Anything else throws.
 */
function desugarDynamic(type: string, key: string, dynamic: unknown): DynamicSpec | undefined {
  if (dynamic === undefined) return undefined;
  if (type !== "group") throw new Error(`${type} "${key}": "dynamic" is only valid on a group.`);
  if (dynamic === true) {
    return { status: "active", ruleset: { ref: conventionalRulesetRef(key) } };
  }
  if (typeof dynamic === "string") {
    if (!dynamic.endsWith(".json"))
      throw new Error(
        `group "${key}": "dynamic" as a string must be a path to a .json ruleset file ` +
          `(e.g. "./rulesets/${key}.json"), got ${JSON.stringify(dynamic)}.`,
      );
    return { status: "active", ruleset: { ref: dynamic } };
  }
  if (dynamic === null || typeof dynamic !== "object") {
    throw new Error(
      `group "${key}": "dynamic" must be true, a "<path>.json" string, or an object with { status, ruleset }.`,
    );
  }
  const d = dynamic as Record<string, unknown>;
  if (!DYNAMIC_STATUSES.includes(d.status as DynamicStatus))
    throw new Error(`group "${key}": "dynamic.status" must be one of ${DYNAMIC_STATUSES.join(", ")}.`);
  if (d.ruleset == null || typeof d.ruleset !== "object")
    throw new Error(`group "${key}": "dynamic.ruleset" must be a RuleSet object or a { ref } reference.`);
  return { status: d.status as DynamicStatus, ruleset: d.ruleset };
}

function toDesired(type: string, input: ResourceInput, location?: string): DesiredResource {
  const { key, parent, parents, dependsOn = [], preventDestroy, dynamic, allowDuplicateName, ...fields } = input;
  if (!key || typeof key !== "string") {
    throw new Error(`${type} declaration is missing a string "key".`);
  }
  // Group-only opt-in (#75) into CT's `force` create flag — see ResourceInput.allowDuplicateName.
  // Destructured out above (never reaches `fields`), so it is accepted but never diffed/managed/
  // adopted, and never trips the unknown-field warning below.
  if (allowDuplicateName !== undefined) {
    if (type !== "group") {
      throw new Error(`${type} "${key}": "allowDuplicateName" is only valid on a group.`);
    }
    if (typeof allowDuplicateName !== "boolean") {
      throw new Error(`${type} "${key}": "allowDuplicateName" must be a boolean.`);
    }
  }
  // A nullish/empty `parent` is "no parent", not an opt-in to managed-empty hierarchy.
  if (parent != null && typeof parent !== "string") {
    throw new Error(`${type} "${key}": "parent" must be a string key.`);
  }
  if (parents !== undefined && (!Array.isArray(parents) || parents.some((p) => typeof p !== "string"))) {
    throw new Error(`${type} "${key}": "parents" must be an array of string group keys.`);
  }
  // `status` (group status) has no REST catalog to resolve a name against — fail fast here rather
  // than let it fall through to ID_SUGAR (which no longer carries a "status" entry, so it would
  // otherwise silently be treated as an unrecognised field and just warn) or, worse, silently pick
  // the wrong dimension (#67: `/group/memberstatus` is member statuses, string ids — a live-verified
  // mismatch). Checked before the sugar loop so the message is specific, not the generic unknown-id
  // fallback below.
  if (fields.status !== undefined) {
    throw new Error(`${type} "${key}": "status" cannot be resolved by name — ${GROUP_STATUS_NO_CATALOG}`);
  }
  // Logical id-field sugar (#20): a named string field (`campus`/`groupType`) sugars into
  // a Ref-valued numeric id field (`campusId`/`groupTypeId`). The per-host resolver
  // turns the Ref into a real id at plan time. Declaring BOTH forms (`campus` + `campusId`) is a
  // conflict — reject it rather than silently pick one. Numeric ids still pass straight through.
  for (const [logical, { idField, make }] of Object.entries(ID_SUGAR)) {
    if (fields[logical] === undefined) continue;
    if (fields[idField] !== undefined) {
      throw new Error(
        `${type} "${key}": declare either "${logical}" (logical reference) or "${idField}" (numeric id), not both.`,
      );
    }
    const value = fields[logical];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `${type} "${key}": "${logical}" must be a non-empty string key (e.g. "${logical}: \\"mainz\\"").`,
      );
    }
    fields[idField] = make(value);
    delete fields[logical];
  }
  // After sugar, each id field must be a number (escape hatch), null (clear), or a Ref (logical).
  // A stray string (e.g. `campusId: "4"`) is rejected so a mistyped id fails at eval, not silently.
  for (const idField of ID_FIELDS) {
    const value = fields[idField];
    if (value === undefined || value === null || typeof value === "number" || isRef(value)) continue;
    // `groupStatusId` has no logical sugar field (#67 — see ID_SUGAR above), so its hint omits the
    // "use the X field" clause rather than pointing at a sugar that doesn't exist.
    const sugarName = Object.entries(ID_SUGAR).find(([, s]) => s.idField === idField)?.[0];
    const hint = sugarName ? ` (use the "${sugarName}" field, or ref.*)` : "";
    throw new Error(
      `${type} "${key}": "${idField}" must be a number (the CT id), null to clear, or a logical ` +
        `reference${hint}.`,
    );
  }
  // Warn (never throw) on a declared field the registry does not manage for this type — e.g. a
  // seeded config using campus's vestigial `shortName` instead of the real `shorty` (#51). The
  // field still passes through into `fields` unchanged (unrecognised fields have always been sent
  // as-is); this only surfaces the mistake instead of leaving it silently un-diffed forever. The
  // allowlist comes from `knownFields` (the registry's own `managedFields`), never hand-copied, so
  // it can't drift from what `adopt`/`plan`/`apply` actually read and write. The `location` prefix
  // (#52) points the author at the exact config file + line of the offending declaration.
  const allowed = knownFields(type);
  for (const fieldKey of Object.keys(fields)) {
    if (!allowed.has(fieldKey)) {
      warn(located(location, `${type} "${key}": unknown field "${fieldKey}" (ignored)`));
    }
  }
  // `dynamic` is a synthetic field for auto-groups, handled separately from the plain diffed
  // field bag. Opt-in: `undefined` means "not a dynamic group" (mirrors `parents`).
  const dynamicSpec = desugarDynamic(type, key, dynamic);
  // `parent` is an ordering hint only — a dependency edge, never a diffed/managed field
  // (its pre-hierarchy meaning; a `parent` may point at a campus). Group hierarchy is
  // managed opt-in via `parents`: `undefined` → unmanaged, `[]` → managed with no parents.
  // `parent` is already narrowed to `string | null | undefined` by the guard above; `|| undefined`
  // collapses null and "" (an empty parent is "no parent", never opt-in) to undefined.
  const parentKey = parent || undefined;
  const parentKeys = parents !== undefined ? [...new Set(parents)] : undefined;
  const edges = [...new Set([...dependsOn, ...(parentKey ? [parentKey] : []), ...(parentKeys ?? [])])];
  return {
    type,
    key,
    fields,
    parent: parentKey,
    parents: parentKeys,
    dynamic: dynamicSpec,
    dependsOn: edges,
    preventDestroy,
    allowDuplicateName,
  };
}

/**
 * Every managed hierarchy parent must reference a group declared in the same config.
 * A parent that resolves to nothing (typo, unmanaged group) or to a non-group would
 * diff forever against the managed-only actual side, so reject it up front rather than
 * emit a plan that can never converge.
 */
function validateReferences(resources: DesiredResource[]): void {
  const byKey = new Map(resources.map((r) => [r.key, r]));
  for (const r of resources) {
    for (const parentKey of r.parents ?? []) {
      const target = byKey.get(parentKey);
      if (!target) {
        throw new Error(
          `Group "${r.key}" declares hierarchy parent "${parentKey}", which is not declared in this config. ` +
            `Managed parents must reference a group by its key (omit unmanaged parents entirely).`,
        );
      }
      if (target.type !== "group") {
        throw new Error(
          `Group "${r.key}" declares hierarchy parent "${parentKey}", but "${parentKey}" is a ${target.type}, not a group.`,
        );
      }
    }
  }
}

export function createContext(): {
  ct: ConfigContext;
  resources: DesiredResource[];
  permissions: DesiredPermission[];
} {
  const resources: DesiredResource[] = [];
  const permissions: DesiredPermission[] = [];
  const seen = new Set<string>();
  // Tracks (domainType, domainId) -> declaring key, so two declarations aiming at the same
  // permission target (even under different logical keys) are rejected at eval time instead
  // of each diffing against the other's grants and proposing them as deletes forever.
  const seenDomains = new Map<string, string>();
  const define =
    (type: string) =>
    (input: ResourceInput): void => {
      // Capture the user's call site FIRST (top of the wrapper = the frame is the author's
      // `ct.<type>({...})` call), then locate any eval-time error or unknown-field warning it raises (#52).
      const location = captureCallSite();
      try {
        const resource = toDesired(type, input, location);
        if (seen.has(resource.key)) {
          throw new Error(`Duplicate logical key "${resource.key}" in config.`);
        }
        seen.add(resource.key);
        resources.push(resource);
      } catch (err) {
        throw relocate(err, location);
      }
    };
  const definePermissionInner = (domainType: DomainType, input: PermissionInput): void => {
    if (typeof input.key !== "string" || !input.key)
      throw new Error(`${domainType} declaration missing a string "key".`);
    const domainId = resolveDomainInput(domainType, input);
    if (!Array.isArray(input.grants))
      throw new Error(`${domainType} "${input.key}": "grants" must be an array.`);
    // Normalise each grant's scope at eval time: object sugar (`{ campus: "koblenz" }`) becomes the
    // equivalent Ref, bare strings/numbers pass through (#98). Same sugar→Ref move `ID_SUGAR` makes
    // for declaration id fields, and it produces a NEW array — the author's input is never mutated.
    const grants: Grant[] = input.grants.map((g) => {
      const right = typeof g === "string" ? g : g?.right;
      if (typeof right !== "string" || !right.includes(":"))
        throw new Error(
          `${domainType} "${input.key}": each grant must be a "module:right" string or { right, scope }.`,
        );
      if (typeof g === "string") return g;
      if (!Array.isArray(g.scope))
        throw new Error(
          `${domainType} "${input.key}": scoped grant needs "scope": (string | number | { campus | groupType | group })[].`,
        );
      const where = `${domainType} "${input.key}" grant "${right}"`;
      return { right, scope: g.scope.map((s) => normalizeScopeEntry(s, where)) };
    });
    if (seen.has(input.key)) throw new Error(`Duplicate logical key "${input.key}" in config.`);
    seen.add(input.key);
    // Duplicate-target guard, keyed by the canonical domain string (numeric id or Ref key). This
    // catches obvious eval-time collisions early; the authoritative check runs post-resolution in
    // buildPermissionPlan (two different refs, or a ref and a number, can resolve to the same id).
    const domainKey = `${domainType}:${domainKeyPart(domainId)}`;
    const existingKey = seenDomains.get(domainKey);
    if (existingKey) {
      const label = typeof domainId === "number" ? `#${domainId}` : refKey(domainId);
      throw new Error(
        `Duplicate permission target: ${domainType} ${label} is declared by both "${existingKey}" and "${input.key}". Merge their grants into one declaration.`,
      );
    }
    seenDomains.set(domainKey, input.key);
    permissions.push({ key: input.key, domainType, domainId, grants });
  };
  const definePermission =
    (domainType: DomainType) =>
    (input: PermissionInput): void => {
      const location = captureCallSite();
      try {
        definePermissionInner(domainType, input);
      } catch (err) {
        throw relocate(err, location);
      }
    };
  // Every type emitted here MUST have an apply tier in engine/graph.ts TYPE_TIER
  // (locked by tests/context.test.ts), else computePlan rejects it at plan time.
  const ct: ConfigContext = {
    campus: define("campus"),
    group: define("group"),
    groupType: define("group-type"),
    ageGroup: define("age-group"),
    targetGroup: define("target-group"),
    relationshipType: define("relationship-type"),
    personStatus: define("person-status"),
    roleDefinition: define("group-role"),
    groupRole: definePermission("group_role"),
    groupTypeRole: definePermission("group_type_role"),
    status: definePermission("status"),
  };
  return { ct, resources, permissions };
}

/** Run a loaded config module against a fresh context and collect its resources + permissions. */
export async function evaluateConfig(
  mod: ConfigModule,
): Promise<{ resources: DesiredResource[]; permissions: DesiredPermission[] }> {
  const { ct, resources, permissions } = createContext();
  await mod(ct);
  validateReferences(resources);
  return { resources, permissions };
}
