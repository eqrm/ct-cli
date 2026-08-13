/**
 * Typed logical scope refs (#98) — a grant scoped by a NON-group dimension declared portably.
 *
 * The motivating failure: campus ids are host-specific (eqrm dev Koblenz ≠ prod Koblenz), so a
 * campus-scoped grant written as a numeric literal is a cross-environment misgrant — and because
 * declaring a domain makes `ct` OWN it, the wrong-scope grant also revokes whatever is really there
 * on the other host. These tests pin the portable form, the dimension guard, and the failure modes.
 */
import { describe, it, expect, vi } from "vitest";
import { buildPermissionPlan, desiredTuples } from "../src/permissions/plan.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { resolveScope, resolveScopeRefs, reresolveTuple } from "../src/permissions/scope.js";
import { executePlan } from "../src/engine/execute.js";
import { Resolver } from "../src/resolve/resolver.js";
import { ref } from "../src/resolve/refs.js";
import { createContext } from "../src/config/context.js";
import { emptyState, type State } from "../src/state/state.js";
import type { DesiredPermission } from "../src/permissions/types.js";
import type { DesiredResource, Plan } from "../src/engine/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const HOST = "https://mychurch.church.tools";

/** `churchdb:view station` — authId 124, scoped by `cdb_station` (campuses). The #98 motivating right. */
const VIEW_STATION = "churchdb:view station";

/** A campus-scoped grant, declared with a logical ref — the exact shape ct-structure needs. */
const campusScoped: DesiredPermission = {
  key: "koblenz_grants",
  domainType: "group_role",
  domainId: 900,
  grants: [{ right: VIEW_STATION, scope: [ref.campus("koblenz")] }],
};

/** State with campus "koblenz" managed at `id` — the same logical config, a different host. */
function stateWithKoblenz(id: number): State {
  return {
    version: 1,
    host: HOST,
    resources: {
      koblenz: { type: "campus", id, key: "koblenz", fields: { name: "Koblenz" }, adoptedAt: "t", updatedAt: "t" },
    },
  };
}

/** A client whose `/permissions/*` reads are empty and whose `/campuses` catalog is host-specific. */
function mockClient(campuses: { id: number; name: string }[] = [], newId = 555) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const get = vi.fn(async (path: string) => (path === "/campuses" ? campuses : []));
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/campuses") return { id: newId };
    return {};
  });
  return { client: { get, request } as unknown as CtClient, calls, get };
}

async function tuplesFor(perm: DesiredPermission, state: State, desired: DesiredResource[] = [], client?: CtClient) {
  const c = client ?? mockClient().client;
  const resolver = new Resolver({ client: c, state, desired });
  const refs = await resolveScopeRefs([perm], resolver, state);
  return desiredTuples(perm, state, new Set(desired.filter((r) => r.type === "group").map((r) => r.key)), refs);
}

describe("campus-scoped grants are portable across hosts (#98)", () => {
  it("resolves one config to each host's own campus id — no numeric literal anywhere", async () => {
    // Same DesiredPermission object, two hosts whose Koblenz campus carries a different id.
    const dev = await tuplesFor(campusScoped, stateWithKoblenz(6));
    const prod = await tuplesFor(campusScoped, stateWithKoblenz(23));

    expect(dev).toEqual([{ authId: 124, dataId: [6], type: "grant", scopeKey: "koblenz", scopeType: "campus" }]);
    expect(prod).toEqual([{ authId: 124, dataId: [23], type: "grant", scopeKey: "koblenz", scopeType: "campus" }]);
  });

  it("plans to a clean no-op against each host's live rows", async () => {
    for (const id of [6, 23]) {
      const state = stateWithKoblenz(id);
      const live = [{ domainType: "group_role", domainId: 900, authId: 124, dataId: id, type: "grant", meta: { modifiedPid: 5 } }];
      const client = { get: vi.fn(async (path: string) => (path === "/campuses" ? [] : live)) };
      const { items, fetchErrors } = await buildPermissionPlan(client as never, state, [campusScoped]);
      expect(fetchErrors).toEqual([]);
      expect(items[0]?.diff.toPut).toEqual([]);
      expect(items[0]?.diff.toDelete).toEqual([]);
    }
  });

  it("falls back to the live /campuses catalog for a campus this config does not manage", async () => {
    // Not in state → resolved by name against the host's catalog. The id is already host-correct, so
    // there is no managed identity to re-resolve at apply time and the tuple keeps no scopeKey.
    const { client } = mockClient([{ id: 23, name: "Koblenz" }]);
    const tuples = await tuplesFor(campusScoped, emptyState(HOST), [], client);
    expect(tuples).toEqual([{ authId: 124, dataId: [23], type: "grant" }]);
  });

  it("a campus created in the same run is pending at plan time and gets its real id at apply time", async () => {
    const desired: DesiredResource[] = [{ type: "campus", key: "koblenz", fields: { name: "Koblenz", shorty: "KO" }, dependsOn: [] }];
    const { client, calls } = mockClient([], 555);
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [campusScoped], desired);
    expect(items[0]?.diff.toPut).toEqual([
      { authId: 124, dataId: [], type: "grant", scopeKey: "koblenz", scopeType: "campus", pending: true },
    ]);

    const createCampus: Plan = {
      items: [{ type: "campus", key: "koblenz", id: null, action: "create", changes: [{ field: "name", from: undefined, to: "Koblenz" }] }],
    };
    await executePlan(createCampus, { client, state, statePath: "unused", save: async () => {} });
    expect(state.resources.koblenz?.id).toBe(555);

    const res = await applyPermissionPlan(items, client, state);
    expect(res.granted).toBe(1);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/permissions/group_role/900");
    expect(put?.body).toEqual({ authId: 124, type: "grant", dataId: [555] });
  });
});

