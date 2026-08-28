/**
 * GROUP MEMBER FIELDS (#135) — the field DEFINITIONS a group asks its members for.
 *
 * A group member field has a ChurchTools id, but it belongs to exactly ONE group and is not
 * globally reusable: two groups declaring a field with the same local name are two independent
 * resources with two different ids. Its portable identity is therefore SCOPED by the managed group
 * — `ojbp_2026_27_praktikum_1::wahl` — and a host-specific field id never appears in authored
 * config or in an adopted blueprint. That is the whole point: a blueprint applied twice (25/26 and
 * 26/27) must mint fresh fields per group with no id from the other year participating.
 *
 * Not people. These are DEFINITIONS ("what does this group ask its members?"), never a value
 * carried by a person, never a membership, never a participant — exactly the same boundary group
 * data fields sit on (see docs/handbuch/field-definitions.md). `assertNotPeople` still guards every
 * write path here; `/groups/{id}/memberfields` does not match its denylist by design.
 *
 * Distinct from the group CUSTOM fields of #48/#60, which live on `/dbfields` with
 * `fieldCategory.table == "cdb_gruppe"` and describe the GROUP record itself.
 *
 * ChurchTools API surface (as declared on #135 against the generated OpenAPI clients):
 *   GET    /groups/{groupId}/memberfields
 *   POST   /groups/{groupId}/memberfields/group
 *   PATCH  /groups/{groupId}/memberfields/group/{groupMemberFieldId}   (PUT where PATCH is absent)
 *   DELETE /groups/{groupId}/memberfields/group/{groupMemberFieldId}
 */

import { slug } from "../resources/registry.js";
import type { State } from "../state/state.js";

/**
 * The synthetic pseudo-field prefix. One declared member field folds into ONE pseudo-field on its
 * owning group (`memberField:wahl`), so the plan diffs — and renders — per field rather than as one
 * opaque array blob, and so a field dropped from config simply has no desired key and can therefore
 * never be diffed into a delete (`diffFields` walks the DESIRED side only).
 */
export const MEMBER_FIELD_PREFIX = "memberField:";

/** The pseudo-field name carrying the declaration of one local member-field key. */
export function memberFieldPseudo(localKey: string): string {
  return `${MEMBER_FIELD_PREFIX}${localKey}`;
}

/** The local member-field key inside a pseudo-field name, or `undefined` if it is not one. */
export function memberFieldLocalKey(field: string): string | undefined {
  return field.startsWith(MEMBER_FIELD_PREFIX) ? field.slice(MEMBER_FIELD_PREFIX.length) : undefined;
}

/** The portable, group-scoped identity of a member field: `<groupKey>::<localKey>` (#135). */
export function memberFieldIdentity(groupKey: string, localKey: string): string {
  return `${groupKey}::${localKey}`;
}

/**
 * Split a `<groupKey>::<localKey>` identity. Returns `undefined` unless both halves are non-empty,
 * so a caller (e.g. `ct destroy --member-field`) can reject a malformed target with its own message.
 */
export function parseMemberFieldIdentity(raw: string): { group: string; field: string } | undefined {
  const at = raw.indexOf("::");
  if (at <= 0) return undefined;
  const group = raw.slice(0, at).trim();
  const field = raw.slice(at + 2).trim();
  if (!group || !field) return undefined;
  return { group, field };
}

/**
 * The properties this tool MANAGES on a member field — the ones #135 verified as readable AND
 * writable, minus the two that must never be managed:
 *
 *  - `id` — host-specific, and the entire portability guarantee is that it never appears in config.
 *  - `referenceName` — exact ChurchTools identity, kept separately on {@link MemberFieldSpec}.
 *    It is compared exactly and sent on create, but never PATCHed: changing it requires an explicit
 *    replacement because dynamic-group rulesets address this exact string.
 *
 * A declared property outside this list still passes through to ChurchTools untouched (the escape
 * hatch, mirroring the registry's unknown-field behaviour) — it only earns a warning.
 */
export const MEMBER_FIELD_PROPS = [
  "name",
  "fieldTypeCode",
  "defaultValue",
  "options",
  "nameInSignupForm",
  "note",
  "noteInSignupForm",
  "requiredInRegistrationForm",
  "useInRegistrationForm",
  "securityLevel",
  "sortKey",
] as const;

const MANAGED_PROPS = new Set<string>(MEMBER_FIELD_PROPS);

/** Properties a declaration may never carry — see {@link MEMBER_FIELD_PROPS} for why. */
export const MEMBER_FIELD_FORBIDDEN_PROPS = ["id", "groupMemberFieldId", "groupId"] as const;

export function isManagedMemberFieldProp(name: string): boolean {
  return MANAGED_PROPS.has(name);
}

