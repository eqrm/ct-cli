import { describe, expect, it } from "vitest";
import { resolveRelationshipTypes, type DupesClient } from "../src/dupes/ct.js";
import { cleanName } from "../src/dupes/normalize.js";
import { renderMergeUrl } from "../src/dupes/review.js";
import { SCAN_SCHEMA, carryStates, type ScanFile } from "../src/dupes/store.js";
import type { Candidate } from "../src/dupes/detector.js";

const cand = (a: number, b: number): Candidate => ({
  a,
  b,
  score: 80,
  tier: "T1",
  matchClass: "exact",
  signals: [],
  source: "detector",
});

describe("review fixes", () => {
  it("refuses to guess relationship type ids when masterdata lacks the function keys", async () => {
    const client = {
      get: async () => ({ relationshipTypes: [{ id: 6 }, { id: 9, functionKeys: ["spouse"] }] }),
    } as unknown as DupesClient;
    await expect(resolveRelationshipTypes(client)).rejects.toThrow(/function keys/);
  });

  it("keeps earlier decisions when re-scanning", () => {
    const previous: ScanFile = {
      schema: SCAN_SCHEMA,
      host: "https://example.church.tools",
      scannedAt: "2026-01-01T00:00:00.000Z",
      personsScanned: 4,
      candidates: [
        { ...cand(1, 2), state: "dismissed" },
        { ...cand(3, 4), state: "merged" },
        { ...cand(5, 6), state: "open" },
      ],
    };
    const next = carryStates(previous, [cand(1, 2), cand(5, 6), cand(7, 8)]);
    expect(next.map((c) => c.state)).toEqual(["dismissed", "open", "open"]);
    expect(carryStates(null, [cand(1, 2)])[0]!.state).toBe("open");
  });

  it("renders the merge URL literally and without a double slash", () => {
    expect(
      renderMergeUrl("{host}/persons/{original}/merge/{duplicate}", "https://example.church.tools/", 1, 2),
    ).toBe("https://example.church.tools/persons/1/merge/2");
    expect(renderMergeUrl("{host}/x?a=$&{duplicate}", "https://h$1.example", 1, 2)).toBe(
      "https://h$1.example/x?a=$&2",
    );
  });

  it("keeps letters of non-Latin scripts in names", () => {
    expect(cleanName("Мария")).toBe("мария");
    expect(cleanName("Ελένη Παπαδοπούλου")).not.toBe("");
    expect(cleanName("Jürgen-Müller!")).toBe("juergen-mueller");
  });
});
