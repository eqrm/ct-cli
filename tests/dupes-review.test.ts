import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CtApiError } from "../src/api/ctClient.js";
import type { DupesClient } from "../src/dupes/ct.js";
import { financeMerges } from "../src/dupes/finance.js";
import { makeRedactor } from "../src/dupes/redact.js";
import { runReview, type ReviewIO } from "../src/dupes/review.js";
import { DupesStore, SCAN_SCHEMA, type ScanFile } from "../src/dupes/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const raw = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  guid: `guid-${id}`,
  firstName: "Erika",
  lastName: "Muster",
  birthday: "1990-05-05",
  optigemId: "",
  emails: [{ email: `p${id}@example.org`, isDefault: true }],
  campusId: 1,
  meta: { createdDate: `2020-01-0${id}T00:00:00Z` },
  ...over,
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface FakeOpts {
  persons?: Record<number, Record<string, unknown>>;
  patchFails?: boolean;
  /** Does the duplicate still exist after the PATCH? */
  stays?: boolean;
}

/** Fake CT with persons 1 and 2; `GET /persons/1/merge/2` returns a canned preview. */
function fakeClient(calls: Call[], opts: FakeOpts, state: { merged: boolean }): DupesClient {
  const persons: Record<number, Record<string, unknown>> = opts.persons ?? {
    1: raw(1),
    2: raw(2, { campusId: 2, lastName: "Beispiel" }),
  };
  return {
    get: async (path: string) => {
      const m = /^\/persons\/(\d+)$/.exec(path);
      if (m) {
        const id = Number(m[1]);
        if (id === 2 && state.merged && !opts.stays) throw new CtApiError("gone", 404, {});
        return persons[id];
      }
      if (path === "/persons/1/relationships") return [];
      if (path === "/persons/1/merge/2") {
        return {
          personDiff: [
            { key: "lastName", name: "Last name", old: "Muster", new: "Beispiel", printDiff: true },
            { key: "campusId", name: "Campus", old: "1", new: "2", printDiff: true },
            { key: "email", name: "Email", old: "p1@example.org", new: "p2@example.org", printDiff: true },
            { key: null, name: "Something", old: "x", new: "y", printDiff: true },
          ],
          groupsDiff: {
            old: [{ id: 10 }],
            new: [{ id: 11 }, { id: 12 }],
            both: [{ id: 13 }],
          },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    getAll: async () => {
      throw new Error("unexpected getAll");
    },
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "PATCH") {
        if (opts.patchFails) throw new CtApiError("boom", 500, {});
        state.merged = true;
      }
      return {};
    },
  } as unknown as DupesClient;
}

function setup(answers: string[], opts: FakeOpts = {}, redact = false) {
  const base = mkdtempSync(join(tmpdir(), "ct-dupes-review-"));
  dirs.push(base);
  const store = new DupesStore("https://example.church.tools", { CT_DUPES_DIR: base });
  const scan: ScanFile = {
    schema: SCAN_SCHEMA,
    host: "https://example.church.tools",
    scannedAt: "2026-01-01T00:00:00.000Z",
    personsScanned: 2,
    candidates: [
      {
        a: 1,
        b: 2,
        score: 90,
        tier: "T1",
        matchClass: "exact",
        signals: [],
        source: "detector",
        state: "open",
      },
    ],
  };
  const out: string[] = [];
  const questions: string[] = [];
  const queue = [...answers];
  const io: ReviewIO = {
    ask: async (q) => {
      questions.push(q);
      const a = queue.shift();
      if (a === undefined) throw new Error("script exhausted");
      return a;
    },
    print: (l) => out.push(l),
  };
  const calls: Call[] = [];
  const deps = {
    client: fakeClient(calls, opts, { merged: false }),
    store,
    host: "https://example.church.tools",
    redactor: makeRedactor(redact, "secret"),
    optigemField: "optigemId",
    types: { noDuplicate: 4, duplicate: 7 },
    operator: { id: 99, name: "Op Erator" },
    io,
    now: () => new Date("2026-02-01T10:00:00.000Z"),
  };
  return { deps, scan, store, out, questions, calls };
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");

describe("review loop (merge API)", () => {
  it("defaults the survivor to the lower id and keeps the original's values on Enter", async () => {
    // merge, Enter (survivor), then Enter for lastName, campusId, email, proceed
    const t = setup(["m", "", "", "", "", "y"]);
    const counts = await runReview(t.deps, t.scan);
    expect(counts.merged).toBe(1);
    expect(t.questions.some((q) => q.includes("[a/b, Enter = a]"))).toBe(true);
    expect(t.out.join("\n")).toContain("(older, ChurchTools' default)");
    const [p] = patches(t.calls);
    expect(p!.path).toBe("/persons/1/merge/2");
    expect(p!.body).toEqual(raw(1));
    expect(t.out.join("\n")).toContain("2 group(s) move over, 1 shared.");
  });

  it("applies the duplicate's values, ignores null-key diffs and writes email via emails", async () => {
    // survivor a; lastName: other; campusId: survivor; email: other
    const t = setup(["m", "a", "o", "s", "o", "y"]);
    await runReview(t.deps, t.scan);
    const [p] = patches(t.calls);
    expect(p!.body).toEqual({
      ...raw(1),
      lastName: "Beispiel",
      emails: raw(2).emails,
    });
    expect(Object.keys(p!.body as object)).not.toContain("email");
    expect(Object.keys(p!.body as object)).not.toContain("null");
    // the null-key diff was never asked about
    expect(t.questions.filter((q) => q.includes("Something"))).toEqual([]);
  });

  it("treats a 404 on the duplicate as merged and logs the finance fields", async () => {
    const t = setup(["m", "", "", "", "", "y"]);
    await runReview(t.deps, t.scan);
    expect(t.scan.candidates[0]!.state).toBe("merged");
    const audit = t.store.readAudit();
    expect(audit.map((e) => e.action)).toEqual(["merge-started", "merge-confirmed"]);
    expect(audit[1]).not.toHaveProperty("duplicateStillExists");
    expect(audit[0]).toMatchObject({ groupsDiff: { original: [10], duplicate: [11, 12], both: [13] } });
  });

  it("records the merge with a flag when ChurchTools kept the duplicate", async () => {
    const t = setup(["m", "", "", "", "", "y"], { stays: true });
    const counts = await runReview(t.deps, t.scan);
    expect(counts.merged).toBe(1);
    expect(t.out.join("\n")).toContain("kept the duplicate record");
    expect(t.store.readAudit().at(-1)).toMatchObject({
      action: "merge-confirmed",
      duplicateStillExists: true,
    });
    expect(t.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("returns pending on PATCH 500 and writes no merge-confirmed line", async () => {
    const t = setup(["m", "", "", "", "", "y"], { patchFails: true });
    const counts = await runReview(t.deps, t.scan);
    expect(counts.pending).toBe(1);
    expect(t.out.join("\n")).toContain("Merge failed (HTTP 500)");
    expect(t.out.filter((l) => l.includes("Merge failed")).join("")).not.toContain("boom");
    expect(t.store.readAudit().map((e) => e.action)).toEqual(["merge-started", "merge-error"]);
    expect(t.scan.candidates[0]!.state).toBe("open");
  });

  it("puts the Optigem choice into the body and the finance audit", async () => {
    const persons = { 1: raw(1, { optigemId: "10001" }), 2: raw(2, { optigemId: "10002" }) };
    // survivor a, leading = loser, then Enter for lastName, campusId, email (campus equal in this fake still diffed)
    const t = setup(["m", "a", "l", "", "", "", "y"], { persons });
    await runReview(t.deps, t.scan);
    const [p] = patches(t.calls);
    expect((p!.body as Record<string, unknown>).optigemId).toBe("10002");
    const fm = financeMerges(t.store.readAudit());
    expect(fm).toHaveLength(1);
    expect(fm[0]).toMatchObject({ leadingOptigemId: "10002", orphanedOptigemId: "10001" });
  });

  it("marks 'keine Dublette' and writes the relationship back", async () => {
    const t = setup(["n"]);
    const counts = await runReview(t.deps, t.scan);
    expect(counts.dismissed).toBe(1);
    expect(t.calls).toEqual([
      { method: "POST", path: "/persons/1/relationships", body: { otherPersonId: 2, relationshipTypeId: 4 } },
    ]);
    expect(t.scan.candidates[0]!.state).toBe("dismissed");
  });

  it("skips and quits without writing", async () => {
    const t = setup(["q"]);
    await runReview(t.deps, t.scan);
    expect(t.calls).toEqual([]);
  });

  it("hides names and ids under --redact", async () => {
    const t = setup(["q"], {}, true);
    await runReview(t.deps, t.scan);
    expect(t.out.join("\n")).not.toContain("Erika");
  });
});
