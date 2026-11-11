import { describe, expect, it } from "vitest";
import { emailLabel, emailTypes, formatValue, isMasterValue } from "../src/dupes/actions.js";
import { toPersonRecord } from "../src/dupes/ct.js";
import {
  buildBody,
  buildEmailRows,
  buildModel,
  defaultChoice,
  olderFirst,
  optigemOutcome,
  setChoice,
  setDefaultEmail,
  toggleEmail,
  type MergeModel,
} from "../src/dupes/merge-model.js";
import { raw } from "./dupes-fixtures.js";

const model = (o: Record<string, unknown>, d: Record<string, unknown>): MergeModel =>
  buildModel(o, d, [], "optigemId");

describe("merge model", () => {
  it("only offers whitelisted person fields; system keys are never choosable", () => {
    const m = model(raw(1), raw(2, { lastName: "Beispiel", domainType: "person", imageUrl: "x" }));
    const keys = m.fields.map((f) => f.key);
    expect(keys).toContain("lastName");
    for (const k of [
      "guid",
      "id",
      "meta",
      "domainType",
      "imageUrl",
      "securityLevelForPerson",
      "emails",
      "email",
    ]) {
      expect(keys).not.toContain(k);
    }
  });

  it("skips fields that are empty on both sides and defaults to the non-empty side", () => {
    const m = model(raw(1, { mobile: "" }), raw(2, { mobile: "0151", job: "" }));
    expect(m.fields.find((f) => f.key === "job")).toBeUndefined();
    expect(m.fields.find((f) => f.key === "mobile")!.choice).toBe("duplicate");
    expect(m.fields.find((f) => f.key === "firstName")!.choice).toBe("original");
    expect(defaultChoice("a", "b")).toBe("original");
    expect(defaultChoice("", "")).toBe("none");
  });

  it("keeps the Original's values by default and applies chosen duplicate values", () => {
    const o = raw(1);
    const d = raw(2, { lastName: "Beispiel" });
    let m = model(o, d);
    expect(buildBody(o, d, m).body.lastName).toBe("Muster");
    m = setChoice(m, "lastName", "duplicate");
    expect(buildBody(o, d, m).body.lastName).toBe("Beispiel");
    m = setChoice(m, "lastName", "none");
    expect(buildBody(o, d, m).body.lastName).toBe("");
  });

  it("keeps the Bereiche of both persons by default and can still pick one side", () => {
    const o = raw(1, { departmentIds: [1] });
    const d = raw(2, { departmentIds: [2, 1] });
    let m = model(o, d);
    expect(m.fields.find((f) => f.key === "departmentIds")!.choice).toBe("both");
    expect(buildBody(o, d, m).body.departmentIds).toEqual([1, 2]);
    m = setChoice(m, "departmentIds", "duplicate");
    expect(buildBody(o, d, m).body.departmentIds).toEqual([2, 1]);
    expect(setChoice(m, "lastName", "both")).toBe(m);
    const same = model(raw(1, { departmentIds: [1, 2] }), raw(2, { departmentIds: [2] }));
    expect(same.fields.find((f) => f.key === "departmentIds")!.choice).toBe("original");
  });

  it("unions emails: duplicate addresses without id, original ids kept, one default", () => {
    const o = raw(1, {
      email: "a@example.org",
      emails: [
        { id: 1, email: "a@example.org", isDefault: true },
        { id: 2, email: "a2@example.org", isDefault: false },
      ],
    });
    const d = raw(2, {
      emails: [
        { id: 9, email: "B@example.org", isDefault: true },
        { id: 8, email: "A@example.org" },
      ],
    });
    const m = model(o, d);
    expect(m.emails.map((e) => [e.address, e.isDefault])).toEqual([
      ["a@example.org", true],
      ["a2@example.org", false],
      ["B@example.org", false],
    ]);
    const body = buildBody(o, d, m).body;
    expect(body.emails).toEqual([
      { contactLabelId: null, email: "a@example.org", isDefault: true },
      { contactLabelId: null, email: "a2@example.org", isDefault: false },
      { contactLabelId: null, email: "B@example.org", isDefault: false },
    ]);
    expect("email" in body).toBe(false);
  });

  it("sends the body in the shape ChurchTools' own merge UI sends (no read-only or empty keys)", () => {
    const o = raw(1, {
      email: "a@example.org",
      emails: [{ id: 1, email: "a@example.org", isDefault: true, contactLabelId: 2, extra: "x" }],
      createdDate: "2020-01-01",
      imageUrl: "https://example.org/i.png",
      parents: [],
      isActive: true,
      lastLogin: "2024-01-01",
      nickname: "",
      job: null,
      isDead: false,
      invitationStatus: { status: "accepted" },
      privacyPolicyAgreement: { date: "2020-01-01" },
      meta: {
        createdDate: "c",
        createdPerson: { id: 1 },
        modifiedDate: "m",
        modifiedPerson: { id: 1 },
        other: 1,
      },
    });
    const d = raw(2, { nickname: "Nick", emails: [] });
    const body = buildBody(o, d, model(o, d)).body;
    for (const k of [
      "email",
      "createdDate",
      "imageUrl",
      "parents",
      "isActive",
      "lastLogin",
      "job",
      "invitationStatus",
      "privacyPolicyAgreement",
    ]) {
      expect(body, k).not.toHaveProperty(k);
    }
    expect(body.isDead).toBe(false);
    expect(body.nickname).toBe("Nick");
    expect(Object.keys(body.meta as object).sort()).toEqual([
      "createdDate",
      "createdPerson",
      "modifiedDate",
      "modifiedPerson",
    ]);
    expect(body.emails).toEqual([{ contactLabelId: 2, email: "a@example.org", isDefault: true }]);
  });

  it("toggling and default selection keep exactly one default among included addresses", () => {
    const o = raw(1, { emails: [{ id: 1, email: "a@example.org", isDefault: true }] });
    const d = raw(2, { emails: [{ id: 9, email: "b@example.org", isDefault: true }] });
    let m = model(o, d);
    m = setDefaultEmail(m, "b@example.org");
    expect(buildBody(o, d, m).body.emails).toEqual([
      { contactLabelId: null, email: "a@example.org", isDefault: false },
      { contactLabelId: null, email: "b@example.org", isDefault: true },
    ]);
    m = toggleEmail(m, "b@example.org");
    expect(buildBody(o, d, m).body.emails).toEqual([
      { contactLabelId: null, email: "a@example.org", isDefault: true },
    ]);
  });

  it("Optigem: lone ID is preselected; both IDs follow the choice", () => {
    expect(optigemOutcome(model(raw(1), raw(2, { optigemId: "7" })))).toEqual({ leading: "7", orphaned: "" });
    const o = raw(1, { optigemId: "1" });
    const d = raw(2, { optigemId: "2" });
    let m = model(o, d);
    expect(optigemOutcome(m)).toEqual({ leading: "1", orphaned: "2" });
    m = setChoice(m, "optigemId", "duplicate");
    expect(optigemOutcome(m)).toEqual({ leading: "2", orphaned: "1" });
    expect(buildBody(o, d, m).body.optigemId).toBe("2");
  });

  it("warns instead of writing a display string when the duplicate lacks the key", () => {
    const o = raw(1, { job: "x" });
    const d = raw(2);
    let m = model(o, d);
    m = {
      ...m,
      fields: [
        ...m.fields,
        { key: "job", label: "Job", original: "x", duplicate: "y", choice: "duplicate", optigem: false },
      ],
    };
    const res = buildBody(o, d, m);
    expect(res.warnings[0]).toContain("cannot be carried over automatically");
    expect(res.body.job).toBe("x");
  });

  it("the older person (lower id) is the default Original", () => {
    expect(olderFirst({ id: 5 }, { id: 3 }).map((p) => p.id)).toEqual([3, 5]);
  });
});

