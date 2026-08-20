import type { CtClient } from "../../api/ctClient.js";
import { fetchPermissionRows, type PermissionReader } from "../../permissions/fetch.js";
import type { RawPermission } from "../../permissions/grants.js";
import type {
  PermissionAssignment,
  PermissionDataset,
  PermissionObject,
  PermissionSubject,
} from "./model.js";

interface RawEntry {
  [key: string]: unknown;
}
interface RawAuthSubject extends RawEntry {
  person?: string;
  person_id?: string | number;
  grouptype?: string;
  grouptypeMemberstatus_id?: string | number;
  membertype?: string;
  group?: string;
  group_id?: string | number;
  role?: string;
  groupMemberstatus_id?: string | number;
  auth?: Record<string, unknown>;
  resolved_auth?: Array<Record<string, unknown>>;
}

export interface ChurchAuthMasterData {
  auth_by_person?: Record<string, RawAuthSubject>;
  auth_by_status?: Record<string, RawAuthSubject>;
  auth_by_grouptypes?: Record<string, RawAuthSubject[]>;
  auth_by_groups?: Record<string, Record<string, RawAuthSubject>>;
}

interface ChurchAuthResponse {
  data?: ChurchAuthMasterData & LiveMasterData;
  response?: ChurchAuthMasterData;
  auth_by_person?: ChurchAuthMasterData["auth_by_person"];
  auth_by_status?: ChurchAuthMasterData["auth_by_status"];
  auth_by_grouptypes?: ChurchAuthMasterData["auth_by_grouptypes"];
  auth_by_groups?: ChurchAuthMasterData["auth_by_groups"];
}

interface RawRightDefinition {
  id?: string | number;
  datenfeld?: string | null;
  bezeichnung?: string;
}

type MasterDataTable = Record<string, unknown> | unknown[];

interface LiveMasterData {
  auth_table?: Record<string, Record<string, RawRightDefinition>>;
  churchauth?: Record<string, MasterDataTable>;
}

interface LiveRight {
  authId: number;
  name: string;
  technicalName: string;
  scopeField: string | null;
}

const RIGHT_RE = /^(.*?)\s+\[([^\]]+)\]\s+\(auth_table:\s*([^)]+)\)$/;
// Consume exactly the one separator space inserted before the metadata. Any additional space
// belongs to the ChurchTools label and must remain visible in this lossless report.
const OBJECT_RE = /^(.*) \(([^:()]+):\s*([^)]+)\)$/;

function rightInfo(
  value: string,
  authId: string,
): { name: string; technicalName?: string; authId: string | number } {
  const match = RIGHT_RE.exec(value.trim());
  return match
    ? { name: match[1] ?? value.trim(), technicalName: match[2], authId: match[3] || authId }
    : { name: value.trim(), authId };
}

function objectInfo(value: string, id: string): PermissionObject {
  const match = OBJECT_RE.exec(value.trim());
  return match
    ? { label: match[1] ?? value.trim(), type: match[2] ?? "unknown", id: match[3] ?? id }
    : { label: value.trim(), type: "unknown", id };
}

function addResolved(
  subject: PermissionSubject,
  raw: RawAuthSubject,
  output: PermissionAssignment[],
): Set<string> {
  const seen = new Set<string>();
  for (const item of raw.resolved_auth ?? []) {
    for (const [rightLabel, objects] of Object.entries(item)) {
      const parsed = rightInfo(rightLabel, rightLabel);
      const authId = String(parsed.authId);
      if (Array.isArray(objects)) {
        for (const entry of objects) {
          if (!entry || typeof entry !== "object") continue;
          for (const [label, id] of Object.entries(entry)) {
            const object = objectInfo(label, String(id));
            output.push({ subject, right: parsed, object });
            seen.add(`${authId}:${String(id)}`);
          }
        }
      } else {
        output.push({ subject, right: parsed });
        seen.add(`${authId}:`);
      }
    }
  }
  return seen;
}

function addRawFallback(
  subject: PermissionSubject,
  raw: RawAuthSubject,
  output: PermissionAssignment[],
  seen: Set<string>,
): void {
  for (const [authId, scope] of Object.entries(raw.auth ?? {})) {
    // The legacy PHP fixture uses [] for "no assignment" on a few catalog rights. It is not an
    // unscoped grant and must not become a synthetic `authId N [N]` report line.
    if (Array.isArray(scope) && scope.length === 0) continue;
    if (Array.isArray(scope)) {
      for (const value of scope) {
        const id = String(value);
        if (!seen.has(`${authId}:${id}`)) {
          output.push({
            subject,
            right: { authId, name: `authId ${authId}` },
            object: objectInfo("Objekt", id),
          });
        }
      }
      continue;
    }
    if (scope && typeof scope === "object" && !Array.isArray(scope)) {
      for (const [id] of Object.entries(scope)) {
        if (!seen.has(`${authId}:${id}`))
          output.push({
            subject,
            right: { authId, name: `authId ${authId}` },
            object: objectInfo(`Objekt`, id),
          });
      }
    } else if (!seen.has(`${authId}:`)) {
      output.push({ subject, right: { authId, name: `authId ${authId}` } });
    }
  }
}

