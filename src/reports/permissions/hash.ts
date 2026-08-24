import { createHash } from "node:crypto";
import type { PermissionAssignment } from "./model.js";

function canonical(a: PermissionAssignment): string {
  return JSON.stringify({
    authId: String(a.right.authId),
    rightName: a.right.name,
    technicalName: a.right.technicalName ?? "",
    objectType: a.object?.type ?? "",
    objectId: a.object ? String(a.object.id) : "",
    objectLabel: a.object?.label ?? "",
    effect: a.effect ?? "grant",
  });
}

export function permissionSetHash(assignments: PermissionAssignment[]): string {
  // Names and ids both belong to the documented fingerprint: ids distinguish equally named
  // objects, while a rename deliberately changes the report hash.
  const values = [...new Set(assignments.map(canonical))].sort();
  // MD5 is used only as a compact deterministic grouping key, never for authentication or
  // integrity. Empty sets are rendered explicitly and never exposed as a misleading fingerprint.
  return createHash("md5").update(values.join("\n")).digest("hex");
}
