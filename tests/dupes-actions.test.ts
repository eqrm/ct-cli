import { afterEach, describe, expect, it } from "vitest";
import {
  executeMerge,
  loadPair,
  markNotDuplicate,
  recoverUnrecordedMerge,
  type ReviewDeps,
} from "../src/dupes/actions.js";
import { financeMerges } from "../src/dupes/finance.js";
import { setChoice } from "../src/dupes/merge-model.js";
import { cleanDirs, fakeClient, patches, raw, setup, type Call } from "./dupes-fixtures.js";

afterEach(cleanDirs);

describe("merge actions", () => {
  it("PATCHes the Original's object with chosen duplicate values; system keys stay", async () => {
    const t = setup();
    const pair = await loadPair(t.deps, 1, 2);
    expect(pair.model.fields.map((f) => f.key)).not.toContain("guid");
    const model = setChoice(pair.model, "lastName", "duplicate");
    const res = await executeMerge(t.deps, pair, model);
    expect(res).toMatchObject({ kind: "merged", duplicateStillExists: false });
    const [p] = patches(t.calls);
    expect(p!.path).toBe("/persons/1/merge/2");
    expect(p!.body).toMatchObject({ guid: "guid-1", lastName: "Beispiel", mobile: "0151" });
    expect(p!.body).not.toHaveProperty("null");
    const audit = t.store.readAudit();
    expect(audit.map((e) => e.action)).toEqual(["merge-started", "merge-confirmed"]);
    expect(audit[0]).toMatchObject({ groupsDiff: { original: [10], duplicate: [11, 12], both: [] } });
  });

  it("merges in the swapped direction", async () => {
    const t = setup();
    const pair = await loadPair(t.deps, 2, 1);
    await executeMerge(t.deps, pair, pair.model);
    expect(patches(t.calls)[0]!.path).toBe("/persons/2/merge/1");
    expect(t.store.readAudit().at(-1)).toMatchObject({ survivingId: 2, loserId: 1 });
  });

  it("records the merge with a flag when ChurchTools kept the duplicate", async () => {
    const t = setup({ stays: true });
    const pair = await loadPair(t.deps, 1, 2);
    const res = await executeMerge(t.deps, pair, pair.model);
    expect(res).toMatchObject({ kind: "merged", duplicateStillExists: true });
    expect(t.store.readAudit().at(-1)).toMatchObject({ duplicateStillExists: true });
    expect(t.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("returns failed with only the HTTP status on PATCH 500, no merge-confirmed", async () => {
    const t = setup({ patchFails: true });
    const pair = await loadPair(t.deps, 1, 2);
    const res = await executeMerge(t.deps, pair, pair.model);
    expect(res).toEqual({ kind: "failed", status: 500, stage: "patch", fields: [], groupsDone: [] });
    expect(t.store.readAudit().map((e) => e.action)).toEqual(["merge-started", "merge-error"]);
  });

  it("records the merge when the PATCH errors but the duplicate is gone", async () => {
    const t = setup({ patchFails: true, goneAfterError: true });
    const pair = await loadPair(t.deps, 1, 2);
    const res = await executeMerge(t.deps, pair, pair.model);
    expect(res).toMatchObject({ kind: "merged", afterError: true });
    expect(t.store.readAudit().at(-1)).toMatchObject({ action: "merge-confirmed", afterError: true });
  });

  it("recovers an unrecorded merge once the duplicate is gone", async () => {
    const t = setup({ patchFails: true });
    const pair = await loadPair(t.deps, 1, 2);
    await executeMerge(t.deps, pair, pair.model);
    expect(await recoverUnrecordedMerge(t.deps, 1, 2)).toBe(false);
    const later: ReviewDeps = { ...t.deps, client: fakeClient([], { gone: [2] }) };
    expect(await recoverUnrecordedMerge(later, 1, 2)).toBe(true);
    expect(t.store.readAudit().at(-1)).toMatchObject({ action: "merge-confirmed", recovered: true });
    expect(await recoverUnrecordedMerge(later, 1, 2)).toBe(false);
  });

  it("feeds the finance export from the Optigem choice, not for a lone ID", async () => {
    const persons = {
      1: raw(1, { optigemId: "10001" }),
      2: raw(2, { optigemId: "10002" }),
    };
    const t = setup({ persons });
    const pair = await loadPair(t.deps, 1, 2);
    await executeMerge(t.deps, pair, setChoice(pair.model, "optigemId", "duplicate"));
    expect(patches(t.calls)[0]!.body).toMatchObject({ optigemId: "10002" });
    expect(financeMerges(t.store.readAudit())).toMatchObject([
      { leadingOptigemId: "10002", orphanedOptigemId: "10001" },
    ]);
    const lone = setup({ persons: { 1: raw(1), 2: raw(2, { optigemId: "7" }) } });
    const p2 = await loadPair(lone.deps, 1, 2);
    await executeMerge(lone.deps, p2, p2.model);
    expect(patches(lone.calls)[0]!.body).toMatchObject({ optigemId: "7" });
    expect(lone.store.readAudit().at(-1)).toMatchObject({ leadingOptigemId: "7", orphanedOptigemId: "" });
    expect(financeMerges(lone.store.readAudit())).toEqual([]);
  });

  it("re-reads the original right before writing", async () => {
    const calls: Call[] = [];
    const t = setup();
    const pair = await loadPair(t.deps, 1, 2);
    const fresh = raw(1, { job: "edited meanwhile" });
    const deps: ReviewDeps = { ...t.deps, client: fakeClient(calls, { persons: { 1: fresh, 2: raw(2) } }) };
    await executeMerge(deps, pair, pair.model);
    expect(patches(calls)[0]!.body).toMatchObject({ job: "edited meanwhile" });
  });

  it("marks 'keine Dublette' and writes the relationship back", async () => {
    const t = setup();
    expect(await markNotDuplicate(t.deps, 1, 2)).toEqual({ ok: true, status: null });
    expect(t.calls).toEqual([
      { method: "POST", path: "/persons/1/relationships", body: { otherPersonId: 2, relationshipTypeId: 4 } },
    ]);
  });
});

describe("rejectedFields", () => {
  it("returns only well-formed field ids from a ChurchTools validation error, never messages or args", async () => {
    const { rejectedFields } = await import("../src/dupes/actions.js");
    const { CtApiError } = await import("../src/api/ctClient.js");
    const err = new CtApiError("bad", 400, {
      message: "Validation failed",
      errors: [
        { fieldId: "emails[0].contactLabelId", message: "x", args: { value: "secret@example.org" } },
        { fieldId: "birthday", message: "y" },
        { fieldId: "birthday" },
        { fieldId: "not a key; secret@example.org" },
        { message: "no field" },
      ],
    });
    expect(rejectedFields(err)).toEqual(["emails[0].contactLabelId", "birthday"]);
    expect(rejectedFields(new Error("x"))).toEqual([]);
    expect(rejectedFields(new CtApiError("x", 400, null))).toEqual([]);
  });
});

describe("shared groups", () => {
  const memberships = {
    "13:1": {
      groupTypeRoleId: 1,
      groupMemberStatus: "active",
      memberStartDate: "2024-01-01",
      comment: null,
      fields: [
        { id: 5, name: "Paid", value: true },
        { id: 6, name: "Team", value: null },
      ],
    },
    "13:2": {
      groupTypeRoleId: 2,
      groupMemberStatus: "active",
      memberStartDate: "2015-03-01",
      comment: "seit Gründung",
      fields: [
        { id: 5, name: "Paid", value: false },
        { id: 6, name: "Team", value: "Beta" },
      ],
    },
  };
  const both = [
    { id: 13, title: "Hauskreis" },
    { id: 14, title: "Auto" },
  ];

  it("defaults: earlier join date and empty values from the Duplikat, conflicts stay with the Original", async () => {
    const t = setup({ both, dynamicGroupIds: [14], memberships });
    const pair = await loadPair(t.deps, 1, 2);
    const [st, dy] = pair.shared;
    expect(dy).toMatchObject({ id: 14, dynamic: true, items: [] });
    const choice = Object.fromEntries(st!.items.map((i) => [i.key, i.choice]));
    expect(choice).toEqual({
      groupTypeRoleId: "original",
      groupMemberStatus: "original",
      memberStartDate: "duplicate",
      comment: "duplicate",
      "field:5": "original",
      "field:6": "duplicate",
    });
  });

  it("updates the Original's membership, removes the Duplikat from every shared group, then merges", async () => {
    const t = setup({ both, dynamicGroupIds: [14], memberships });
    const pair = await loadPair(t.deps, 1, 2);
    const res = await executeMerge(t.deps, pair, pair.model);
    expect(res).toMatchObject({ kind: "merged" });
    const writes = t.calls.map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual([
      "PATCH /groups/13/members/1",
      "DELETE /groups/13/members/2",
      "DELETE /groups/14/members/2",
      "PATCH /persons/1/merge/2",
    ]);
    expect(t.calls[0]!.body).toEqual({
      memberStartDate: "2015-03-01",
      comment: "seit Gründung",
      fields: { "6": "Beta" },
    });
    const prepared = t.store.readAudit().find((e) => e.action === "groups-prepared");
    expect(prepared).toMatchObject({
      groupsDone: [
        { groupId: 13, dynamic: false, updated: ["memberStartDate", "comment", "field:6"] },
        { groupId: 14, dynamic: true, updated: [] },
      ],
    });
  });

  it("stops before the merge when a group step fails", async () => {
    const t = setup({ both, dynamicGroupIds: [14], memberships, groupWriteFails: 403 });
    const pair = await loadPair(t.deps, 1, 2);
    const res = await executeMerge(t.deps, pair, pair.model);
    expect(res).toMatchObject({ kind: "failed", stage: "groups", status: 403, groupId: 13, groupsDone: [] });
    expect(t.calls.some((c) => c.path.includes("/merge/"))).toBe(false);
    expect(t.store.readAudit().some((e) => e.action === "merge-confirmed")).toBe(false);
  });
});