describe("scope-dimension validation (#98)", () => {
  const resolverFor = (state: State) => new Resolver({ client: mockClient().client, state, desired: [] });

  it("rejects a ref whose dimension does not match the right's scopeField, naming both", async () => {
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      // churchdb:view station scopes by cdb_station (campus) — a group-type ref there is a config bug.
      grants: [{ right: VIEW_STATION, scope: [ref.groupType("struktur")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /group-type:struktur.*"cdb_station".*takes a campus reference/s,
    );
  });

  it("rejects a ref on a dimension with no logical form at all, naming the ref and the dimension", async () => {
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      // churchdb:security level person scopes by cc_securitylevel — security levels are not resources.
      grants: [{ right: "churchdb:security level person", scope: [ref.campus("koblenz")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /campus:koblenz.*cc_securitylevel.*no logical reference form/s,
    );
  });

  it("rejects a logical ref on a dimension that has no logical form, pointing at the numeric hatch", async () => {
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      // ccm_data_category: its values are not resources at all — numbers only, by nature.
      grants: [{ right: "jpmFlowManagerPreview:view custom category", scope: [ref.campus("x")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /ccm_data_category.*no logical reference form.*numeric dataId/s,
    );
  });

  it("rejects a logical ref on an unscoped right", async () => {
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      grants: [{ right: "churchcore:administer settings", scope: [ref.campus("koblenz")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /takes no scope/,
    );
  });

  it("rejects a BARE STRING scope on a non-group dimension — it would silently grant on groups", async () => {
    // Before #98 this was the trap: "koblenz" was looked up among managed GROUPS regardless of the
    // right's dimension, so it either errored confusingly or matched an unrelated same-keyed group.
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      grants: [{ right: VIEW_STATION, scope: ["koblenz"] }],
    };
    const state = stateWithKoblenz(6);
    await expect(tuplesFor(perm, state)).rejects.toThrow(/bare string.*scopes by "cdb_station".*\{ campus: "koblenz" \}/s);
  });

  it("a ref that cannot resolve is a hard error, never a dropped or guessed dataId", async () => {
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      grants: [{ right: VIEW_STATION, scope: [ref.campus("nowhere")] }],
    };
    await expect(tuplesFor(perm, emptyState(HOST))).rejects.toThrow(/Cannot resolve campus:nowhere/);
  });

  it("still accepts a numeric dataId on any dimension (the #49 escape hatch is untouched)", async () => {
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      grants: [{ right: "churchdb:view alldata", scope: [7] }],
    };
    expect(await tuplesFor(perm, emptyState(HOST))).toEqual([{ authId: 102, dataId: [7], type: "grant" }]);
  });

  it("resolves a group-type scope ref against the managed group type", async () => {
    const state: State = { version: 1, host: HOST, resources: {
      struktur: { type: "group-type", id: 12, key: "struktur", fields: {}, adoptedAt: "t", updatedAt: "t" },
    }};
    const perm: DesiredPermission = {
      key: "p", domainType: "group_role", domainId: 1,
      grants: [{ right: "churchgroup:view groups of grouptype", scope: [ref.groupType("struktur")] }],
    };
    expect(await tuplesFor(perm, state)).toEqual([
      { authId: 1108, dataId: [12], type: "grant", scopeKey: "struktur", scopeType: "group-type" },
    ]);
  });
});

describe("department scopes are a READ-ONLY ref catalog (cdb_bereich, #98)", () => {
  // `/departments` is GET-only — live-probed 2026-08-13 against the instance's own OpenAPI spec
  // (eqrm prod, CT 3.135.2). So a department resolves by NAME on every host but is never declarable.
  const departments = [{ id: 7, name: "Equippers Koblenz" }, { id: 1, name: "Equippers Rhein-Main" }];
  const client = { get: vi.fn(async (path: string) => (path === "/departments" ? departments : [])) } as unknown as CtClient;

  const perm = (key: string): DesiredPermission => ({
    key: "p", domainType: "group_role", domainId: 1,
    grants: [{ right: "churchdb:view alldata", scope: [{ department: key }] }],
  });

  it("resolves a department by name against the live catalog", async () => {
    // No scopeKey: a catalog-resolved id is already host-correct and has no managed identity to
    // re-resolve at apply time — it behaves exactly like the numeric escape hatch from there on.
    expect(await tuplesFor(perm("equippers_koblenz"), emptyState(HOST), [], client)).toEqual([
      { authId: 102, dataId: [7], type: "grant" },
    ]);
  });

  it("hard-errors on an unknown department, and does NOT advise declaring it", async () => {
    await expect(tuplesFor(perm("nope"), emptyState(HOST), [], client)).rejects.toThrow(
      /no live department at \/departments matches key "nope".*read-only catalog.*cannot be declared or adopted/s,
    );
  });

  it("is never treated as a managed resource, even if a same-keyed resource is in state", async () => {
    const state: State = { version: 1, host: HOST, resources: {
      equippers_koblenz: { type: "group", id: 999, key: "equippers_koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" },
    }};
    // The group must not shadow the department catalog — that would be the misgrant #98 is about.
    expect(await tuplesFor(perm("equippers_koblenz"), state, [], client)).toEqual([
      { authId: 102, dataId: [7], type: "grant" },
    ]);
  });
});

describe("scope object sugar", () => {
  it("compiles { campus: \"koblenz\" } to the same Ref as ref.campus(...)", () => {
    const { ct, permissions } = createContext();
    ct.groupRole({ key: "p", id: 900, grants: [{ right: VIEW_STATION, scope: [{ campus: "koblenz" }] }] });
    expect(permissions[0]?.grants).toEqual([{ right: VIEW_STATION, scope: [ref.campus("koblenz")] }]);
  });

  it("rejects a scope object naming zero or several dimensions", () => {
    const { ct } = createContext();
    expect(() =>
      ct.groupRole({ key: "a", id: 1, grants: [{ right: VIEW_STATION, scope: [{ campus: "a", groupType: "b" } as never] }] }),
    ).toThrow(/exactly one dimension/);
    expect(() =>
      ct.groupRole({ key: "b", id: 2, grants: [{ right: VIEW_STATION, scope: [{ bereich: "a" } as never] }] }),
    ).toThrow(/unknown scope dimension "bereich"/);
  });

  it("rejects a non-string logical key", () => {
    const { ct } = createContext();
    expect(() =>
      ct.groupRole({ key: "a", id: 1, grants: [{ right: VIEW_STATION, scope: [{ campus: 6 } as never] }] }),
    ).toThrow(/"campus" must be a non-empty logical key/);
  });
});

describe("re-resolution is type-aware", () => {
  it("re-resolves a campus scope against the campus in state, not a same-keyed group", () => {
    const state: State = { version: 1, host: HOST, resources: {
      koblenz: { type: "campus", id: 23, key: "koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" },
    }};
    const t = { authId: 124, dataId: [], type: "grant" as const, scopeKey: "koblenz", scopeType: "campus", pending: true };
    expect(reresolveTuple(t, state)).toEqual({ ...t, dataId: [23], pending: false });
  });

  it("refuses to write a grant whose scope key now names a different resource type", () => {
    const state: State = { version: 1, host: HOST, resources: {
      koblenz: { type: "group", id: 5, key: "koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" },
    }};
    const t = { authId: 124, dataId: [], type: "grant" as const, scopeKey: "koblenz", scopeType: "campus", pending: true };
    expect(() => reresolveTuple(t, state)).toThrow(/did not resolve to a managed campus/);
  });
});

describe("resolveScope without a pre-resolution pass", () => {
  it("refuses rather than silently dropping a logical scope ref", () => {
    expect(() => resolveScope([ref.campus("koblenz")], emptyState(HOST))).toThrow(/was not pre-resolved/);
  });
});
