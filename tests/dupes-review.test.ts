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
  /** Replaces the canned personDiff. */
  personDiff?: unknown[];
  previewFails?: boolean;
  /** The PATCH answers 500 but the duplicate is gone afterwards. */
  goneAfterError?: boolean;
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
      if (/^\/persons\/\d+\/merge\/\d+$/.test(path)) {
        if (opts.previewFails) throw new CtApiError("nope", 500, {});
        return {
          personDiff: opts.personDiff ?? [
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
        if (opts.patchFails) {
          if (opts.goneAfterError) state.merged = true;
          throw new CtApiError("boom", 500, {});
        }
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
    expect(p!.body).toEqual({
      ...raw(1),
      emails: [...raw(1).emails, { email: "p2@example.org", isDefault: true }],
    });
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
      emails: [
        { email: "p1@example.org", isDefault: false },
        { email: "p2@example.org", isDefault: true },
      ],
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

  it("unions emails when the duplicate's address is chosen (no id, default, email key set)", async () => {
    const persons = {
      1: raw(1, {
        email: "a@example.org",
        emails: [
          { id: 1, email: "a@example.org", isDefault: true },
          { id: 2, email: "a2@example.org", isDefault: false },
        ],
      }),
      2: raw(2, { emails: [{ id: 9, email: "B@example.org", isDefault: true }] }),
    };
    const personDiff = [
      { key: "email", name: "Email", old: "a@example.org", new: "b@example.org", printDiff: true },
    ];
    const t = setup(["m", "", "o", "y"], { persons, personDiff });
    await runReview(t.deps, t.scan);
    const body = patches(t.calls)[0]!.body as Record<string, unknown>;
    expect(body.emails).toEqual([
      { id: 1, email: "a@example.org", isDefault: false },
      { id: 2, email: "a2@example.org", isDefault: false },
      { email: "B@example.org", isDefault: true },
    ]);
    expect(body.email).toBe("B@example.org");
  });

  it("keeps the original's default but still adds the duplicate's address", async () => {
    const persons = {
      1: raw(1, {
        emails: [
          { id: 1, email: "a@example.org", isDefault: true },
          { id: 2, email: "a2@example.org", isDefault: false },
        ],
      }),
      2: raw(2, { emails: [{ id: 9, email: "b@example.org", isDefault: true }] }),
    };
    const personDiff = [
      { key: "email", name: "Email", old: "a@example.org", new: "b@example.org", printDiff: true },
    ];
    const t = setup(["m", "", "s", "y"], { persons, personDiff });
    await runReview(t.deps, t.scan);
    const body = patches(t.calls)[0]!.body as Record<string, unknown>;
    expect(body.emails).toEqual([
      { id: 1, email: "a@example.org", isDefault: true },
      { id: 2, email: "a2@example.org", isDefault: false },
      { email: "b@example.org", isDefault: true },
    ]);
    expect(body).not.toHaveProperty("email");
  });

  it("defaults to the non-empty side when the survivor's value is empty", async () => {
    const persons = { 1: raw(1, { mobile: "" }), 2: raw(2, { mobile: "0151" }) };
    const personDiff = [{ key: "mobile", name: "Mobile", old: "", new: "0151", printDiff: true }];
    const t = setup(["m", "", "", "y"], { persons, personDiff });
    await runReview(t.deps, t.scan);
    expect(t.questions.some((q) => q.includes("[Enter = o]"))).toBe(true);
    expect((patches(t.calls)[0]!.body as Record<string, unknown>).mobile).toBe("0151");
  });

  it("skips a chosen field the duplicate object lacks and warns", async () => {
    const personDiff = [{ key: "nickname", name: "Nickname", old: "", new: "Eri", printDiff: true }];
    const t = setup(["m", "", "", "y"], { personDiff });
    await runReview(t.deps, t.scan);
    expect(patches(t.calls)[0]!.body).not.toHaveProperty("nickname");
    expect(t.out.join("\n")).toContain("Nickname: value cannot be carried over automatically");
  });

  it("keeps a lone Optigem ID and records it as leading without finance export", async () => {
    const persons = { 1: raw(1), 2: raw(2, { optigemId: "10002" }) };
    const personDiff = [{ key: "optigemId", name: "Optigem", old: "", new: "10002", printDiff: true }];
    const t = setup(["m", "", "y"], { persons, personDiff });
    await runReview(t.deps, t.scan);
    expect((patches(t.calls)[0]!.body as Record<string, unknown>).optigemId).toBe("10002");
    expect(t.store.readAudit().at(-1)).toMatchObject({ leadingOptigemId: "10002", orphanedOptigemId: "" });
    expect(financeMerges(t.store.readAudit())).toEqual([]);
  });

  it("does not prompt for an Optigem diff when both have IDs", async () => {
    const persons = { 1: raw(1, { optigemId: "1" }), 2: raw(2, { optigemId: "2" }) };
    const personDiff = [{ key: "optigemId", name: "Optigem", old: "1", new: "2", printDiff: true }];
    const t = setup(["m", "", "s", "y"], { persons, personDiff });
    await runReview(t.deps, t.scan);
    expect(t.questions.filter((q) => q.includes("Optigem:"))).toEqual([]);
    expect((patches(t.calls)[0]!.body as Record<string, unknown>).optigemId).toBe("1");
  });

  it("merges the other way when b is chosen", async () => {
    const t = setup(["m", "b", "", "", "", "y"]);
    await runReview(t.deps, t.scan);
    const [p] = patches(t.calls);
    expect(p!.path).toBe("/persons/2/merge/1");
    expect(t.store.readAudit().at(-1)).toMatchObject({ survivingId: 2, loserId: 1 });
  });

  it("returns pending when the merge preview cannot be loaded", async () => {
    const t = setup(["m", ""], { previewFails: true });
    const counts = await runReview(t.deps, t.scan);
    expect(counts.pending).toBe(1);
    expect(patches(t.calls)).toEqual([]);
    expect(t.out.join("\n")).toContain("Could not load the merge preview (HTTP 500)");
  });

  it("records the merge when the PATCH errors but the duplicate is gone", async () => {
    const t = setup(["m", "", "", "", "", "y"], { patchFails: true, goneAfterError: true });
    const counts = await runReview(t.deps, t.scan);
    expect(counts.merged).toBe(1);
    expect(t.store.readAudit().at(-1)).toMatchObject({ action: "merge-confirmed", afterError: true });
  });

  it("recovers an unrecorded merge at the next review start", async () => {
    // First run: PATCH errors, the duplicate still exists -> pending.
    const t = setup(["m", "", "", "", "", "y"], { patchFails: true });
    await runReview(t.deps, t.scan);
    expect(t.store.readAudit().some((e) => e.action === "merge-confirmed")).toBe(false);
    // Later the duplicate is gone (merge went through server-side).
    const state = { merged: true };
    const calls: Call[] = [];
    const deps = { ...t.deps, client: fakeClient(calls, {}, state) };
    const counts = await runReview(deps, t.scan);
    expect(counts.merged).toBe(1);
    expect(t.store.readAudit().at(-1)).toMatchObject({ action: "merge-confirmed", recovered: true });
  });
});