/** One declared member field: its local key plus the property bag that gets diffed and written. */
export interface MemberFieldSpec {
  /** Local key, unique within the owning group. Half of the portable `<group>::<key>` identity. */
  key: string;
  /** Exact identity used by ChurchTools and by ruleset `groupMemberFields` assignments (#158). */
  referenceName: string;
  /** The declared mutable properties — never an id, never `referenceName`. Diffed as one unit. */
  props: Record<string, unknown>;
}

/** A row as ChurchTools returns it from `GET /groups/{groupId}/memberfields`. */
export type MemberFieldRow = Record<string, unknown>;

/** Row keys that have, across CT versions, carried the field's scope/source. */
const SCOPE_KEYS = ["type", "fieldCategory", "source", "fieldSource"] as const;

/**
 * Values that positively mark a row as sourced OUTSIDE the group — the only thing that excludes a
 * row. Kept as an explicit vocabulary so an unfamiliar value (a field type, a new CT spelling)
 * falls through to "group-scoped" rather than silently emptying the list.
 */
const NON_GROUP_SCOPES = new Set([
  "person",
  "persons",
  "personmasterdata",
  "master",
  "masterdata",
  "db",
  "dbfield",
  "grouptype",
  "group_type",
  "grouptypedefault",
  "global",
  "system",
]);

/**
 * Is this live row a GROUP-SCOPED custom member field — i.e. one of the rows the
 * `/memberfields/group` write endpoints own?
 *
 * `GET /groups/{groupId}/memberfields` answers with every field the group's signup/member form
 * shows, which on a real instance mixes group-scoped custom fields with rows sourced elsewhere
 * (person master data, group-type defaults). Only the first kind can be created or updated through
 * `/memberfields/group`, so only the first kind is adoptable or manageable here.
 *
 * The discriminator is read leniently, because CT has spelled this differently across versions —
 * and because the candidate keys are not all unambiguously about SCOPE. `type` in particular may
 * carry a field TYPE (`"text"`, `"date"`) rather than a source on some versions; the managed
 * property for that is `fieldTypeCode`, but a live row is not obliged to agree. So the row is
 * classified by VALUE, not by which key happened to appear first:
 *
 *  - any candidate saying `"group"` → group-scoped;
 *  - otherwise, a candidate naming a known non-group SOURCE ({@link NON_GROUP_SCOPES}) → excluded;
 *  - otherwise (no discriminator, or an unrecognised value like a field type) → group-scoped.
 *
 * The last rule is the important one. The endpoint is the group's own, so "we cannot tell" errs
 * towards showing the field rather than silently hiding one an author needs — and an unrecognised
 * value must never be read as "not a group field", because that would make `groupScopedRows` empty
 * for every group: adopt would emit nothing, and apply would find no match and POST a fresh field
 * on every single run, duplicating the group's member fields. Over-inclusion fails loudly instead
 * (a write against a row `/memberfields/group` does not own is rejected by CT).
 *
 * Worth pinning against a live response when one is at hand; until then this errs on the side of
 * the loud failure.
 */
export function isGroupScopedMemberField(row: MemberFieldRow): boolean {
  let sawNonGroup = false;
  for (const name of SCOPE_KEYS) {
    const value = row[name];
    if (typeof value !== "string") continue;
    const normalized = value.toLowerCase().replace(/[\s-]/g, "");
    if (normalized === "group") return true;
    if (NON_GROUP_SCOPES.has(normalized)) sawNonGroup = true;
  }
  return !sawNonGroup;
}

/**
 * The key a member-field id is stored under in the owning group's `memberFields` state map.
 *
 * SLUGGED, because every other comparison in this feature is: `matchesLocalKey` slugs both sides,
 * so a declaration keyed `wahl` and a `ref.groupMemberField("g", "Wahl")` are deliberately the same
 * field. If the state map were keyed by the raw string instead, the write (`wahl`) and the pending
 * read (`Wahl`) would miss each other and apply would hard-fail mid-run — after the group and the
 * field had already been created. One canonical spelling, used by writer and reader alike (#135).
 */
export function memberFieldStateKey(localKey: string): string {
  return slug(localKey);
}

/** Resolve a field id from the current owner-local state map. */
export function knownMemberFieldId(state: State, groupKey: string, localKey: string): number | undefined {
  const group = state.resources[groupKey];
  return group?.memberFields?.[memberFieldStateKey(localKey)];
}