function readSubject(
  type: string,
  id: string | number,
  label: string,
  raw: RawAuthSubject,
  objectLabel?: string,
): { subject: PermissionSubject; assignments: PermissionAssignment[] } {
  const subject = { type, id, label, ...(objectLabel ? { objectLabel } : {}) };
  const result: PermissionAssignment[] = [];
  const seen = addResolved(subject, raw, result);
  addRawFallback(subject, raw, result, seen);
  return { subject, assignments: result };
}

export function collectPermissionAssignments(data: ChurchAuthMasterData): PermissionDataset {
  const subjects: PermissionSubject[] = [];
  const assignments: PermissionAssignment[] = [];
  const add = (entry: ReturnType<typeof readSubject>): void => {
    subjects.push(entry.subject);
    assignments.push(...entry.assignments);
  };
  for (const [label, raw] of Object.entries(data.auth_by_person ?? {})) {
    add(readSubject("PRS", raw.person_id ?? label, label, raw));
  }
  for (const [label, raw] of Object.entries(data.auth_by_status ?? {})) {
    add(readSubject("ST", label, label, raw));
  }
  for (const [groupType, rows] of Object.entries(data.auth_by_grouptypes ?? {})) {
    for (const raw of rows ?? []) {
      const role = raw.membertype ?? "";
      const label = `${groupType.split(/\s+/)[0] ?? groupType} ${role}`.trim();
      add(readSubject("GTRL", raw.grouptypeMemberstatus_id ?? label, label, raw, `${groupType}: [${role}]`));
    }
  }
  for (const [group, roles] of Object.entries(data.auth_by_groups ?? {})) {
    for (const [role, raw] of Object.entries(roles ?? {})) {
      const row = raw as RawAuthSubject;
      const label = `${group} ${row.role ?? role}`.trim();
      add(
        readSubject(
          "GRRL",
          row.groupMemberstatus_id ?? `${row.group_id ?? group}:${role}`,
          label,
          row,
          `${group}: [${row.role ?? role}]`,
        ),
      );
    }
  }
  return { subjects, assignments };
}

export async function collectLivePermissions(
  client: PermissionReader & Pick<CtClient, "legacyPostForm">,
): Promise<PermissionDataset> {
  const [masterResponse, person, status, groupTypeRole, groupRole] = await Promise.all([
    client.legacyPostForm<ChurchAuthResponse>("churchauth/ajax", { func: "getMasterData" }),
    fetchPermissionRows(client, "/permissions/person"),
    fetchPermissionRows(client, "/permissions/status"),
    fetchPermissionRows(client, "/permissions/group_type_role"),
    fetchPermissionRows(client, "/permissions/group_role"),
  ]);
  const master = (masterResponse.data ?? masterResponse) as LiveMasterData;
  return collectLiveRows(master, { person, status, group_type_role: groupTypeRole, group_role: groupRole });
}

function rowsById(table: MasterDataTable | undefined): Map<string, Record<string, unknown>> {
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

function liveRightCatalog(authTable: LiveMasterData["auth_table"]): Map<number, LiveRight> {
  const result = new Map<number, LiveRight>();
  for (const [module, definitions] of Object.entries(authTable ?? {})) {
    for (const [technicalName, raw] of Object.entries(definitions ?? {})) {
      const authId = Number(raw.id);
      if (!Number.isFinite(authId) || result.has(authId)) continue;
      result.set(authId, {
        authId,
        name: raw.bezeichnung?.trim() || `${module}:${technicalName}`,
        technicalName,
        scopeField:
          raw.datenfeld == null || String(raw.datenfeld).trim() === "" ? null : String(raw.datenfeld),
      });
    }
  }
  return result;
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

function collectLiveRows(master: LiveMasterData, rows: LiveRows): PermissionDataset {
  const rawTables = master.churchauth ?? {};
  const tables: Record<string, Map<string, Record<string, unknown>>> = {};
  for (const [name, table] of Object.entries(rawTables)) tables[name] = rowsById(table);
  const rights = liveRightCatalog(master.auth_table);
  const result = new Map<string, PermissionAssignment>();

  const subjects = new Map<string, PermissionSubject>();
  const addSubject = (subject: PermissionSubject): void => {
    subjects.set(`${subject.type}\0${String(subject.id)}`, subject);
  };

  // Matching the legacy report, empty catalog subjects are emitted only for statuses and
  // group-type roles. PRS and concrete GRRL subjects are added below only when a permission row
  // references them; mere existence as a person or group-role pairing is not enough.
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
          ? { authId: right.authId, name: right.name, technicalName: right.technicalName }
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
