import { describe, expect, it } from "vitest";
import { permissionReportTargets } from "../src/commands/report.js";
import { collectLivePermissions } from "../src/reports/permissions/collect.js";
import { permissionSetHash } from "../src/reports/permissions/hash.js";
import { renderByObject, renderBySubject } from "../src/reports/permissions/render.js";
import type { PermissionAssignment, PermissionDataset } from "../src/reports/permissions/model.js";

const assignment = (subject: PermissionAssignment["subject"], authId = 42, id = 7): PermissionAssignment => ({
  subject,
  right: { authId, name: "Ein Recht", technicalName: "view thing" },
  object: { type: "cc_wikicategory", id, label: "Wiki" },
});

const dataset = (
  assignments: PermissionAssignment[],
  subjects = assignments.map((a) => a.subject),
): PermissionDataset => ({
  subjects,
  assignments,
});

describe("permission report targets", () => {
  it("uses default filenames when both one-pass options omit their values", () => {
    expect(permissionReportTargets({ bySubject: true, byObject: true })).toEqual([
      { by: "subject", output: "permissions-by-subject.md" },
      { by: "object", output: "permissions-by-object.md" },
    ]);
  });

  it("accepts explicit filenames", () => {
    expect(permissionReportTargets({ bySubject: "subject.md", byObject: "object.md" })).toEqual([
      { by: "subject", output: "subject.md" },
      { by: "object", output: "object.md" },
    ]);
  });

  it("derives both filenames from one base path", () => {
    expect(permissionReportTargets({ byBoth: "/foo/bar/permission-report" })).toEqual([
      { by: "subject", output: "/foo/bar/permission-report_by-subject" },
      { by: "object", output: "/foo/bar/permission-report_by-object" },
    ]);
    expect(permissionReportTargets({ byBoth: "reports/permission-report.md" })).toEqual([
      { by: "subject", output: "reports/permission-report_by-subject.md" },
      { by: "object", output: "reports/permission-report_by-object.md" },
    ]);
  });

  it("rejects ambiguous or missing output selections", () => {
    expect(() => permissionReportTargets({})).toThrow("Select");
    expect(() => permissionReportTargets({ byBoth: "report", byObject: true })).toThrow("cannot be combined");
    expect(() => permissionReportTargets({ bySubject: "same.md", byObject: "same.md" })).toThrow("same file");
  });
});

describe("permission report hashing", () => {
  it("uses the same hash for identical sets and ignores API order", () => {
    const subject = { type: "PRS", id: 1, label: "Person" };
    const a = [assignment(subject), assignment(subject, 43, 8)];
    expect(permissionSetHash(a)).toBe(permissionSetHash([...a].reverse()));
  });

  it("changes when a right is added or removed", () => {
    const subject = { type: "PRS", id: 1, label: "Person" };
    const a = [assignment(subject)];
    expect(permissionSetHash(a)).not.toBe(permissionSetHash([...a, assignment(subject, 43)]));
  });

  it("uses both names and ids as permission identity", () => {
    const subject = { type: "PRS", id: 1, label: "Person" };
    const original = assignment(subject);
    const renamed: PermissionAssignment = {
      ...original,
      right: { ...original.right, name: "Umbenannt", technicalName: "renamed" },
      object: { ...original.object!, label: "Wiki " },
    };
    const sameNamesButDifferentObject = assignment(subject, 42, 8);

    expect(permissionSetHash([original])).not.toBe(permissionSetHash([renamed]));
    expect(permissionSetHash([original])).not.toBe(permissionSetHash([sameNamesButDifferentObject]));
  });

  it("hashes a permission set rather than duplicate rows", () => {
    const value = assignment({ type: "PRS", id: 1, label: "Person" });
    expect(permissionSetHash([value])).toBe(permissionSetHash([value, value]));
  });
});