/**
 * Prefer a state-bound id; otherwise match ChurchTools' identity-bearing `referenceName` EXACTLY.
 * A name fallback is permitted only for old/UI rows that genuinely carry no referenceName. Once CT
 * supplies one, punctuation and case are data: `foo-bar` and `foo_bar` are different identities.
 *
 * `referenceName === undefined` means the caller has NO declared exact identity to compare against —
 * a ref into a group that is adopted but does not declare `memberFields`, or a `ct destroy
 * --member-field` target. Those callers keep the pre-#158 local-key affinity ({@link
 * matchesLocalKey}), because there is no config to state the exact string and demanding one would
 * turn a working reference into a hard error.
 */
export function matchingMemberFieldRows(
  rows: MemberFieldRow[],
  localKey: string,
  referenceName: string | undefined,
  knownId?: number,
): MemberFieldRow[] {
  if (knownId !== undefined) {
    // State-bound identity is authoritative. Falling back to a name when the known id is absent
    // can select a different field; falling all the way through to POST can duplicate a live field
    // when a response variant was parsed incompletely.
    return rows.filter((row) => memberFieldRowId(row) === knownId);
  }
  if (referenceName === undefined) return rows.filter((row) => matchesLocalKey(row, localKey));
  return rows.filter((row) => {
    const liveReference = memberFieldReferenceName(row);
    if (liveReference !== undefined) return liveReference === referenceName;
    const name = row.name;
    return typeof name === "string" && slug(name) === slug(localKey);
  });
}

/**
 * The live exact identity that CONTRADICTS `referenceName`, or `undefined` when nothing does.
 *
 * A row carrying no `referenceName` at all contradicts nothing: it is the legacy/UI row the name
 * fallback in {@link matchingMemberFieldRows} exists for, and since ct never PATCHes
 * `referenceName` there is no rename to refuse. Treating "missing" as "different" would make every
 * such row unreconcilable — no update, no create, just a permanent error.
 */
export function conflictingReferenceName(row: MemberFieldRow, referenceName: string): string | undefined {
  const live = memberFieldReferenceName(row);
  return live !== undefined && live !== referenceName ? live : undefined;
}

/**
 * The exact identity-bearing ChurchTools reference name, when the row carries one.
 */
export function memberFieldReferenceName(row: MemberFieldRow): string | undefined {
  const reference = row.referenceName;
  return typeof reference === "string" && reference.length > 0 ? reference : undefined;
}

/**
 * A stable local key for adoption/delete-candidate display. This is deliberately NOT API identity:
 * it remains a ct-cli slug, while {@link memberFieldReferenceName} preserves the exact CT string.
 */
export function localKeyOf(row: MemberFieldRow): string {
  const reference = memberFieldReferenceName(row);
  if (reference !== undefined) return slug(reference);
  const name = row.name;
  return typeof name === "string" ? slug(name) : "";
}

/**
 * Legacy/local-key affinity used only for diagnostics and destructive target lookup. Never use it
 * to establish API identity for plan/apply; use {@link matchingMemberFieldRows} there.
 */
export function matchesLocalKey(row: MemberFieldRow, localKey: string): boolean {
  const wanted = slug(localKey);
  if (localKeyOf(row) === wanted) return true;
  const name = row.name;
  return typeof name === "string" && slug(name) === wanted;
}

function numericMemberFieldId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * The numeric ChurchTools id of a live row or create response. CT versions differ here: ids may be
 * JSON numbers or decimal strings, and create responses may wrap the row in `data` or
 * `groupMemberField`.
 */
export function memberFieldId(raw: unknown): number | undefined {
  const direct = numericMemberFieldId(raw);
  if (direct !== undefined) return direct;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as MemberFieldRow;
  const fieldId = numericMemberFieldId(row.id ?? row.groupMemberFieldId);
  if (fieldId !== undefined) return fieldId;
  return memberFieldId(row.data ?? row.groupMemberField);
}

/** The numeric ChurchTools id of a live row, or `undefined` when it carries none. */
export function memberFieldRowId(row: MemberFieldRow): number | undefined {
  return memberFieldId(row);
}

/**
 * The ACTUAL side of one member field's diff: the live row narrowed to exactly the properties the
 * declaration names.
 *
 * Narrowing is what makes a clean apply round-trip to a no-op. The pseudo-field's value is one
 * object compared with `deepEqual`, so an unmanaged sibling property CT happens to return (a
 * server-defaulted `sortKey`, a `nameTranslated`, an echoed `groupId`) would otherwise make the two
 * sides structurally unequal forever — a plan that proposes the same update on every run. Declared
 * keys only, one level deeper than `diffFields` does at the resource level, with the same meaning:
 * what the config does not mention is not managed.
 */
