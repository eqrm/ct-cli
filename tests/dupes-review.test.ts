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

const person = (id: number, optigem: string) => ({
  id,
  firstName: "Erika",
  lastName: "Muster",
  birthday: "1990-05-05",
  optigemId: optigem,
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Fake CT: persons 1 and 2 share a dynamic group (10) and a static group (20) with a field conflict. */
function fakeClient(calls: Call[], gone: Set<number>): DupesClient {
  const member = (value: string) => ({
    group: { title: "Static", domainIdentifier: "20" },
    groupTypeRoleId: 3,
    groupMemberStatus: "active",
    comment: null,
    fields: [{ id: 7, name: "Tribe", value }],
  });
  return {
    get: async (path: string) => {
      if (path === "/persons/1") return person(1, "10001");
      if (path === "/persons/2") {
        if (gone.has(2)) throw new CtApiError("gone", 404, {});
        return person(2, "10002");
      }
      if (path === "/groups/20/members/1") return member("A");
      if (path === "/groups/20/members/2") return member("B");
      if (path === "/persons/1/relationships") return [];
      throw new Error(`unexpected GET ${path}`);
    },
    getAll: async (path: string) => {
      if (path === "/dynamicgroups") return { data: [10] };
      if (path === "/persons/1/groups" || path === "/persons/2/groups")
        return {
          data: [
            { group: { title: "Auto group", domainIdentifier: "10" } },
            { group: { title: "Static group", domainIdentifier: "20" } },
          ],
        };
      throw new Error(`unexpected getAll ${path}`);
    },
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      // Once the pair is tagged, the operator "merges" in the browser: the loser disappears.
      if (
        method === "POST" &&
        path === "/persons/1/relationships" &&
        (body as { relationshipTypeId: number }).relationshipTypeId === 7
      )
        gone.add(2);
      return {};
    },
  } as unknown as DupesClient;
}

function setup(answers: string[], gone = new Set<number>(), redact = false) {
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
  const opened: string[] = [];
  const queue = [...answers];
  const io: ReviewIO = {
    ask: async () => {
      const a = queue.shift();
      if (a === undefined) throw new Error("script exhausted");
      return a;
    },
    print: (l) => out.push(l),
    openUrl: async (u) => {
      opened.push(u);
    },
  };
  const calls: Call[] = [];
  const deps = {
    client: fakeClient(calls, gone),
    store,
    host: "https://example.church.tools",
    redactor: makeRedactor(redact, "secret"),
    optigemField: "optigemId",
    types: { noDuplicate: 4, duplicate: 7 },
    operator: { id: 99, name: "Op Erator" },
    io,
    mergeUrl: "{host}/persons/duplicates",
    now: () => new Date("2026-02-01T10:00:00.000Z"),
  };
  return { deps, scan, store, out, opened, calls };
}

describe("review loop", () => {
  it("merges: drops dynamic, merges static per field, tags Dublette, opens the page, logs", async () => {
    // keep a, leading ID survivor, choose loser's value for the conflicting field, proceed, finished
    const t = setup(["m", "a", "s", "l", "y", "y"]);
    const counts = await runReview(t.deps, t.scan);
    expect(counts.merged).toBe(1);
    expect(t.calls).toEqual([
      { method: "DELETE", path: "/groups/10/members/2", body: undefined },
      { method: "PATCH", path: "/groups/20/members/1", body: { fields: { "7": "B" } } },
      { method: "DELETE", path: "/groups/20/members/2", body: undefined },
      { method: "POST", path: "/persons/1/relationships", body: { otherPersonId: 2, relationshipTypeId: 7 } },
    ]);
    expect(t.opened).toEqual(["https://example.church.tools/persons/duplicates"]);
    const text = t.out.join("\n");
    expect(text).toContain("[dynamic] Auto group (id 10)");
    expect(text).toContain("[static]  Static group (id 20)");
    expect(text).toContain("https://example.church.tools/persons/duplicates");
    expect(text).toContain('tab "Dublette"');
    const audit = t.store.readAudit().map((e) => e.action);
    expect(audit).toEqual([
      "merge-started",
      "dynamic-group-removal",
      "static-group-merge",
      "duplicate-tagged",
      "merge-confirmed",
    ]);
    expect(financeMerges(t.store.readAudit())).toHaveLength(1);
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
    expect(t.opened).toEqual([]);
  });

  it("hides names, ids and the URL under --redact", async () => {
    const t = setup(["q"], new Set(), true);
    await runReview(t.deps, t.scan);
    const text = t.out.join("\n");
    expect(text).not.toContain("Erika");
    expect(text).not.toContain("Auto group");
  });
});
