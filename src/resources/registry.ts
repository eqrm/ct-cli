/**
 * Registry of adoptable ChurchTools resource types.
 *
 * Each entry knows how to fetch one resource by id, derive a stable logical key,
 * snapshot the fields we manage, and render a config snippet (the TS-as-code
 * form the Phase 3 engine will consume). Paths come from the Phase 0 coverage
 * matrix (docs/api-coverage.md). Adding a type = adding an entry here.
 */

export interface AdoptableResource {
  /** Collection path: `POST` here creates. */
  collectionPath: string;
  /** GET/PUT/PATCH/DELETE path for a single resource by id. */
  itemPath: (id: number) => string;
  /** Update verb: `group` is PATCH; every other type is PUT. */
  updateMethod: "PUT" | "PATCH";
  /**
   * Apply tier: lower applies first, delete runs highest first (see engine/graph.ts). Owned here so
   * a new resource type declares its ordering in the same place as its paths — `engine/graph.ts`
   * derives `TYPE_TIER` from these entries instead of maintaining a parallel (drift-prone) table.
   */
  tier: number;
  /** Stable logical key derived from the fetched resource. */
  deriveKey: (resource: Record<string, unknown>) => string;
  /** The subset of fields we manage — the desired-state baseline. */
  managedFields: (resource: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Deterministic values for fields CT *requires* at CREATE but the tool does not manage for
   * diffing (#73). Called with the already-built create body (the declared managed fields, which
   * carry `name`) and returns extra fields merged UNDER it (a declared value always wins) into the
   * POST body ONLY — never into the state snapshot. So these fields stay unmanaged: a later plan
   * neither diffs nor reverts them, and declared-fields semantics are unchanged (no state migration).
   * A field still missing after this surfaces as CT's own HTTP 400 (#71), never a silent omission.
   * Omit the hook entirely for types whose managed fields already satisfy the create contract.
   */
  createDefaults?: (body: Record<string, unknown>) => Record<string, unknown>;
  /**
   * DSL function name `configSnippet` emits for this type. Defaults to the camelCase of
   * the type name. Set it when the natural camelCase collides with another DSL surface
   * (e.g. `group-role` → `roleDefinition`, because `groupRole` is the permission function).
   */
  dslName?: string;
}

/** Build a full spec, deriving `itemPath` from the collection path so each entry names its path once. */
function define(spec: Omit<AdoptableResource, "itemPath">): AdoptableResource {
  return { ...spec, itemPath: (id: number) => `${spec.collectionPath}/${id}` };
}

/**
 * kebab/underscore slug: "Kids Leitung" → "kids_leitung", "Zürich" → "zurich".
 * NFKD splits accented letters into base + combining mark; we drop the marks so
 * German names (ü/ö/ä/…) slug to their base letters rather than gaining a `_`.
 */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function str(resource: Record<string, unknown>, key: string): string {
  const value = resource[key];
  return typeof value === "string" ? value : "";
}

/**
 * First `max` *code points* (not UTF-16 code units) of `value` — CT's create validators cap several
 * name/shorty fields. Plain `String#slice` operates on UTF-16 code units, which can split an astral
 * character's surrogate pair at the cutoff (e.g. `("ABCDEFGHI" + "😀").slice(0, 10)` ends in a lone
 * unpaired `\uD83D`); `Array.from` iterates strings by code point, so the cut always lands on a whole
 * character and the result can never contain a dangling surrogate.
 */
function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

/**
 * `truncate(value, max)`, then padded up to `min` characters by repeating `value` (or `"x"` if
 * `value` is empty) — CT's create validators give several name/shorty-style fields *both* a maximum
 * and a minimum length, and a name shorter than `min` (e.g. a 1-char group-type name against
 * namePlural's 2-char floor) would otherwise merely truncate to itself and stay under the minimum.
 * The padding is deliberately dumb (repeat, don't pluralize) — a name this short is pathological;
 * the goal is a valid create body, not linguistics.
 */
function truncatePadded(value: string, max: number, min: number): string {
  let padded = value;
  while (Array.from(padded).length < min) {
    // (code-point count, matching truncate() — a single-astral-char name must still pad)
    padded += value.length > 0 ? value : "x";
  }
  return truncate(padded, max);
}

/** Read a field, preferring a nested `information` object but falling back to the top level. */
export function fromInformation(resource: Record<string, unknown>, key: string): unknown {
  const information = (resource.information as Record<string, unknown> | undefined) ?? {};
  return information[key] ?? resource[key];
}

export const RESOURCES: Record<string, AdoptableResource> = {
  campus: define({
    collectionPath: "/campuses",
    updateMethod: "PUT",
    tier: 0,
    // CT's campus short name is `shorty` (1–10 chars, required on create) — verified
    // live. `shortName` is a vestigial, usually-null sibling; do not use it for writes.
    deriveKey: (r) => slug(str(r, "shorty") || str(r, "name")),
    managedFields: (r) => ({ name: r.name, shorty: r.shorty }),
  }),
  group: define({
    collectionPath: "/groups",
    updateMethod: "PATCH",
    tier: 1,
    deriveKey: (r) => slug(str(r, "name")),
    // Campus lives on the live group at `information.campusId` (same nesting as groupTypeId /
    // groupStatusId), and PATCH accepts it as a top-level `campusId` — so it is read via
    // `fromInformation` and written the same field-agnostic way the executor writes every field.
    // Numeric escape hatch only: a *logical* `campus: "key"` reference is #20's resolver, not this.
    // Normalise an unset campus to `null` (never `undefined`) so the actual side is deterministic —
    // an assign/change/clear all diff against a concrete `null`, and campus id `0` (Mainz) survives.
    managedFields: (r) => ({
      name: r.name,
      groupTypeId: fromInformation(r, "groupTypeId"),
      groupStatusId: fromInformation(r, "groupStatusId"),
      campusId: fromInformation(r, "campusId") ?? null,
    }),
  }),
  "group-type": define({
    collectionPath: "/group/grouptypes",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated }),
    // POST /group/grouptypes rejects a body carrying only name/nameTranslated: CT requires the fields
    // below (validated live on CT 3.134.1, #73, and against the OpenAPI POST schema). They are unmanaged
    // (create-only) and derived deterministically from the declared `name`. If a user declares one of
    // them the existing unknown-field warning fires (it is not in `managedFields`) — we keep them
    // create-default-only rather than growing `managedFields`, which would broaden every group-type's
    // actual-reads and adopt output and grow state on the next apply (a de-facto migration #73 forbids).
    createDefaults: (r) => {
      const name = str(r, "name");
      return {
        // required, 2–30 chars: no plural known at create → mirror name, capped, and padded up to
        // the 2-char floor (a 1-char name would otherwise truncate to itself and stay under it).
        namePlural: truncatePadded(name, 30, 2),
        // required, 1–10 chars: first ≤10 chars of the name, padded up to the 1-char floor — the
        // floor only bites if `name` itself is empty (`str` defaults a missing/non-string name to
        // "", which `truncatePadded` falls back to `"x"` for rather than emitting an empty shorty).
        shorty: truncatePadded(name, 10, 1),
        color: "default", // required enum: the theme-neutral member of CT's color palette
        permissionDepth: 1, // required int: permissions reach the group's own members only (least-privilege; the value a plain live type carries)
        isLeaderNecessary: false, // don't force a leader onto a freshly created type
        availableForNewPerson: false, // keep the type out of self-service / new-person flows by default
        sortKey: 0, // append-neutral ordering (matches a live "Dienst" row's sortKey 0)
        postsEnabled: false, // don't enable the group wall / posts feature by default
      };
    },
  }),
  "age-group": define({
    collectionPath: "/group/agegroups",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, sortKey: r.sortKey }),
  }),
  "target-group": define({
    collectionPath: "/group/targetgroups",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, sortKey: r.sortKey }),
  }),
  "relationship-type": define({
    collectionPath: "/person/relationshiptypes",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    // CT names the two ends degreeNameA/degreeNameB (verified live) — not degreeForward/Reverse.
    managedFields: (r) => ({
      name: r.name,
      nameTranslated: r.nameTranslated,
      degreeNameA: r.degreeNameA,
      degreeNameB: r.degreeNameB,
    }),
  }),
  /**
   * PERSON statuses (`/statuses` — "0 - First", "3 - Group Active", …), the domain of a `ct.status`
   * permission declaration (#90). Adoptable so a config that grants ON a status is self-sufficient
   * across hosts (#96): before this entry the status itself could only be created by hand on every
   * target instance, which made the whole `status` domain only half-portable — the grant was
   * declarable, the thing it hangs off was not.
   *
   * Not a people surface: a status is master data (the enumeration), never a person or a membership.
   * `assertNotPeople` still guards every write; `/statuses` does not match its denylist by design.
   *
   * The managed set is the WHOLE required PUT contract, deliberately — and this is the one managed
   * type where a minimal field set would be actively wrong. Live-probed against the instance's own
   * OpenAPI spec (eqrm prod, CT 3.135.2, 2026-08-13):
   *
   *   POST /statuses       required: name, shorty, isMember
   *   PUT  /statuses/{id}  required: name, shorty, isMember, isSearchable, sortKey, securityLevelId
   *
   * That PUT is a FULL REPLACE, and the executor sends the declared field bag as the update body —
   * so managing a subset would both 400 (missing required fields) and, if it didn't, blank the
   * fields left out. Every other managed type's PUT has no required fields at all (campus,
   * age-group, target-group, group-role, group-type — same probe), which is why they can manage a
   * narrow set; `/statuses` cannot. Hence: no `createDefaults` here. All six are declared, adopted
   * and diffed, so `ct adopt person-status <id>` emits a config that is valid for both verbs.
   * A hand-authored declaration that omits one gets CT's own HTTP 400 (#71), never a silent blank.
   */
  "person-status": define({
    collectionPath: "/statuses",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({
      name: r.name,
      shorty: r.shorty,
      isMember: r.isMember,
      isSearchable: r.isSearchable,
      sortKey: r.sortKey,
      securityLevelId: r.securityLevelId,
    }),
  }),
  "group-role": define({
    collectionPath: "/group/roles",
    updateMethod: "PUT",
    tier: 3,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, groupTypeId: r.groupTypeId }),
    // POST /group/roles requires `shorty` (1–10 chars, non-nullable in CT's OpenAPI POST schema) which
    // the tool does not manage (#73 audit). Sent at CREATE only, derived from the declared `name`; not
    // diffed afterward. (`type`/`isLeader`/`sortKey` are all optional/nullable — no default needed.)
    // Padded up to the 1-char floor for the same empty-name edge case as group-type's shorty above.
    createDefaults: (r) => ({ shorty: truncatePadded(str(r, "name"), 10, 1) }),
    // `groupRole` is taken by the permissions DSL (`ct.groupRole` = definePermission("group_role")),
    // so the master-data role resource declares under a distinct name.
    dslName: "roleDefinition",
  }),
};

