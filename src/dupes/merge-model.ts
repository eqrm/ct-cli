/**
 * Pure merge logic for `ct dupes review`: which person fields can be chosen, the defaults, the email
 * rows and the PATCH body. No I/O and no UI, so it is unit-tested on its own.
 */
import type { MergeDiffEntry } from "./ct.js";

export type Side = "original" | "duplicate" | "none";

/**
 * The only person fields an operator can choose between. Everything else in a merge preview
 * (guid, id, meta, domainType, image and url fields, security levels, privacy*, ...) is a system
 * key and always comes from the Original. `email` is handled by the email rows, not here.
 */
export const CHOOSABLE_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "title", label: "Title" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "nickname", label: "Nickname" },
  { key: "birthName", label: "Birth name" },
  { key: "sexId", label: "Sex" },
  { key: "birthday", label: "Birthday" },
  { key: "birthplace", label: "Birthplace" },
  { key: "nationalityId", label: "Nationality" },
  { key: "familyStatusId", label: "Family status" },
  { key: "weddingDate", label: "Wedding date" },
  { key: "job", label: "Job" },
  { key: "street", label: "Street" },
  { key: "addition", label: "Address addition" },
  { key: "zip", label: "ZIP" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
  { key: "phonePrivate", label: "Phone (private)" },
  { key: "phoneWork", label: "Phone (work)" },
  { key: "mobile", label: "Mobile" },
  { key: "fax", label: "Fax" },
  { key: "campusId", label: "Campus" },
  { key: "statusId", label: "Status" },
  { key: "departmentIds", label: "Departments" },
];

export interface FieldRow {
  key: string;
  label: string;
  original: unknown;
  duplicate: unknown;
  choice: Side;
  /** True for the Optigem ID row (drives the finance audit). */
  optigem: boolean;
}

export interface EmailRow {
  address: string;
  /** The original's entry (kept with its id) when the address exists there. */
  originalEntry: Record<string, unknown> | null;
  /** The duplicate's entry when it exists there. */
  duplicateEntry: Record<string, unknown> | null;
  include: boolean;
  isDefault: boolean;
}

export interface MergeModel {
  fields: FieldRow[];
  emails: EmailRow[];
  optigemField: string;
}

export const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Canonical string form, for comparing and displaying. */
export function canon(v: unknown): string {
  if (isEmpty(v)) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Non-empty side wins; the Original wins a conflict. */
export function defaultChoice(original: unknown, duplicate: unknown): Side {
  if (!isEmpty(original)) return "original";
  return isEmpty(duplicate) ? "none" : "duplicate";
}

const addrKey = (e: Record<string, unknown>): string => String(e.email ?? "").toLowerCase();

function emailList(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>).filter((e) => addrKey(e) !== "") : [];
}

/** One row per distinct address of both persons; all included, the Original's default stays default. */
export function buildEmailRows(
  originalRaw: Record<string, unknown>,
  duplicateRaw: Record<string, unknown>,
): EmailRow[] {
  const rows = new Map<string, EmailRow>();
  for (const e of emailList(originalRaw.emails)) {
    rows.set(addrKey(e), {
      address: String(e.email),
      originalEntry: e,
      duplicateEntry: null,
      include: true,
      isDefault: e.isDefault === true,
    });
  }
  const dup = emailList(duplicateRaw.emails);
  for (const e of dup) {
    const row = rows.get(addrKey(e));
    if (row) row.duplicateEntry = e;
    else {
      rows.set(addrKey(e), {
        address: String(e.email),
        originalEntry: null,
        duplicateEntry: e,
        include: true,
        isDefault: false,
      });
    }
  }
  const list = [...rows.values()];
  if (!list.some((r) => r.isDefault) && list.length > 0) {
    const dupDefault = list.find((r) => r.duplicateEntry?.isDefault === true);
    (dupDefault ?? list[0]!).isDefault = true;
  }
  // exactly one default
  let seen = false;
  for (const r of list) {
    if (r.isDefault && seen) r.isDefault = false;
    if (r.isDefault) seen = true;
  }
  return list;
}

/** Field rows: every choosable field either person has a value for (differing or not), plus Optigem. */
export function buildModel(
  originalRaw: Record<string, unknown>,
  duplicateRaw: Record<string, unknown>,
  personDiff: readonly MergeDiffEntry[],
  optigemField: string,
): MergeModel {
  const diffNames = new Map(personDiff.filter((d) => d.key !== null).map((d) => [d.key as string, d.name]));
  const specs = [
    ...CHOOSABLE_FIELDS.filter((f) => f.key !== optigemField),
    { key: optigemField, label: "Optigem ID" },
  ];
  const fields: FieldRow[] = [];
  for (const s of specs) {
    const o = originalRaw[s.key];
    const d = duplicateRaw[s.key];
    if (isEmpty(o) && isEmpty(d)) continue;
    fields.push({
      key: s.key,
      label: s.key === optigemField ? s.label : (diffNames.get(s.key) ?? s.label),
      original: o,
      duplicate: d,
      choice: defaultChoice(o, d),
      optigem: s.key === optigemField,
    });
  }
  return { fields, emails: buildEmailRows(originalRaw, duplicateRaw), optigemField };
}

export const differs = (r: FieldRow): boolean => canon(r.original) !== canon(r.duplicate);

export function setChoice(m: MergeModel, key: string, choice: Side): MergeModel {
  return { ...m, fields: m.fields.map((f) => (f.key === key ? { ...f, choice } : f)) };
}

