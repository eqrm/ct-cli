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
 *  - `referenceName` — this IS the local identity (see {@link matchesLocalKey}), not a diffable
 *    property. Managing it would let a plain rename silently re-key the resource, and the field
 *    would then be re-created rather than updated on the next apply.
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
  /** The declared properties — never an id, never `referenceName`. Diffed as one unit. */
  props: Record<string, unknown>;
}

/** A row as ChurchTools returns it from `GET /groups/{groupId}/memberfields`. */
export type MemberFieldRow = Record<string, unknown>;

/**
 * Is this live row a GROUP-SCOPED custom member field — i.e. one of the rows the
 * `/memberfields/group` write endpoints own?
 *
 * `GET /groups/{groupId}/memberfields` answers with every field the group's signup/member form
 * shows, which on a real instance mixes group-scoped custom fields with rows sourced elsewhere
 * (person master data, group-type defaults). Only the first kind can be created or updated through
 * `/memberfields/group`, so only the first kind is adoptable or manageable here.
 *
 * The discriminator is read leniently, because CT has spelled this differently across versions:
 * a `type`/`fieldCategory`/`source` of `"group"` marks a group-scoped row. A row that carries NO
 * discriminator at all is treated as group-scoped — the endpoint is the group's own, so "we cannot
 * tell" errs towards showing the field rather than silently hiding one an author needs.
 */
export function isGroupScopedMemberField(row: MemberFieldRow): boolean {
  for (const name of ["type", "fieldCategory", "source", "fieldSource"]) {
    const value = row[name];
    if (typeof value === "string") return value.toLowerCase() === "group";
  }
  return true;
}

/**
 * The local key a live row answers to. `referenceName` is CT's own stable, non-numeric handle
 * within the group and is what a create sends, so it wins; `name` is the fallback for a row created
 * in the ChurchTools UI, where CT may mint its own referenceName. Slugged on both sides so a key
 * derived from a German name (`Wahl` → `wahl`) matches either spelling.
 */
export function localKeyOf(row: MemberFieldRow): string {
  const reference = row.referenceName;
  if (typeof reference === "string" && reference.length > 0) return slug(reference);
  const name = row.name;
  return typeof name === "string" ? slug(name) : "";
}

/** Does this live row carry the declared local key? (See {@link localKeyOf}.) */
export function matchesLocalKey(row: MemberFieldRow, localKey: string): boolean {
  const wanted = slug(localKey);
  if (localKeyOf(row) === wanted) return true;
  const name = row.name;
  return typeof name === "string" && slug(name) === wanted;
}

/** The numeric ChurchTools id of a live row, or `undefined` when it carries none. */
export function memberFieldRowId(row: MemberFieldRow): number | undefined {
  for (const name of ["id", "groupMemberFieldId"]) {
    const value = row[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
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
  declaredProps: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of declaredProps) out[name] = row[name];
  return out;
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

/** Normalise CT's list envelope (bare array or `{ data: [...] }`) to the group-scoped rows only. */
export function groupScopedRows(raw: unknown): MemberFieldRow[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown } | null)?.data)
      ? ((raw as { data: unknown[] }).data as unknown[])
      : [];
  return list
    .filter((row): row is MemberFieldRow => row !== null && typeof row === "object" && !Array.isArray(row))
    .filter(isGroupScopedMemberField);
}
