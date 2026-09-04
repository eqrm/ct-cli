/**
 * End-to-end coverage for portable logical references (#20): the resolver wired through buildPlan,
 * apply-time pending re-resolution in executePlan, permission domainId resolution, and the headline
 * acceptance test — one config yielding valid plans against two different hosts (states + catalogs).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateConfig, q, churchQuery, ref } from "../src/config/context.js";
import { buildPlan } from "../src/engine/build.js";
import { executePlan } from "../src/engine/execute.js";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { Resolver } from "../src/resolve/resolver.js";
import { renderPlan } from "../src/engine/render.js";
import { CtApiError } from "../src/api/ctClient.js";
import { emptyState, type State } from "../src/state/state.js";

/** Fake client serving catalog/item GETs and recording write requests, returning canned POST ids. */
function fakeHost(catalogs: Record<string, unknown>, postIds: Record<string, number> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    get: async <T>(path: string): Promise<T> => {
      if (!(path in catalogs)) throw new CtApiError(`not found: ${path}`, 404, null);
      return catalogs[path] as T;
    },
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const id = postIds[`${method} ${path}`];
      return (id !== undefined ? { id } : {}) as T;
    },
  };
}

const noSave = async (): Promise<void> => {};

describe("buildPlan reference resolution", () => {
  it("resolves a bound external groupType ref to a number so the diff stays number↔number", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.group({ key: "kids", name: "Kids", groupType: "ministry_team" });
    });
    const state = emptyState("h");
    state.externals!.ministry_team = {
      type: "group-type",
      key: "ministry_team",
      id: 2,
      identity: { name: "Ministry Team" },
      boundAt: "t",
    };
    const client = fakeHost({ "/group/grouptypes/2": { id: 2, name: "Ministry Team" } });
    const { plan } = await buildPlan(client, state, resources);
    const item = plan.items.find((i) => i.key === "kids")!;
    expect(item.action).toBe("create");
    expect(item.changes).toContainEqual({ field: "groupTypeId", from: undefined, to: 2, source: "config" });
  });

  it("renders a same-run campus reference as a pending marker", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
      ct.group({ key: "kids", name: "Kids", groupTypeId: 2, campus: "mainz" });
    });
    const client = fakeHost({});
    const { plan } = await buildPlan(client, emptyState("h"), resources);
    const rendered = renderPlan(plan);
    expect(rendered).toContain("campusId: <campus:mainz (created this apply)>");
  });

  it("throws a config error (not a fetchError) on an unresolvable reference", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.group({ key: "kids", name: "Kids", groupType: "ghost_type" });
    });
    const client = fakeHost({ "/group/grouptypes": [{ id: 2, name: "Ministry Team" }] });
    await expect(buildPlan(client, emptyState("h"), resources)).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING", type: "group-type", key: "ghost_type" },
    });
  });
});