describe("permission report renderers", () => {
  it("groups subjects with the same complete set under one hash", () => {
    const a = assignment({ type: "PRS", id: 1, label: "Anna" });
    const b = assignment({ type: "PRS", id: 2, label: "Berta" });
    const text = renderBySubject(dataset([a, b]));
    expect(text.match(/^# /gm)).toHaveLength(1);
    expect(text).toContain("## PRS Anna");
    expect(text).toContain("## PRS Berta");
    expect(text.match(/^\* Ein Recht/gm)).toHaveLength(1);
  });

  it("inverts an assignment for the object report", () => {
    const text = renderByObject(dataset([assignment({ type: "GTRL", id: 9, label: "EG Team Leiter" })]));
    expect(text).toContain("Wiki (cc_wikicategory: 7)");
    expect(text).toContain("2 Gruppentyp");
    expect(text).toContain("EG Team Leiter");
  });

  it("renders unscoped assignments without inventing an object", () => {
    const assignments: PermissionAssignment[] = [
      {
        subject: { type: "ST", id: "active", label: "active" },
        right: { authId: 1, name: "Personen sehen" },
      },
    ];
    const text = renderBySubject(dataset(assignments));
    expect(text).toContain("Personen sehen (auth_table: 1)");
    expect(text).toContain("[1]");
    expect(text).not.toContain("unknown");
    expect(renderByObject(dataset(assignments))).toContain("## Personen sehen (auth_table: 1)");
  });

  it("renders known subjects with no rights explicitly and without a fingerprint", () => {
    const text = renderBySubject(
      dataset(
        [],
        [
          { type: "ST", id: 2, label: "Ohne Statusrechte" },
          { type: "GTRL", id: 3, label: "Team Beobachter" },
        ],
      ),
    );
    expect(text).toContain("# Keine Berechtigungen");
    expect(text).toContain("## ST Ohne Statusrechte");
    expect(text).toContain("## GTRL Team Beobachter");
    expect(text).toContain("(keine Berechtigungen)");
    expect(text).not.toMatch(/^# [a-f0-9]{32}$/m);
    expect(text).not.toMatch(/^\* /m);
  });
});

describe("churchauth collector", () => {
  it("keeps live categories distinct when only one has a trailing space", async () => {
    const rows = {
      "/permissions/person": [
        { domainId: 10, authId: 502, dataId: 7, type: "grant", isInherited: false },
        { domainId: 10, authId: 502, dataId: 8, type: "grant", isInherited: false },
      ],
      "/permissions/status": [],
      "/permissions/group_type_role": [],
      "/permissions/group_role": [],
    } as const;
    const result = await collectLivePermissions({
      get: async <T>(path: string) => (rows[path as keyof typeof rows] ?? []) as T,
      legacyPostForm: async <T>() =>
        ({
          data: {
            auth_table: {
              churchwiki: {
                "view category": {
                  id: 502,
                  bezeichnung: "Wiki sehen",
                  datenfeld: "cc_wikicategory",
                },
              },
            },
            churchauth: {
              person: { "10": { id: 10, bezeichnung: "Anna" } },
              cc_wikicategory: {
                "7": { id: 7, bezeichnung: "Kategorie" },
                "8": { id: 8, bezeichnung: "Kategorie " },
              },
            },
          },
        }) as T,
    });

    expect(result.assignments.map((a) => [a.object?.id, a.object?.label])).toEqual([
      [7, "Kategorie"],
      [8, "Kategorie "],
    ]);
    const report = renderByObject(result);
    expect(report).toContain("## Kategorie (cc_wikicategory: 7)");
    expect(report).toContain("## Kategorie  (cc_wikicategory: 8)");
  });

  it("uses the existing authenticated AJAX reader without contacting a live instance in the test", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    const result = await collectLivePermissions({
      get: async <T>() => [] as T,
      legacyPostForm: async <T>(module: string, params: Record<string, string>) => {
        calls.push([module, params]);
        return { data: { auth_table: {}, churchauth: {} } } as T;
      },
    });
    expect(result).toEqual({ subjects: [], assignments: [] });
    expect(calls).toEqual([["churchauth/ajax", { func: "getMasterData" }]]);
  });

  it("joins live domains and exposes empty ST/GTRL gaps without listing every empty PRS/GRRL", async () => {
    const paths: string[] = [];
    const rows = {
      "/permissions/person": [{ domainId: 10, authId: 502, dataId: 7, type: "grant", isInherited: false }],
      "/permissions/status": [{ domainId: 2, authId: 101, dataId: null, type: "grant", isInherited: false }],
      "/permissions/group_type_role": [
        { domainId: 20, authId: 101, dataId: null, type: "grant", isInherited: false },
      ],
      "/permissions/group_role": [
        { domainId: 30, authId: 101, dataId: null, type: "grant", isInherited: false },
      ],
    } as const;
    const master = {
      data: {
        auth_table: {
          churchdb: { view: { id: 101, bezeichnung: "Personen sehen", datenfeld: "" } },
          churchwiki: {
            "view category": {
              id: 502,
              bezeichnung: "Wiki sehen",
              datenfeld: "cc_wikicategory",
            },
          },
        },
        churchauth: {
          person: {
            "10": { id: 10, bezeichnung: "Anna" },
            "11": { id: 11, bezeichnung: "Chuck Norris" },
          },
          status: {
            "2": { id: 2, bezeichnung: "Aktiv" },
            "3": { id: 3, bezeichnung: "Ohne Rechte" },
          },
          grouptype: { "3": { id: 3, bezeichnung: "Eventgruppe" } },
          grouptypeMemberstatus: {
            "20": { id: 20, gruppentyp_id: 3, bezeichnung: "Leiter" },
            "21": { id: 21, gruppentyp_id: 3, bezeichnung: "Beobachter" },
          },
          group: { "4": { id: 4, bezeichnung: "Technik" } },
          groupMemberstatus: {
            "30": { id: 30, group_id: 4, grouptype_memberstatus_id: 20 },
            "31": { id: 31, group_id: 4, grouptype_memberstatus_id: 21 },
          },
          cc_wikicategory: { "7": { id: 7, bezeichnung: "Intern" } },
        },
      },
    };
    const result = await collectLivePermissions({
      get: async <T>(path: string) => {
        paths.push(path);
        return (rows[path as keyof typeof rows] ?? []) as T;
      },
      legacyPostForm: async <T>() => master as T,
    });
    expect(paths.sort()).toEqual(Object.keys(rows).sort());
    expect(result.assignments).toHaveLength(4);
    expect(result.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "PRS", id: 10, label: "Anna" },
          right: { authId: 502, name: "Wiki sehen", technicalName: "view category" },
          object: { type: "cc_wikicategory", id: 7, label: "Intern" },
        }),
        expect.objectContaining({ subject: { type: "ST", id: 2, label: "Aktiv" } }),
        expect.objectContaining({
          subject: {
            type: "GTRL",
            id: 20,
            label: "Eventgruppe Leiter",
            objectLabel: "Eventgruppe: [Leiter]",
          },
        }),
        expect.objectContaining({
          subject: {
            type: "GRRL",
            id: 30,
            label: "Technik Leiter",
            objectLabel: "Technik: [Leiter]",
          },
        }),
      ]),
    );
    expect(result.subjects).toEqual(
      expect.arrayContaining([
        { type: "PRS", id: 10, label: "Anna" },
        { type: "ST", id: 2, label: "Aktiv" },
        { type: "ST", id: 3, label: "Ohne Rechte" },
        {
          type: "GTRL",
          id: 21,
          label: "Eventgruppe Beobachter",
          objectLabel: "Eventgruppe: [Beobachter]",
        },
      ]),
    );
    // Empty statuses and type roles expose actionable permission gaps.
    // Empty people and concrete role pairings would only flood the report with irrelevant rows.
    expect(result.subjects).not.toContainEqual({ type: "PRS", id: 11, label: "Chuck Norris" });
    expect(result.subjects).not.toContainEqual(expect.objectContaining({ type: "GRRL", id: 31 }));
    const subjectReport = renderBySubject(result);
    expect(subjectReport).not.toContain("## PRS Chuck Norris");
    expect(subjectReport).not.toContain("## GRRL Technik Beobachter");
    expect(subjectReport).toContain("## ST Ohne Rechte");
    expect(subjectReport).toContain("## GTRL Eventgruppe Beobachter");
  });
});