export function resourceType(type: string): AdoptableResource {
  const entry = RESOURCES[type];
  if (!entry) {
    const known = Object.keys(RESOURCES).join(", ");
    throw new Error(`Unknown resource type "${type}". Adoptable types: ${known}.`);
  }
  return entry;
}

/**
 * The field names a declaration of `type` may manage — derived from the registry's own
 * `managedFields`, not hand-copied, so this can never drift from what `adopt`/`plan`/`apply`
 * actually read and write. `managedFields({})` still returns every key it would on a real
 * resource: each key is written as an object-literal property (`{ name: r.name, ... }`), so it
 * is present with value `undefined` even when the source object is empty — JS object literals
 * always create the property, independent of the expression's runtime value.
 */
export function knownFields(type: string): Set<string> {
  return new Set(Object.keys(resourceType(type).managedFields({})));
}

/** Camel-case a hyphenated type name: `group-type` → `groupType`. */
function camelCase(type: string): string {
  return type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The conventional ruleset-file path for a dynamic group's `dynamic: true` sugar (#52): the same
 * `rulesets/<key>.json` layout `ct adopt group --with-dynamic` writes to. Owned here (a low-level
 * module) so both the config-DSL desugarer (context.ts) and the adopt emitter can share it without
 * a registry↔context import cycle.
 */
export function conventionalRulesetRef(key: string): string {
  return `./rulesets/${key}.json`;
}

/** Prettier's `printWidth` (see .prettierrc.json) — the emitter mirrors it for array wrapping. */
const PRINT_WIDTH = 110;

/** Options for {@link configSnippet}. `todos` names fields to flag with a trailing `// TODO` comment. */
export interface SnippetOptions {
  /** Field keys that could not be reverse-resolved to logical sugar — annotated inline (#52 item A). */
  todos?: Set<string>;
}

/**
 * Render a config entry as an idiomatic, prettier-compatible TS-as-code call (#52 item A):
 * multi-line, 2-space indent, trailing commas, one field per line. The function name comes from the
 * registry entry's `dslName` (default: camelCase of the type), so the emitted snippet always names an
 * actual `ConfigContext` function — never a colliding one. `fields` should already be reverse-sugared
 * (numeric ids → logical `campus`/`groupType`/`status` keys); anything left numeric that the caller
 * couldn't resolve is passed in `opts.todos` to earn a `// TODO: no logical match` marker. A `dynamic`
 * field is collapsed to its shortest sugar form (`true` / `"<path>"`) when it matches the convention.
 */
export function configSnippet(
  type: string,
  key: string,
  fields: Record<string, unknown>,
  opts: SnippetOptions = {},
): string {
  const fn = RESOURCES[type]?.dslName ?? camelCase(type);
  const prepared: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    prepared[k] = k === "dynamic" ? sugarDynamicValue(key, v) : v;
  }
  return `${fn}(${renderObject({ key, ...prepared }, "", opts.todos)});`;
}

