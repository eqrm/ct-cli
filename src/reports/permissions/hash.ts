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
  // The old PHP report used 32-character fingerprints. MD5 is used only as a stable
  // report fingerprint, never for authentication or integrity.
  // Preserve its fingerprint for the empty JSON permission set (`md5("[]")`).
  const serialized = values.length === 0 ? "[]" : values.join("\n");
  return createHash("md5").update(serialized).digest("hex");
}
