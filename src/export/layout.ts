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