describe("apply-time pending re-resolution (same-run campus + group)", () => {
  it("carries the freshly-created campus id into the group's POST body", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
      ct.group({ key: "kids", name: "Kids", groupTypeId: 2, campus: "mainz" });
    });
    const state = emptyState("h");
    const host = fakeHost({}, { "POST /campuses": 42, "POST /groups": 100 });
    const { plan } = await buildPlan(host, state, resources);

    await executePlan(plan, { client: host, state, statePath: "s.json", save: noSave, now: () => "t" });

    const campusPost = host.calls.find((c) => c.path === "/campuses")!;
    expect(campusPost.method).toBe("POST");
    const groupPost = host.calls.find((c) => c.path === "/groups")!;
    // The group POST body carries the campus's freshly created id (42), not the pending sentinel.
    expect(groupPost.body).toEqual({ name: "Kids", groupTypeId: 2, campusId: 42 });
    // State records the resolved id too (no pending marker leaks into state).
    expect(state.resources.kids?.fields).toMatchObject({ campusId: 42 });
  });

  it("resolves a same-run ref embedded in a dynamic ruleset before the ruleset PUT", async () => {
    // The dynamic group is already managed (a fresh dynamic group is a two-apply flow); the campus it
    // filters on is added to the config now, so its ruleset ref is same-run pending until apply time.
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
      ct.group({
        key: "all_mainz",
        name: "All",
        groupTypeId: 1,
        dynamic: {
          status: "manual",
          ruleset: { query: churchQuery(q.eq("ctgroup.campusId", ref.campus("mainz"))) },
        },
      });
    });
    const state = emptyState("h");
    state.resources.all_mainz = {
      type: "group",
      id: 100,
      key: "all_mainz",
      fields: { name: "All", groupTypeId: 1 },
      adoptedAt: "t",
      updatedAt: "t",
    };
    // /groups/100 fetches clean; its ruleset 404s (not yet a dynamic group) → the manual ruleset is a change.
    const host = fakeHost({ "/groups/100": { name: "All", groupTypeId: 1 } }, { "POST /campuses": 42 });
    const { plan } = await buildPlan(host, state, resources);
    await executePlan(plan, { client: host, state, statePath: "s.json", save: noSave, now: () => "t" });

    const rulesetPut = host.calls.find((c) => c.path === "/dynamicgroups/100/ruleset" && c.method === "PUT")!;
    // PUT envelope: { dynamicGroupRuleSet: [ruleset] } (live-decoded, #77).
    const body = rulesetPut.body as {
      dynamicGroupRuleSet: [{ query: { params: { filter: { "==": unknown[] } } } }];
    };
    // The campus ref, pending at plan time, is the freshly-created id (42) in the PUT — not a sentinel.
    expect(body.dynamicGroupRuleSet[0].query.params.filter["=="][1]).toBe(42);
  });

  it("orders a same-tier pending ref target before its referencer (group → ref.group)", async () => {
    // PR #46 review finding: both groups are tier 1, and the referencer is declared FIRST.
    // Declaration order alone would apply "all_kids" before "b_target" and the pending id could
    // never resolve — the injected dependency edge must put the target first.
    const { resources } = await evaluateConfig((ct) => {
      ct.group({
        key: "all_kids",
        name: "All Kids",
        groupTypeId: 1,
        dynamic: {
          status: "manual",
          ruleset: { query: churchQuery(q.eq("ctgroup.parentId", ref.group("b_target"))) },
        },
      });
      ct.group({ key: "b_target", name: "Target", groupTypeId: 1 });
    });
    const state = emptyState("h");
    state.resources.all_kids = {
      type: "group",
      id: 100,
      key: "all_kids",
      fields: { name: "All Kids", groupTypeId: 1 },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const host = fakeHost({ "/groups/100": { name: "All Kids", groupTypeId: 1 } }, { "POST /groups": 55 });
    const { plan } = await buildPlan(host, state, resources);
    await executePlan(plan, { client: host, state, statePath: "s.json", save: noSave, now: () => "t" });

    const createIdx = host.calls.findIndex((c) => c.method === "POST" && c.path === "/groups");
    const putIdx = host.calls.findIndex((c) => c.method === "PUT" && c.path === "/dynamicgroups/100/ruleset");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(createIdx); // target created before the referencing ruleset writes
    const body = host.calls[putIdx]!.body as {
      dynamicGroupRuleSet: [{ query: { params: { filter: { "==": unknown[] } } } }];
    };
    expect(body.dynamicGroupRuleSet[0].query.params.filter["=="][1]).toBe(55); // the fresh id, not a sentinel
  });
});