/**
 * Collapse an emitted `dynamic` value to its shortest DSL sugar (#52 item B round-trip): an
 * `active` status whose ruleset is exactly `{ ref }` becomes `true` (when the ref matches the
 * `./rulesets/<key>.json` convention) or the bare `"<path>"` string. Any other shape (non-active
 * status, an inline ruleset object) is emitted verbatim as the explicit object.
 */
function sugarDynamicValue(key: string, dynamic: unknown): unknown {
  if (dynamic === null || typeof dynamic !== "object") return dynamic;
  const d = dynamic as Record<string, unknown>;
  const ruleset = d.ruleset;
  if (d.status !== "active" || ruleset === null || typeof ruleset !== "object") return dynamic;
  const rs = ruleset as Record<string, unknown>;
  if (typeof rs.ref !== "string" || Object.keys(rs).length !== 1) return dynamic;
  return rs.ref === conventionalRulesetRef(key) ? true : rs.ref;
}

/**
 * Render a plain object as multi-line TS. null/undefined-valued fields are OMITTED, not emitted:
 * pasting `campusId: null` would actively MANAGE "no campus" (planning a later UI-assigned campus
 * back to null), whereas omission leaves the field unmanaged — the safer default for a freshly
 * adopted resource. `todos` (top-level only) appends a `// TODO` marker after the trailing comma.
 */
