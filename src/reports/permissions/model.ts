export type PermissionSubjectType = "PRS" | "ST" | "GTRL" | "GRRL" | string;

export interface PermissionSubject {
  type: PermissionSubjectType;
  id: string | number;
  label: string;
  /** Expanded label used by the object-oriented report, e.g. "Group: [Role]". */
  objectLabel?: string;
}

export interface PermissionRight {
  authId: string | number;
  name: string;
  technicalName?: string;
}

export interface PermissionObject {
  type: string;
  id: string | number;
  label: string;
}

export interface PermissionAssignment {
  subject: PermissionSubject;
  right: PermissionRight;
  object?: PermissionObject;
  /** ChurchTools can store an explicit deny beside grants. Omitted means grant for fixture compatibility. */
  effect?: "grant" | "revoke";
}

/**
 * Subjects are deliberately independent from assignments: an existing subject can have an empty
 * permission set and must still be distinguishable from an unknown subject in the report.
 */
export interface PermissionDataset {
  subjects: PermissionSubject[];
  assignments: PermissionAssignment[];
}
