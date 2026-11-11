import { afterEach, describe, expect, it } from "vitest";
import { CtApiError } from "../src/api/ctClient.js";
import {
  PairLoadError,
  executeMerge,
  loadPair,
  recoverUnrecordedMerge,
  type ReviewDeps,
} from "../src/dupes/actions.js";
import { financeMerges } from "../src/dupes/finance.js";
import { prepareSharedGroups, type GroupStep } from "../src/dupes/groups.js";
import { optigemOutcome, setChoice } from "../src/dupes/merge-model.js";
import type { DupesClient } from "../src/dupes/ct.js";
import { startReviewServer } from "../src/dupes/web/server.js";
import { cleanDirs, raw, setup } from "./dupes-fixtures.js";

afterEach(cleanDirs);

const both = [{ id: 13, title: "Hauskreis" }];

/** Wraps the fake client: tracks GETs, models removed memberships and an optional merge refusal. */
function wrap(
  base: DupesClient,
  over: { failGet?: (path: string) => number | null; mergeRefusals?: number } = {},
) {
  const gets: string[] = [];
  const removed = new Set<string>();
  let refusals = over.mergeRefusals ?? 0;
  const client = {
    get: async (path: string) => {
      gets.push(path);
      const status = over.failGet?.(path);
      if (status) throw new CtApiError("nope", status, {});
      const res = await base.get<Record<string, unknown>>(path);
      if (/\/merge\/\d+$/.test(path) && removed.size > 0)
        return { ...res, groupsDiff: { ...(res.groupsDiff as object), both: [] } };
      return res;
    },
    getAll: (...a: Parameters<DupesClient["getAll"]>) => {
      gets.push(String(a[0]));
      return base.getAll(...a);
    },
    request: async (method: string, path: string, body?: Parameters<DupesClient["request"]>[2]) => {
      if (method === "DELETE") {
        if (removed.has(path)) throw new CtApiError("gone", 404, {});
        removed.add(path);
      }
      if (method === "PATCH" && /\/merge\//.test(path) && refusals > 0) {
        refusals--;
        throw new CtApiError("forbidden", 403, { messageKey: "error.forbidden.merge-authorized-person" });
      }
      return base.request(method, path, body);
    },
  } as unknown as DupesClient;
  return { client, gets, removed };
}

describe("group clean-up and a refused merge", () => {
  it("re-reads the pair after a refusal so a retry works, and says groups were changed", async () => {
    const t = setup({ both });
    const w = wrap(t.deps.client, { mergeRefusals: 1 });
    const deps: ReviewDeps = { ...t.deps, client: w.client };
    const pair = await loadPair(deps, 1, 2);
    expect(pair.shared.map((g) => g.id)).toEqual([13]);
    const res = await executeMerge(deps, pair, pair.model);
    expect(res).toMatchObject({
      kind: "failed",
      stage: "patch",
      status: 403,
      reason: "error.forbidden.merge-authorized-person",
      groupsDone: [{ groupId: 13 }],
    });
    if (res.kind !== "failed" || !res.fresh) throw new Error("expected a fresh pair");
    expect(res.fresh.shared).toEqual([]);
    const retry = await executeMerge(deps, res.fresh, res.fresh.model);
    expect(retry).toMatchObject({ kind: "merged" });
  });

  it("without a fresh pair, a retry on the stale list still works: a 404 on the Duplikat's DELETE counts as done", async () => {
    const t = setup({ both });
    const w = wrap(t.deps.client, { mergeRefusals: 1 });
    const deps: ReviewDeps = { ...t.deps, client: w.client };
    const pair = await loadPair(deps, 1, 2);
    await executeMerge(deps, pair, pair.model);
    const retry = await executeMerge(deps, pair, pair.model); // stale `shared`
    expect(retry).toMatchObject({ kind: "merged" });
  });

  it("treats 404 on the DELETE as removed, but fails on other statuses", async () => {
    const calls: string[] = [];
    const mk = (status: number): DupesClient =>
      ({
        request: async (m: string, p: string) => {
          calls.push(`${m} ${p}`);
          if (m === "DELETE") throw new CtApiError("x", status, {});
          return {};
        },
      }) as unknown as DupesClient;
    const done: GroupStep[] = [];
    await prepareSharedGroups(mk(404), [{ id: 5, title: "g", dynamic: true, items: [] }], 1, 2, done);
    expect(done).toEqual([{ groupId: 5, dynamic: true, updated: [] }]);
    await expect(
      prepareSharedGroups(mk(500), [{ id: 5, title: "g", dynamic: true, items: [] }], 1, 2, []),
    ).rejects.toThrow();
  });

  it("reports the failed group and whether the Original's membership was already rewritten", async () => {
    const progress: { groupId?: number; patched?: boolean } = {};
    const client = {
      request: async (m: string) => {
        if (m === "DELETE") throw new CtApiError("x", 500, {});
        return {};
      },
    } as unknown as DupesClient;
    const g = {
      id: 7,
      title: "g",
      dynamic: false,
      items: [
        { key: "comment", label: "Kommentar", original: null, duplicate: "x", choice: "duplicate" as const },
      ],
    };
    await expect(prepareSharedGroups(client, [g], 1, 2, [], progress)).rejects.toThrow();
    expect(progress).toEqual({ groupId: 7, patched: true });
  });
});

