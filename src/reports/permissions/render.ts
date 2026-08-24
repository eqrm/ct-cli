import { permissionSetHash } from "./hash.js";
import type {
  PermissionAssignment,
  PermissionDataset,
  PermissionObject,
  PermissionSubject,
} from "./model.js";

function objectText(object?: PermissionObject, withIdFingerprint = true): string {
  if (!object) return "";
  return `${object.label} (${object.type}: ${object.id})${withIdFingerprint ? ` [${object.id}]` : ""}`;
}

function rightText(a: PermissionAssignment): string {
  const technical = a.right.technicalName ? ` [${a.right.technicalName}]` : "";
  const effect = a.effect === "revoke" ? " [REVOKE]" : "";
  return `${a.right.name}${technical} (auth_table: ${a.right.authId})${effect}`;
}

function subjectRightText(a: PermissionAssignment): string {
  const unscopedId = a.object ? "" : ` [${a.right.authId}]`;
  return `${rightText(a)}${unscopedId}`;
}

export function renderBySubject(dataset: PermissionDataset): string {
  const bySubject = new Map<string, PermissionAssignment[]>();
  const subjects = new Map<string, PermissionSubject>();
  for (const subject of dataset.subjects) {
    const key = `${subject.type}\0${String(subject.id)}`;
    subjects.set(key, subject);
    bySubject.set(key, []);
  }
  for (const a of dataset.assignments) {
    const key = `${a.subject.type}\0${String(a.subject.id)}`;
    subjects.set(key, a.subject);
    const list = bySubject.get(key) ?? [];
    list.push(a);
    bySubject.set(key, list);
  }
  const groups = new Map<
    string,
    Array<{ subject: PermissionSubject; assignments: PermissionAssignment[] }>
  >();
  const emptySubjects: PermissionSubject[] = [];
  for (const [key, list] of bySubject) {
    const subject = subjects.get(key);
    if (!subject) continue;
    if (list.length === 0) {
      emptySubjects.push(subject);
      continue;
    }
    const hash = permissionSetHash(list);
    const group = groups.get(hash) ?? [];
    group.push({ subject, assignments: list });
    groups.set(hash, group);
  }
  const lines: string[] = [];
  for (const [hash, subjectSets] of groups) {
    lines.push(`# ${hash}`);
    for (const entry of subjectSets.sort((a, b) => {
      const as = a.subject;
      const bs = b.subject;
      return `${as.type} ${as.label}`.localeCompare(`${bs.type} ${bs.label}`);
    })) {
      lines.push(`## ${entry.subject.type} ${entry.subject.label}`);
    }
    // Every set in this hash group is canonically identical. Render it once; including each
    // subject's copy would repeat every right N times under an N-subject heading group.
    const rights = subjectSets[0]?.assignments ?? [];
    let lastRight = "";
    if (rights.length > 0) lines.push("");
    for (const a of rights) {
      const current = subjectRightText(a);
      if (current !== lastRight) {
        lines.push(`* ${current}`);
        lastRight = current;
      }
      if (a.object) lines.push(`    * ${objectText(a.object)}`);
    }
    lines.push("");
  }
  if (emptySubjects.length > 0) {
    lines.push("# Keine Berechtigungen");
    for (const subject of emptySubjects.sort((a, b) =>
      `${a.type} ${a.label}`.localeCompare(`${b.type} ${b.label}`),
    )) {
      lines.push(`## ${subject.type} ${subject.label}`);
    }
    lines.push("", "(keine Berechtigungen)", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

const SUBJECT_ORDER: Record<string, number> = { ST: 1, GTRL: 2, GRRL: 3, PRS: 4 };

export function renderByObject(dataset: PermissionDataset): string {
  const grouped = new Map<string, PermissionAssignment[]>();
  for (const a of dataset.assignments) {
    const key = [
      a.object?.type ?? "",
      String(a.object?.id ?? ""),
      String(a.right.authId),
      a.right.name,
      a.right.technicalName ?? "",
      a.effect ?? "grant",
    ].join("\0");
    const list = grouped.get(key) ?? [];
    list.push(a);
    grouped.set(key, list);
  }
  const lines: string[] = [];
  const heading = (a: PermissionAssignment): string =>
    a.object ? `${objectText(a.object, false)} (${rightText(a)})` : rightText(a);
  for (const list of [...grouped.values()].sort((a, b) =>
    a[0] && b[0] ? heading(a[0]).localeCompare(heading(b[0]), "de") : 0,
  )) {
    const first = list[0];
    if (!first) continue;
    lines.push(`## ${heading(first)}`, "");
    const subjects = [
      ...new Map(list.map((a) => [`${a.subject.type}\0${a.subject.id}`, a.subject])).values(),
    ].sort(
      (a, b) =>
        (SUBJECT_ORDER[a.type] ?? 99) - (SUBJECT_ORDER[b.type] ?? 99) || a.label.localeCompare(b.label),
    );
    for (const subject of subjects) {
      const label =
        { ST: "Status", GTRL: "Gruppentyp", GRRL: "Gruppe", PRS: "Person" }[subject.type] ?? subject.type;
      lines.push(
        `    ${SUBJECT_ORDER[subject.type] ?? 99} ${label.padEnd(11)}: ${subject.objectLabel ?? subject.label}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
