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
 *
 * The mapping is MANY-TO-ONE (`a.b` and `a_b` both label `a_b`), and keys are
 * user-settable via `--key`, so callers that render more than one resource of a
 * type must run `assertLabelsUnique` over them — two blocks sharing an address
 * is a `tofu` parse error, and the second import silently targets the first.
 */
export function hclLabel(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "_");
  return /^[0-9-]/.test(safe) ? `g_${safe}` : safe;
}

/**
 * Throw if two keys of the same type collapse onto one HCL label.
 *
 * Detected here rather than left to `tofu`: the export knows both keys and can
 * say which two to rename, while `tofu` only reports a duplicate address.
 */
export function assertLabelsUnique(rows: readonly { type: string; key: string }[]): void {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const address = `${hclType(row.type)}.${hclLabel(row.key)}`;
    const first = seen.get(address);
    if (first !== undefined && first !== row.key) {
      throw new Error(
        `export: keys "${first}" and "${row.key}" both render as ${address}. ` +
          `Re-key one of them (ct adopt --key) before exporting.`,
      );
    }
    seen.set(address, row.key);
  }
}

/**
 * Quote a string as an HCL template literal.
 *
 * `JSON.stringify` escapes JSON metacharacters, not HCL's interpolation
 * markers: a CT name containing `${` or `%{` would otherwise be parsed as an
 * interpolation — a plan-time error, or silently the wrong value. HCL escapes
 * those by doubling the sigil.
 */
export function hclString(value: string): string {
  // Function replacers, not replacement strings: "$${" in a replacement string
  // means an escaped `$` followed by `{` — i.e. exactly the input, a silent no-op.
  return JSON.stringify(value)
    .replace(/\$\{/g, () => "$${")
    .replace(/%\{/g, () => "%%{");
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return hclString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return hclString(JSON.stringify(value));
}

export interface RenderOptions {
  /**
   * Mirror of the state's `preventDestroy`. Destroy protection is the one piece
   * of state that is not a managed field, and dropping it in the export would
   * migrate a protected resource into an unprotected one — `ct destroy` refuses
   * it, `tofu destroy` would not.
   */
  preventDestroy?: boolean;
}

/** Render one resource block. Null/undefined fields are omitted, never emitted as `null`. */
export function renderResource(
  ctType: string,
  key: string,
  fields: Record<string, unknown>,
  options: RenderOptions = {},
): string {
  const type = hclType(ctType);
  const entries = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [hclAttr(k), v] as const);
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  const lines = entries.map(([k, v]) => `  ${k.padEnd(width)} = ${renderValue(v)}`);
  const lifecycle = options.preventDestroy ? ["", "  lifecycle {", "    prevent_destroy = true", "  }"] : [];
  return [`resource "${type}" "${hclLabel(key)}" {`, ...lines, ...lifecycle, "}", ""].join("\n");
}
