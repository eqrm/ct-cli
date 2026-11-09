import { describe, expect, it } from "vitest";
import { buildCandidates, loadRelationState, toPersonRecord, type DupesClient } from "../src/dupes/ct.js";
import { FINANCE_SCHEMA, buildFinanceExport, financeMerges, toCsv } from "../src/dupes/finance.js";

const rec = (id: number, first: string, last: string, extra: Record<string, unknown> = {}) =>
  toPersonRecord({ id, firstName: first, lastName: last, birthday: "1990-05-05", ...extra }, "optigemId");

function fakeClient(rels: unknown[], groups: unknown[]): DupesClient {
  return {
    get: async (path: string) =>
      path === "/person/masterdata"
        ? {
            relationshipTypes: [
              { id: 61, functionKeys: ["noduplicate"] },
              { id: 91, functionKeys: ["openduplicate"] },
            ],
          }
        : groups,
    getAll: async () => ({ data: rels }),
    request: async () => ({}),
  } as unknown as DupesClient;
}

describe("relation state and candidates", () => {
  it("resolves relationship type ids by function key", async () => {
    const st = await loadRelationState(fakeClient([], []));
    expect(st.types).toEqual({ noDuplicate: 61, duplicate: 91 });
  });

  it("suppresses pairs with a non-duplicate relationship", async () => {
    const st = await loadRelationState(
      fakeClient([{ personAId: 1, personBId: 2, relationshipTypeId: 61 }], []),
    );
    const out = buildCandidates([rec(1, "Erika", "Muster"), rec(2, "Erika", "Muster")], st);
    expect(out).toEqual([]);
  });

  it("keeps a pair tagged as open duplicate and flags it", async () => {
    const st = await loadRelationState(
      fakeClient([{ personAId: 1, personBId: 2, relationshipTypeId: 91 }], []),
    );
    const out = buildCandidates([rec(1, "Erika", "Muster"), rec(2, "Erika", "Muster")], st);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "both", markedDuplicate: true });
  });

  it("adds CT-only suggestions and drops unknown persons", async () => {
    const groups = [
      {
        relationshipTypeId: null,
        relationships: [
          { p1: { id: 1 }, p2: { id: 2 } },
          { p1: { id: 1 }, p2: { id: 99 } },
        ],
      },
    ];
    const st = await loadRelationState(fakeClient([], groups));
    const out = buildCandidates([rec(1, "Anna", "Beispiel"), rec(2, "Berta", "Zufall")], st);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "ct", matchClass: "ct" });
    expect(out[0]!.score).toBeGreaterThanOrEqual(35);
  });
});

describe("finance export", () => {
  const audit = [
    {
      action: "merge-confirmed",
      ts: "2026-02-01T10:00:00.000Z",
      survivingId: 5,
      leadingOptigemId: "10001",
      orphanedOptigemId: "10002",
      mergedBy: "Erika Muster",
    },
    {
      action: "merge-confirmed",
      ts: "2026-02-02T10:00:00.000Z",
      survivingId: 6,
      leadingOptigemId: "10003",
      orphanedOptigemId: "",
    },
    {
      action: "merge-confirmed",
      ts: "2026-03-01T10:00:00.000Z",
      survivingId: 7,
      leadingOptigemId: "10005",
      orphanedOptigemId: "10005",
      mergedBy: "=cmd",
    },
    {
      action: "merge-started",
      ts: "2026-03-01T10:00:00.000Z",
      survivingId: 8,
      leadingOptigemId: "1",
      orphanedOptigemId: "2",
    },
  ];

  it("keeps only confirmed merges with both ids", () => {
    const m = financeMerges(audit);
    expect(m.map((x) => x.survivingPersonId)).toEqual([5, 7]);
    expect(m[1]!.identicalIds).toBe(true);
  });

  it("filters by --since", () => {
    expect(financeMerges(audit, "2026-02-15").map((x) => x.survivingPersonId)).toEqual([7]);
  });

  it("writes a stable CSV and neutralises formulas", () => {
    const csv = toCsv(financeMerges(audit)).split("\n");
    expect(csv[0]).toBe(
      "surviving_person_id,leading_optigem_id,orphaned_optigem_id,identical_ids,merged_at,merged_by",
    );
    expect(csv[1]).toBe("5,10001,10002,false,2026-02-01T10:00:00.000Z,Erika Muster");
    expect(csv[2]).toContain(",'=cmd");
  });

  it("builds the documented JSON envelope", () => {
    const j = buildFinanceExport(
      financeMerges(audit),
      "https://example.church.tools",
      undefined,
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(j).toMatchObject({ schema: FINANCE_SCHEMA, since: null, host: "https://example.church.tools" });
    expect(Object.keys(j.merges[0]!)).toEqual([
      "survivingPersonId",
      "leadingOptigemId",
      "orphanedOptigemId",
      "identicalIds",
      "mergedAt",
      "mergedBy",
    ]);
  });
});