describe("campus and status ids", () => {
  it("keeps id 0 (a valid campus/status id) and shows names where masterdata has them", () => {
    const rec = toPersonRecord(raw(1), "optigemId");
    expect(rec.campusId).toBe(0);
    expect(rec.statusId).toBe(0);
    const labels = { campusId: new Map([[0, "Hauptcampus"]]) };
    expect(formatValue("campusId", 0, labels)).toBe("Hauptcampus");
    expect(formatValue("statusId", 0, labels)).toBe("0");
    expect(formatValue("campusId", null, labels)).toBe("");
    expect(formatValue("birthday", "1999-06-30", labels)).toBe("30.06.1999");
    expect(formatValue("job", "1999-06-30 Umzug", labels)).toBe("1999-06-30 Umzug");
  });

  it("names each department of a list and treats a fully named list as masterdata", () => {
    const labels = {
      departmentIds: new Map([
        [1, "Bereich A"],
        [2, "Bereich B"],
      ]),
    };
    expect(formatValue("departmentIds", [1, 2], labels)).toBe("Bereich A, Bereich B");
    expect(formatValue("departmentIds", [1, 9], labels)).toBe("Bereich A, 9");
    expect(formatValue("departmentIds", [], labels)).toBe("");
    expect(isMasterValue("departmentIds", [1, 2], labels)).toBe(true);
    expect(isMasterValue("departmentIds", [1, 9], labels)).toBe(false);
  });

  it("labels email rows with their contact type, the Original's when both have the address", () => {
    const labels = {
      contactLabelId: new Map([
        [1, "Privat"],
        [4, "Arbeit"],
      ]),
    };
    const rows = buildEmailRows(
      { emails: [{ email: "a@example.org", contactLabelId: 1, isDefault: true }] },
      {
        emails: [
          { email: "A@example.org", contactLabelId: 4, isDefault: true },
          { email: "b@example.org", contactLabelId: 4, isDefault: false },
          { email: "c@example.org", contactLabelId: 99, isDefault: false },
        ],
      },
    );
    expect(rows.map((r) => emailLabel(r, labels))).toEqual(["E-Mail (Privat)", "E-Mail (Arbeit)", "E-Mail"]);
    expect(emailTypes(rows[0]!, labels)).toEqual({ original: "Privat", duplicate: "Arbeit" });
    expect(emailLabel(rows[0]!, {})).toBe("E-Mail");
  });
});
