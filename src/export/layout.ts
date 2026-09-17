/** Which generated file each resource type lands in — PURE. */
const FILE_BY_TYPE: Record<string, string> = {
  campus: "campuses.tf",
  "group-type": "group-types.tf",
  department: "departments.tf",
  "person-status": "person-statuses.tf",
  "comment-viewer": "comment-viewers.tf",
};

export function fileForType(ctType: string): string {
  const file = FILE_BY_TYPE[ctType];
  if (!file) throw new Error(`export: no output file mapped for resource type "${ctType}"`);
  return file;
}

export const EXPORTABLE_TYPES = Object.keys(FILE_BY_TYPE);

/**
 * Every file the export owns and may therefore overwrite or delete.
 *
 * The export prunes the ones it did not write this run: a `campuses.tf` left
 * over from an earlier export (or from `--only`) keeps managing resources that
 * are no longer in the exported set, and `tofu plan` then proposes creating
 * what already exists. Nothing outside this list is ever touched.
 */
export const OWNED_FILES = [...Object.values(FILE_BY_TYPE), "imports.tf", "versions.tf"];
