import type { CtClient } from "../../api/ctClient.js";
import { fetchPermissionRows, type PermissionReader } from "../../permissions/fetch.js";
import type { RawPermission } from "../../permissions/grants.js";
import {
  fetchChurchAuthMasterData,
  permissionRightDefinitions,
  type ChurchAuthMasterData,
  type ChurchAuthMasterDataTable,
  type PermissionRightDefinition,
} from "../../permissions/masterdata.js";
import type { PermissionAssignment, PermissionDataset, PermissionSubject } from "./model.js";

export async function collectLivePermissions(
  client: PermissionReader & Pick<CtClient, "legacyPostForm">,
): Promise<PermissionDataset> {
  const [master, person, status, groupTypeRole, groupRole] = await Promise.all([
    fetchChurchAuthMasterData(client),
    fetchPermissionRows(client, "/permissions/person"),
    fetchPermissionRows(client, "/permissions/status"),
    fetchPermissionRows(client, "/permissions/group_type_role"),
    fetchPermissionRows(client, "/permissions/group_role"),
  ]);
  return collectLiveRows(master, { person, status, group_type_role: groupTypeRole, group_role: groupRole });
}

function rowsById(table: ChurchAuthMasterDataTable | undefined): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!table || typeof table !== "object") return result;
  for (const [key, value] of Object.entries(table)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    result.set(String(row.id ?? key), row);
  }
  return result;
}

function labelOf(row: Record<string, unknown> | undefined, fallback: string): string {
  if (!row) return fallback;
  for (const key of ["bezeichnung", "name", "identifier", "kuerzel", "shorty"]) {
    const value = row[key];
    // Use trim only to reject an all-whitespace value. Returning the original string is
    // intentional: two ChurchTools objects may differ solely by surrounding whitespace.
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function liveSubject(
  domainType: keyof LiveRows,
  domainId: number,
  tables: Record<string, Map<string, Record<string, unknown>>>,
): PermissionSubject {
  if (domainType === "person") {
    return {
      type: "PRS",
      id: domainId,
      label: labelOf(tables.person?.get(String(domainId)), `Person #${domainId}`),
    };
  }
  if (domainType === "status") {
    return {
      type: "ST",
      id: domainId,
      label: labelOf(tables.status?.get(String(domainId)), `Status #${domainId}`),
    };
  }
  if (domainType === "group_type_role") {
    const role = tables.grouptypeMemberstatus?.get(String(domainId));
    const groupTypeId = String(role?.gruppentyp_id ?? "");
    const groupType = labelOf(tables.grouptype?.get(groupTypeId), `Gruppentyp #${groupTypeId || "?"}`);
    const roleLabel = labelOf(role, `Rolle #${domainId}`);
    const shorty = tables.grouptype?.get(groupTypeId)?.shorty;
    const groupTypeShort =
      typeof shorty === "string" && shorty.trim() ? shorty.trim() : (groupType.split(/\s+/)[0] ?? groupType);
    return {
      type: "GTRL",
      id: domainId,
      label: `${groupTypeShort} ${roleLabel}`,
      objectLabel: `${groupType}: [${roleLabel}]`,
    };
  }
  const role = tables.groupMemberstatus?.get(String(domainId));
  const groupId = String(role?.group_id ?? "");
  const typeRoleId = String(role?.grouptype_memberstatus_id ?? role?.group_type_role_id ?? "");
  const group = labelOf(tables.group?.get(groupId), `Gruppe #${groupId || "?"}`);
  const roleLabel = labelOf(
    tables.grouptypeMemberstatus?.get(typeRoleId),
    `Rolle #${typeRoleId || domainId}`,
  );
  return {
    type: "GRRL",
    id: domainId,
    label: `${group} ${roleLabel}`,
    objectLabel: `${group}: [${roleLabel}]`,
  };
}

type LiveRows = Record<"person" | "status" | "group_type_role" | "group_role", RawPermission[]>;

function collectLiveRows(master: ChurchAuthMasterData, rows: LiveRows): PermissionDataset {
  const rawTables = master.churchauth ?? {};
  const tables: Record<string, Map<string, Record<string, unknown>>> = {};
  for (const [name, table] of Object.entries(rawTables)) tables[name] = rowsById(table);
  const rights = new Map<number, PermissionRightDefinition>(
    permissionRightDefinitions(master).map((definition) => [definition.authId, definition]),
  );
  const result = new Map<string, PermissionAssignment>();

  const subjects = new Map<string, PermissionSubject>();
  const addSubject = (subject: PermissionSubject): void => {
    subjects.set(`${subject.type}\0${String(subject.id)}`, subject);
  };

  // Empty statuses and group-type roles are intentionally visible: an expected role/status with no
  // direct rights is a useful permission gap. Listing every empty person and concrete group-role
  // pairing would instead drown those gaps in thousands of irrelevant rows, so PRS/GRRL enter the
  // dataset only when a direct permission row references them.
  for (const id of tables.status?.keys() ?? []) addSubject(liveSubject("status", Number(id), tables));
  for (const id of tables.grouptypeMemberstatus?.keys() ?? [])
    addSubject(liveSubject("group_type_role", Number(id), tables));

  for (const [domainType, permissions] of Object.entries(rows) as Array<[keyof LiveRows, RawPermission[]]>) {
    for (const row of permissions) {
      const right = rights.get(Number(row.authId));
      const subject = liveSubject(domainType, Number(row.domainId), tables);
      addSubject(subject);
      const assignment: PermissionAssignment = {
        subject,
        right: right
          ? {
              authId: right.authId,
              name: right.description.trim() || `${right.module}:${right.technicalName}`,
              technicalName: right.technicalName,
            }
          : { authId: row.authId, name: `authId ${row.authId}` },
        effect: row.type,
      };
      if (row.dataId != null) {
        const id = String(row.dataId);
        const scopeField = right?.scopeField ?? "unknown";
        assignment.object = {
          type: scopeField,
          id: row.dataId,
          label: row.dataId === -1 ? "alle" : labelOf(tables[scopeField]?.get(id), `${scopeField} #${id}`),
        };
      }
      const key = [domainType, row.domainId, row.authId, row.dataId ?? "", row.type].join(":");
      result.set(key, assignment);
    }
  }
  return { subjects: [...subjects.values()], assignments: [...result.values()] };
}