export function toggleEmail(m: MergeModel, address: string): MergeModel {
  const emails = m.emails.map((e) => (e.address === address ? { ...e, include: !e.include } : e));
  return { ...m, emails: ensureDefault(emails) };
}

export function setDefaultEmail(m: MergeModel, address: string): MergeModel {
  const emails = m.emails.map((e) =>
    e.address === address ? { ...e, include: true, isDefault: true } : { ...e, isDefault: false },
  );
  return { ...m, emails };
}

/** Keep exactly one default among the included addresses. */
function ensureDefault(emails: EmailRow[]): EmailRow[] {
  const included = emails.filter((e) => e.include);
  if (included.length === 0) return emails.map((e) => ({ ...e, isDefault: false }));
  const keep = included.find((e) => e.isDefault) ?? included[0]!;
  return emails.map((e) => ({ ...e, isDefault: e === keep }));
}

/** Value written to the body for a cleared field. */
function cleared(sample: unknown): unknown {
  if (Array.isArray(sample)) return [];
  return typeof sample === "string" ? "" : null;
}

export interface OptigemOutcome {
  leading: string;
  orphaned: string;
}

/** Leading ID follows the choice; the orphaned one is the other side's, only when both had one. */
export function optigemOutcome(m: MergeModel): OptigemOutcome {
  const row = m.fields.find((f) => f.optigem);
  if (!row) return { leading: "", orphaned: "" };
  const o = canon(row.original);
  const d = canon(row.duplicate);
  const chosen = row.choice === "original" ? o : row.choice === "duplicate" ? d : "";
  const other = row.choice === "original" ? d : row.choice === "duplicate" ? o : "";
  return { leading: chosen, orphaned: o !== "" && d !== "" && chosen !== "" ? other : "" };
}

/**
 * The PATCH body: the (freshly read) original with the chosen values applied. Duplicate addresses
 * are copied without their id. A chosen duplicate value the duplicate object does not carry is
 * skipped and reported in `warnings`.
 */
/**
 * System keys ChurchTools' own merge UI sends in the PATCH body (observed in a HAR of the web UI).
 * Everything else the GET returns is left out: sending the full GET object is rejected (400), and
 * nested objects such as `invitationStatus` or `privacyPolicyAgreement` make the endpoint fail
 * with a 500 (verified on a dev instance).
 */
export const SYSTEM_KEYS = [
  "id",
  "guid",
  "domainType",
  "meta",
  "campusId",
  "statusId",
  "departmentIds",
  "canChat",
  "chatActive",
  "isArchived",
  "isDead",
  "firstContact",
  "lastEditedDate",
  "visibility",
  "securityLevelForPerson",
  "editSecurityLevelForPerson",
  "privacyPolicyAgreementDate",
  "privacyPolicyAgreementTypeId",
  "privacyPolicyAgreementWhoId",
] as const;

const META_KEYS = ["createdDate", "createdPerson", "modifiedDate", "modifiedPerson"];

/**
 * The Original as ChurchTools' merge UI sends it: the system keys above plus the person fields
 * (`personKeys`), each only when it has a value.
 */
export function writableBody(
  raw: Record<string, unknown>,
  personKeys: Iterable<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set<string>([...SYSTEM_KEYS, ...personKeys])) {
    if (k in raw && !isEmpty(raw[k])) out[k] = raw[k];
  }
  if (out.meta && typeof out.meta === "object") {
    const m = out.meta as Record<string, unknown>;
    out.meta = Object.fromEntries(META_KEYS.filter((k) => k in m).map((k) => [k, m[k]]));
  }
  return out;
}

export function buildBody(
  freshOriginal: Record<string, unknown>,
  duplicateRaw: Record<string, unknown>,
  m: MergeModel,
): { body: Record<string, unknown>; warnings: string[] } {
  const body = writableBody(freshOriginal, [
    ...CHOOSABLE_FIELDS.map((f) => f.key),
    ...m.fields.map((f) => f.key),
  ]);
  const warnings: string[] = [];
  for (const f of m.fields) {
    if (f.choice === "original") continue;
    if (f.choice === "none") {
      body[f.key] = cleared(freshOriginal[f.key] ?? f.original);
    } else if (f.key in duplicateRaw) {
      body[f.key] = duplicateRaw[f.key];
    } else {
      warnings.push(`${f.label}: value cannot be carried over automatically, set it in ChurchTools.`);
    }
  }
  if (m.emails.length > 0 || "emails" in freshOriginal) {
    const included = ensureDefault(m.emails).filter((e) => e.include);
    const fresh = new Map(emailList(freshOriginal.emails).map((e) => [addrKey(e), e]));
    const emails = included.map((e) => {
      const live = fresh.get(e.address.toLowerCase()) ?? e.originalEntry;
      const base = (live ?? e.duplicateEntry ?? {}) as Record<string, unknown>;
      // ChurchTools' merge UI sends exactly these three keys per address (no id).
      return { contactLabelId: base.contactLabelId ?? null, email: e.address, isDefault: e.isDefault };
    });
    body.emails = emails;
  }
  return { body, warnings };
}

/** ChurchTools' merge UI proposes the person with the lower id as the Original. */
export function olderFirst<T extends { id: number }>(a: T, b: T): [T, T] {
  return a.id <= b.id ? [a, b] : [b, a];
}