export function actualMemberFieldProps(
  row: MemberFieldRow,
  declaredProps: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, desired] of Object.entries(declaredProps)) {
    const actual = row[name];
    // CT may answer `defaultValue` as the chosen OPTION'S ID where the declaration names the
    // option by name. Both sides must actually carry a value before they are compared as strings:
    // an absent `defaultValue` next to an id-less option would otherwise match `"undefined"` to
    // `"undefined"`, report the field converged forever, and never write the declared default.
    if (name === "defaultValue" && actual !== desired && actual != null && Array.isArray(row.options)) {
      const option = row.options.find(
        (candidate) =>
          candidate !== null &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as Record<string, unknown>).id != null &&
          String((candidate as Record<string, unknown>).id) === String(actual),
      ) as Record<string, unknown> | undefined;
      if (option?.name === desired) {
        out[name] = desired;
        continue;
      }
    }
    out[name] = projectDeclaredShape(actual, desired);
  }
  return out;
}

/**
 * Project server-enriched nested values onto the shape authored in config. CT assigns ids to
 * select options, while a portable declaration commonly contains only `{ name }`; those ids are
 * transport metadata, not drift. Array length and order remain visible, and every key the config
 * does declare is still compared.
 */
function projectDeclaredShape(actual: unknown, desired: unknown): unknown {
  if (Array.isArray(actual) && Array.isArray(desired)) {
    return actual.map((value, index) =>
      index < desired.length ? projectDeclaredShape(value, desired[index]) : value,
    );
  }
  if (
    actual !== null &&
    desired !== null &&
    typeof actual === "object" &&
    typeof desired === "object" &&
    !Array.isArray(actual) &&
    !Array.isArray(desired)
  ) {
    const actualObject = actual as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(desired as Record<string, unknown>).map(([key, value]) => [
        key,
        projectDeclaredShape(actualObject[key], value),
      ]),
    );
  }
  return actual;
}

/** `GET`/`POST` path for a group's group-scoped member fields. */
export function memberFieldsReadPath(groupId: number): string {
  return `/groups/${groupId}/memberfields`;
}

export function memberFieldsCreatePath(groupId: number): string {
  return `/groups/${groupId}/memberfields/group`;
}

export function memberFieldItemPath(groupId: number, fieldId: number): string {
  return `/groups/${groupId}/memberfields/group/${fieldId}`;
}

/** Does this nested object carry a member field's own identity — i.e. is it a wrapped definition? */
function looksLikeMemberFieldDefinition(nested: MemberFieldRow): boolean {
  return (
    typeof nested.name === "string" ||
    typeof nested.referenceName === "string" ||
    memberFieldId(nested) !== undefined
  );
}

function memberFieldRows(raw: unknown): MemberFieldRow[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((candidate): MemberFieldRow[] => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const wrapper = candidate as MemberFieldRow;
      const nested = wrapper.field;
      if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return [wrapper];
      const inner = nested as MemberFieldRow;
      // Only a nested object that actually looks like a DEFINITION is a wrapper. A plain row that
      // merely carries an unrelated `field` sub-object keeps its own shape rather than being
      // replaced by it.
      if (!looksLikeMemberFieldDefinition(inner)) return [wrapper];
      // Some CT versions wrap every definition as `{ type: "group", field: { ...definition } }`.
      // Merge wrapper-under-nested rather than dropping the wrapper: the inner definition wins on
      // every key it names, while a scope discriminator — or an id — that the variant parked on the
      // wrapper still reaches every identity, diff, adoption, and write-path helper. Losing a
      // wrapper-held id would make adopt skip the group and apply refuse the update.
      const outer = { ...wrapper };
      delete outer.field;
      return [{ ...outer, ...inner, type: wrapper.type ?? inner.type }];
    });
  }
  if (raw === null || typeof raw !== "object") return [];
  const object = raw as Record<string, unknown>;
  // Live CT versions have used all four envelopes. Treating an unfamiliar wrapper as an empty list
  // could otherwise turn a readable field into a replacement create.
  for (const key of ["group", "data", "memberFields", "groupMemberFields"]) {
    if (object[key] === undefined) continue;
    const rows = memberFieldRows(object[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

function explicitlyScopedGroupRows(raw: unknown): MemberFieldRow[] | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const object = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(object, "group")) {
    return memberFieldRows(object.group);
  }
  for (const key of ["data", "memberFields", "groupMemberFields"]) {
    const nested = explicitlyScopedGroupRows(object[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Normalise CT's list envelopes to the group-scoped rows only. */
export function groupScopedRows(raw: unknown): MemberFieldRow[] {
  // The `group` bucket is CT's authoritative scope discriminator. Its rows may still carry
  // `type: "person"` because they store values on memberships/persons; applying the generic row
  // heuristic again would discard exactly the definitions writable through `/memberfields/group`.
  const explicit = explicitlyScopedGroupRows(raw);
  if (explicit !== undefined) return explicit;
  return memberFieldRows(raw).filter(isGroupScopedMemberField);
}