describe("permission domainId resolution", () => {
  it("resolves a groupType ref to the domainId and diffs against it", async () => {
    const { permissions } = await evaluateConfig((ct) => {
      ct.groupTypeRole({ key: "tpl", groupType: "ministry_team", grants: ["churchgroup:administer groups"] });
    });
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/group/grouptypes/9") return { id: 9, name: "Ministry Team" } as T;
        if (path === "/permissions/group_type_role") return [] as T;
        throw new CtApiError(`not found: ${path}`, 404, null);
      },
    };
    const state = emptyState("h");
    state.externals!.ministry_team = {
      type: "group-type",
      key: "ministry_team",
      id: 9,
      identity: { name: "Ministry Team" },
      boundAt: "t",
    };
    const { items } = await buildPermissionPlan(client, state, permissions);
    expect(items).toHaveLength(1);
    expect(items[0]?.domainId).toBe(9); // resolved from the catalog, not a raw number
  });

  it("rejects two permissions whose refs resolve to the same domainId (post-resolution guard)", async () => {
    const { permissions } = await evaluateConfig((ct) => {
      ct.groupTypeRole({ key: "a", groupType: "ministry_team", grants: ["churchgroup:administer groups"] });
      ct.groupTypeRole({ key: "b", id: 9, grants: ["churchgroup:administer groups"] });
    });
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/group/grouptypes/9") return { id: 9, name: "Ministry Team" } as T;
        if (path === "/permissions/group_type_role") return [] as T;
        throw new CtApiError(`not found: ${path}`, 404, null);
      },
    };
    const state = emptyState("h");
    state.externals!.ministry_team = {
      type: "group-type",
      key: "ministry_team",
      id: 9,
      identity: { name: "Ministry Team" },
      boundAt: "t",
    };
    await expect(buildPermissionPlan(client, state, permissions)).rejects.toThrow(
      /Duplicate permission target after resolution: group_type_role #9/,
    );
  });

  it("resolves a group_role (group, role) reference to the pairing domainId at plan time (#25)", async () => {
    const { permissions } = await evaluateConfig((ct) => {
      ct.groupRole({ key: "p", group: "kids", role: "Leiter", grants: ["churchgroup:administer groups"] });
    });
    const state: State = {
      ...emptyState("h"),
      resources: {
        kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/groups/42/roles") return [{ id: 7001, name: "Leiter" }] as T;
        if (path === "/permissions/group_role") return [] as T;
        throw new CtApiError(`not found: ${path}`, 404, null);
      },
    };
    const { items } = await buildPermissionPlan(client, state, permissions);
    expect(items[0]?.domainId).toBe(7001);
    // No live grant yet → the one declared grant is proposed to add (churchgroup:administer groups, unscoped).
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1113, dataId: [], type: "grant" }]);
  });

  it("carries a group_role reference to a not-yet-created group as a PENDING domain (#106)", async () => {
    // Was a hard error until #106. The pairing id only exists once the group does, so the domain plans
    // pending and is completed with a live /groups/{id}/roles fetch inside applyPermissionPlan —
    // which is what makes this config plannable on a fresh host as well as on one where it exists.
    const { permissions } = await evaluateConfig((ct) => {
      ct.group({ key: "kids", name: "Kids", groupTypeId: 2 });
      ct.groupRole({ key: "p", group: "kids", role: "Leiter", grants: ["churchgroup:administer groups"] });
    });
    const client = { get: async <T>(): Promise<T> => [] as T };
    // `desired` includes the same-run group, so the resolver knows it is declared-but-pending.
    const desired = [{ type: "group", key: "kids", fields: {}, dependsOn: [] }];
    const { items } = await buildPermissionPlan(client, emptyState("h"), permissions, desired);
    expect(items[0]?.domainId).toBeNull();
    expect(items[0]?.pendingDomain).toEqual(ref.groupRole("kids", "Leiter"));
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1113, dataId: [], type: "grant" }]);
  });
});