describe("a 404 while loading a pair", () => {
  it("names the request that failed; only GET /persons/{id} means a person is gone", async () => {
    const preview = setup({ both });
    const dep = (failGet: (p: string) => number | null): ReviewDeps => ({
      ...preview.deps,
      client: wrap(preview.deps.client, { failGet }).client,
    });
    const err = async (d: ReviewDeps): Promise<PairLoadError> =>
      loadPair(d, 1, 2).then(
        () => {
          throw new Error("should fail");
        },
        (e: unknown) => e as PairLoadError,
      );
    const p = await err(dep((x) => (x === "/persons/1/merge/2" ? 404 : null)));
    expect(p).toBeInstanceOf(PairLoadError);
    expect([p.step, p.status, p.personGone]).toEqual(["preview", 404, false]);
    const m = await err(dep((x) => (x === "/groups/13/members/2" ? 404 : null)));
    expect([m.step, m.personGone]).toEqual(["membership", false]);
    const g = await err(dep((x) => (x === "/persons/2" ? 404 : null)));
    expect([g.step, g.personGone]).toEqual(["duplicate", true]);
  });

  it("the server does not call a preview 404 'person gone' and books no recovered merge", async () => {
    const t = setup({ both });
    t.store.audit({ action: "merge-started", survivingId: 1, loserId: 2 }, new Date());
    const deps: ReviewDeps = {
      ...t.deps,
      client: wrap(t.deps.client, { failGet: (x) => (x === "/persons/1/merge/2" ? 404 : null) }).client,
    };
    const srv = await startReviewServer(deps, t.scan, new Map());
    const [base, token] = srv.url.split("/#") as [string, string];
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "X-Ct-Dupes-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ index: 0 }),
    });
    srv.close();
    await srv.closed;
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).toContain("Merge-Vorschau");
    expect(text).not.toContain("existiert nicht mehr");
    expect(t.store.readAudit().some((e) => e.action === "merge-confirmed")).toBe(false);
  });

  it("recovers only when the Duplikat is 404 and the survivor still loads", async () => {
    const t = setup({ gone: [2] });
    t.store.audit({ action: "merge-started", survivingId: 1, loserId: 2 }, new Date());
    expect(await recoverUnrecordedMerge(t.deps, 1, 2)).toBe(true);
    const u = setup({ gone: [1, 2] });
    u.store.audit({ action: "merge-started", survivingId: 1, loserId: 2 }, new Date());
    expect(await recoverUnrecordedMerge(u.deps, 1, 2)).toBe(false);
  });
});

describe("Optigem IDs lost in a merge reach the finance export", () => {
  const opt = (o: string, d: string) => {
    const t = setup({ persons: { 1: raw(1, { optigemId: o }), 2: raw(2, { optigemId: d }) } });
    return { t, pair: loadPair(t.deps, 1, 2) };
  };

  it("cleared field: both IDs orphaned, leading empty", async () => {
    const { t, pair } = opt("10001", "10002");
    const p = await pair;
    const model = setChoice(p.model, "optigemId", "none");
    expect(optigemOutcome(model)).toEqual({ leading: "", orphaned: "10001; 10002" });
    await executeMerge(t.deps, p, model);
    expect(financeMerges(t.store.readAudit())).toMatchObject([
      { leadingOptigemId: "", orphanedOptigemId: "10001; 10002", identicalIds: false },
    ]);
  });

  it("only the Duplikat has an ID and the Original's empty value is kept: that ID is orphaned", async () => {
    const { t, pair } = opt("", "10002");
    const p = await pair;
    const model = setChoice(p.model, "optigemId", "original");
    expect(optigemOutcome(model)).toEqual({ leading: "", orphaned: "10002" });
    await executeMerge(t.deps, p, model);
    expect(financeMerges(t.store.readAudit())).toHaveLength(1);
  });

  it("stays out of the export when no ID existed or nothing was orphaned", async () => {
    const none = opt("", "");
    const p = await none.pair;
    await executeMerge(none.t.deps, p, p.model);
    expect(financeMerges(none.t.store.readAudit())).toEqual([]);
    const lone = opt("", "7");
    const lp = await lone.pair;
    await executeMerge(lone.t.deps, lp, lp.model);
    expect(financeMerges(lone.t.store.readAudit())).toEqual([]);
  });
});

describe("fewer GETs", () => {
  it("loads each person once per pair and the dynamic group ids once per client", async () => {
    const t = setup({ both, dynamicGroupIds: [] });
    const w = wrap(t.deps.client);
    const deps: ReviewDeps = { ...t.deps, client: w.client };
    const pair = await loadPair(deps, 1, 2);
    expect(w.gets.filter((g) => g === "/persons/1")).toHaveLength(1);
    expect(w.gets.filter((g) => g === "/persons/2")).toHaveLength(1);
    await loadPair(deps, 1, 2);
    expect(w.gets.filter((g) => g === "/dynamicgroups")).toHaveLength(1);
    const before = w.gets.length;
    await executeMerge(deps, pair, pair.model);
    // The re-read of the Original right before the write is the only person GET (+1 for the check after).
    expect(w.gets.slice(before).filter((g) => g === "/persons/1")).toHaveLength(1);
  });
});
