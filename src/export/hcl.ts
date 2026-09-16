/**
 * HCL rendering — PURE. No filesystem, no network, no state loading.
 *
 * Kept pure for the same reason `src/coverage/report.ts` is: the golden export
 * test has to run without touching disk, and a renderer that reads files
 * cannot be property-tested against committed fixtures.
 */

/**
 * ct-cli resource type -> Terraform resource type.
 *
 * The `churchtools_` prefix is not decoration: Terraform resolves a resource's
 * provider from the segment before the first underscore, so a bare `campus`
 * type would send it looking for a provider named `campus`. (HCL also has no
 * top-level custom blocks — every resource is `resource "<type>" "<label>"`.)
 */
const HCL_TYPE: Record<string, string> = {
  campus: "churchtools_campus",
  "group-type": "churchtools_group_type",
  department: "churchtools_department",
  "person-status": "churchtools_person_status",
  "comment-viewer": "churchtools_comment_viewer",
};

export function hclType(ctType: string): string {
  const mapped = HCL_TYPE[ctType];
  if (!mapped) throw new Error(`export: no Terraform resource type mapped for "${ctType}"`);
  return mapped;
}

/**
 * CT field name -> HCL attribute name. The provider exposes snake_case
 * attributes (Terraform convention); ct-cli's state carries CT's camelCase.
 */
const HCL_ATTR: Record<string, string> = {
  nameTranslated: "name_translated",
  isMember: "is_member",
  isSearchable: "is_searchable",
  sortKey: "sort_key",
  securityLevelId: "security_level_id",
};

export function hclAttr(field: string): string {
  return HCL_ATTR[field] ?? field;
}

/**
 * Make a ct-cli key referenceable in HCL.
 *
 * ct keys are already slugs, but a REFERENCE (`churchtools_group.3_groupactive`)
 * must be a valid identifier, and `!3 GroupActive` derives a key starting with a
 * digit. Such keys get a `g_` prefix; the mapping is reported by the export
 * command so nothing renames silently.
 */
export function hclLabel(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "_");
  return /^[0-9-]/.test(safe) ? `g_${safe}` : safe;
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Render one resource block. Null/undefined fields are omitted, never emitted as `null`. */
export function renderResource(ctType: string, key: string, fields: Record<string, unknown>): string {
  const type = hclType(ctType);
  const entries = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [hclAttr(k), v] as const);
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  const lines = entries.map(([k, v]) => `  ${k.padEnd(width)} = ${renderValue(v)}`);
  return [`resource "${type}" "${hclLabel(key)}" {`, ...lines, "}", ""].join("\n");
}