describe("acceptance: one config, two hosts", () => {
  /** The identical config module — no numeric ids anywhere the resolver can fill in per host. */
  const config = (ct: Parameters<Parameters<typeof evaluateConfig>[0]>[0]): void => {
    ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
    ct.group({ key: "kids", name: "Kids", groupType: "ministry_team", campus: "mainz" });
    ct.groupTypeRole({
      key: "tpl",
      groupType: "ministry_team",
      grants: [{ right: "churchgroup:view group", scope: ["kids"] }],
    });
  };

  async function planFor(groupTypeId: number, state: State) {
    const { resources, permissions } = await evaluateConfig(config);
    const catalogs = {
      [`/group/grouptypes/${groupTypeId}`]: { id: groupTypeId, name: "Ministry Team" },
      "/permissions/group_type_role": [],
    };
    state.externals!.ministry_team = {
      type: "group-type",
      key: "ministry_team",
      id: groupTypeId,
      identity: { name: "Ministry Team" },
      boundAt: "t",
    };
    const client = fakeHost(catalogs);
    const resolver = new Resolver({ client, state, desired: resources, host: state.host });
    const { plan } = await buildPlan(client, state, resources, { resolver });
    const { items } = await buildPermissionPlan(client, state, permissions, resources, resolver);
    return { plan, items };
  }

  it("produces valid, host-specific plans against two different catalogs without editing the config", async () => {
    // Host A: group type id 2. Host B: the SAME group type named differently in the catalog → id 77.
    const a = await planFor(2, emptyState("https://a.church.tools"));
    const b = await planFor(77, emptyState("https://b.church.tools"));

    const groupOf = (p: typeof a.plan) => p.items.find((i) => i.key === "kids")!;
    expect(groupOf(a.plan).changes).toContainEqual({
      field: "groupTypeId",
      from: undefined,
      to: 2,
      source: "config",
    });
    expect(groupOf(b.plan).changes).toContainEqual({
      field: "groupTypeId",
      from: undefined,
      to: 77,
      source: "config",
    });

    // Permission domainId is resolved per host from the same logical ref.
    expect(a.items[0]?.domainId).toBe(2);
    expect(b.items[0]?.domainId).toBe(77);

    // Both plans create the campus + group (2 creates each) — the config is valid against both hosts.
    expect(a.plan.items.filter((i) => i.action === "create")).toHaveLength(2);
    expect(b.plan.items.filter((i) => i.action === "create")).toHaveLength(2);
  });
});