function renderObject(obj: Record<string, unknown>, indent: string, todos?: Set<string>): string {
  const inner = `${indent}  `;
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, v]) => {
    const keyStr = isIdentifier(k) ? k : JSON.stringify(k);
    const todo = todos?.has(k) ? " // TODO: no logical match" : "";
    return `${inner}${keyStr}: ${renderValue(v, inner)},${todo}`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/** Render any JSON value as prettier-style TS, indenting nested objects/arrays under `indent`. */
function renderValue(value: unknown, indent: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Match prettier: a short all-primitive array stays on one line; anything longer or with a
    // nested object/array breaks one element per line. (Adopt output never actually nests arrays —
    // rulesets are emitted as a `{ ref }` — so this only keeps the emitter faithful in general.)
    const allPrimitive = value.every((v) => v === null || typeof v !== "object");
    const inline = `[${value.map((v) => renderValue(v, indent)).join(", ")}]`;
    if (allPrimitive && indent.length + inline.length <= PRINT_WIDTH) return inline;
    const inner = `${indent}  `;
    const items = value.map((v) => `${inner}${renderValue(v, inner)},`).join("\n");
    return `[\n${items}\n${indent}]`;
  }
  if (typeof value === "object") return renderObject(value as Record<string, unknown>, indent);
  return JSON.stringify(value);
}

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}