describe("portable ruleset snapshot files (#76)", () => {
  // The existing coverage above proves a logical ref resolves per-host when the ruleset is authored
  // INLINE (a `churchQuery(...)` build in the config module). #76 is about the OTHER supply form: a
  // captured `{ ref: "./rulesets/<key>.json" }` snapshot FILE. Adopted snapshots come out of CT as
  // byte-faithful JSON with that instance's raw numeric ids baked into the query — not portable.
  //
  // The portable form replaces an entity id in a query `var` position with a logical `{__ctRef}`
  // marker (exactly what `ref.campus("mainz")` serialises to as JSON). These tests pin two properties
  // the eventual #76 tooling depends on, so a future refactor of the resolution/normalization pass
  // can't silently regress them:
  //   1. a marker embedded in a ruleset FILE resolves to each host's id at plan time, and
  //   2. once resolved, the ruleset diffs BYTE-FAITHFULLY against CT — a matching instance is a no-op.
  const dir = mkdtempSync(join(tmpdir(), "ct-portable-rs-"));
  const rulesetFile = "portable.json";
  // A campus id expressed as a logical marker instead of a raw instance-specific number. JSON.stringify
  // of `ref.campus("mainz")` is `{"__ctRef":true,"kind":"campus","key":"mainz"}` — a plain, hand-editable
  // JSON leaf that `isRef` recognises when the file is parsed back in.
  const authoredRuleset = {
    description: "Auto members in Mainz",
    importance: 0,
    personIdFieldName: "person.id",
    query: churchQuery(q.eq("ctgroup.campusId", ref.campus("mainz"))),
    process: {},
  };
  writeFileSync(join(dir, rulesetFile), JSON.stringify(authoredRuleset));

  /** State with the managed dynamic group plus this host's explicit external campus binding. */
  function stateWithGroup(host: string): State {
    const s = emptyState(host);
    s.resources.all_mainz = {
      type: "group",
      id: 100,
      key: "all_mainz",
      fields: { name: "All", groupTypeId: 1 },
      adoptedAt: "t",
      updatedAt: "t",
    };
    s.externals!.mainz = {
      type: "campus",
      id: host.includes("dev") ? 42 : 7,
      key: "mainz",
      identity: { name: "Mainz" },
      boundAt: "t",
    };
    return s;
  }

  async function config() {
    return (
      await evaluateConfig((ct) => {
        ct.group({
          key: "all_mainz",
          name: "All",
          groupTypeId: 1,
          dynamic: { status: "manual", ruleset: { ref: `./${rulesetFile}` } },
        });
      })
    ).resources;
  }

  it("resolves the file's marker to each host's campus id in the ruleset PUT (dev vs prod)", async () => {
    // Same config + same snapshot file, two instances whose "Mainz" campus has a different id.
    for (const [host, campusId] of [
      ["https://dev.church.tools", 42],
      ["https://prod.church.tools", 7],
    ] as const) {
      const resources = await config();
      const state = stateWithGroup(host);
      // `/campuses` catalog gives this host's Mainz id; the group's ruleset 404s (not yet a dynamic
      // group) so the manual ruleset is a create → a PUT on apply, whose body we can inspect.
      const client = fakeHost({
        "/groups/100": { name: "All", groupTypeId: 1 },
        [`/campuses/${campusId}`]: { id: campusId, name: "Mainz" },
      });
      const { plan } = await buildPlan(client, state, resources, { configDir: dir });
      await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: () => "t" });

      const put = client.calls.find((c) => c.method === "PUT" && c.path === "/dynamicgroups/100/ruleset")!;
      const body = put.body as {
        dynamicGroupRuleSet: [{ query: { params: { filter: { "==": unknown[] } } } }];
      };
      // The marker became THIS host's campus id — not a leaked `{__ctRef}` sentinel, not the other host's id.
      expect(body.dynamicGroupRuleSet[0].query.params.filter["=="][1]).toBe(campusId);
    }
  });

  it("is a byte-faithful no-op when CT already holds the ruleset with the resolved id", async () => {
    const campusId = 42;
    const resources = await config();
    const state = stateWithGroup("https://dev.church.tools");
    // CT's live ruleset already filters on the resolved campus id (42) — what a prior apply wrote.
    // GET returns the single-element `[RuleSet]` array with read-only timestamps CT adds.
    const liveRuleset = {
      description: "Auto members in Mainz",
      importance: 0,
      personIdFieldName: "person.id",
      query: churchQuery(q.eq("ctgroup.campusId", campusId)),
      process: {},
      dynamicGroupUpdateStarted: "2026-07-10T00:00:00Z",
      dynamicGroupUpdateFinished: "2026-07-10T00:01:00Z",
    };
    const client = fakeHost({
      "/groups/100": { name: "All", groupTypeId: 1 },
      [`/campuses/${campusId}`]: { id: campusId, name: "Mainz" },
      "/dynamicgroups/100/ruleset": [liveRuleset],
      "/dynamicgroups/100/status": { dynamicGroupStatus: "manual" },
    });
    const { plan, fetchErrors } = await buildPlan(client, state, resources, { configDir: dir });

    expect(fetchErrors).toEqual([]);
    const item = plan.items.find((i) => i.key === "all_mainz")!;
    // The desired ruleset (marker → 42, normalized) equals CT's stored ruleset (timestamps stripped),
    // so there is no `dynamic` change and the whole group item is a no-op — the resolved logical form
    // diffs byte-faithfully, exactly what a portable snapshot needs to not re-PUT on every apply.
    expect(item.action).toBe("no-op");
    expect(item.changes.some((c) => c.field === "dynamic")).toBe(false);
  });
});
