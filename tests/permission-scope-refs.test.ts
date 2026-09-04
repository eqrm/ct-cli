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
      koblenz: {
        type: "campus",
        id,
        key: "koblenz",
        fields: { name: "Koblenz" },
        adoptedAt: "t",
        updatedAt: "t",
      },
    },
  };
}

function stateWithExternal(type: string, key: string, id: number, identity: Record<string, unknown>): State {
  const state = emptyState(HOST);
  state.externals![key] = { type, key, id, identity, boundAt: "t" };
  return state;
}

/** A client whose `/permissions/*` reads are empty and whose `/campuses` catalog is host-specific. */
function mockClient(campuses: { id: number; name: string }[] = [], newId = 555) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const get = vi.fn(async (path: string) => {
    if (path === "/campuses") return campuses;
    const id = /^\/campuses\/(\d+)$/.exec(path)?.[1];
    return id ? campuses.find((campus) => campus.id === Number(id)) : [];
  });
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/campuses") return { id: newId };
    return {};
  });
  return { client: { get, request } as unknown as CtClient, calls, get };
}

async function tuplesFor(
  perm: DesiredPermission,
  state: State,
  desired: DesiredResource[] = [],
  client?: CtClient,
) {
  const c = client ?? mockClient().client;
  const resolver = new Resolver({ client: c, state, desired });
  const refs = await resolveScopeRefs([perm], resolver, state);
  return desiredTuples(
    perm,
    state,
    new Set(desired.filter((r) => r.type === "group").map((r) => r.key)),
    refs,
  );
}

describe("campus-scoped grants are portable across hosts (#98)", () => {
  it("resolves one config to each host's own campus id — no numeric literal anywhere", async () => {
    // Same DesiredPermission object, two hosts whose Koblenz campus carries a different id.
    const dev = await tuplesFor(campusScoped, stateWithKoblenz(6));
    const prod = await tuplesFor(campusScoped, stateWithKoblenz(23));

    expect(dev).toEqual([
      { authId: 124, dataId: [6], type: "grant", scopeKey: "koblenz", scopeType: "campus" },
    ]);
    expect(prod).toEqual([
      { authId: 124, dataId: [23], type: "grant", scopeKey: "koblenz", scopeType: "campus" },
    ]);
  });

  it("plans to a clean no-op against each host's live rows", async () => {
    for (const id of [6, 23]) {
      const state = stateWithKoblenz(id);
      const live = [
        {
          domainType: "group_role",
          domainId: 900,
          authId: 124,
          dataId: id,
          type: "grant",
          meta: { modifiedPid: 5 },
        },
      ];
      const client = { get: vi.fn(async (path: string) => (path === "/campuses" ? [] : live)) };
      const { items, fetchErrors } = await buildPermissionPlan(client as never, state, [campusScoped]);
      expect(fetchErrors).toEqual([]);
      expect(items[0]?.diff.toPut).toEqual([]);
      expect(items[0]?.diff.toDelete).toEqual([]);
    }
  });

  it("resolves a read-only campus only through its explicit external binding", async () => {
    const { client } = mockClient([{ id: 23, name: "Koblenz" }]);
    const state = stateWithExternal("campus", "koblenz", 23, { name: "Koblenz" });
    const tuples = await tuplesFor(campusScoped, state, [], client);
    expect(tuples).toEqual([{ authId: 124, dataId: [23], type: "grant" }]);
  });

  it("a campus created in the same run is pending at plan time and gets its real id at apply time", async () => {
    const desired: DesiredResource[] = [
      { type: "campus", key: "koblenz", fields: { name: "Koblenz", shorty: "KO" }, dependsOn: [] },
    ];
    const { client, calls } = mockClient([], 555);
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [campusScoped], desired);
    expect(items[0]?.diff.toPut).toEqual([
      { authId: 124, dataId: [], type: "grant", scopeKey: "koblenz", scopeType: "campus", pending: true },
    ]);

    const createCampus: Plan = {
      items: [
        {
          type: "campus",
          key: "koblenz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Koblenz" }],
        },
      ],
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
      key: "p",
      domainType: "group_role",
      domainId: 1,
      // churchdb:view station scopes by cdb_station (campus) — a group-type ref there is a config bug.
      grants: [{ right: VIEW_STATION, scope: [ref.groupType("struktur")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /group-type:struktur.*"cdb_station".*takes a campus reference/s,
    );
  });

  it("rejects a ref on a dimension with no logical form at all, naming the ref and the dimension", async () => {
    const perm: DesiredPermission = {
      key: "p",
      domainType: "group_role",
      domainId: 1,
      // churchcal:view category scopes by cc_calcategory — a calendar dimension, outside this tool's
      // mandate, so it has no ref kind and the numeric hatch is the only honest answer.
      grants: [{ right: "churchcal:view category", scope: [ref.campus("koblenz")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /campus:koblenz.*cc_calcategory.*no logical reference form/s,
    );
  });

  it("rejects a ref whose kind does not match the security-level dimension (#110)", async () => {
    const perm: DesiredPermission = {
      key: "p",
      domainType: "group_role",
      domainId: 1,
      grants: [{ right: "churchdb:security level person", scope: [ref.campus("koblenz")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /campus:koblenz.*"cc_securitylevel".*takes a security-level reference/s,
    );
  });

  it("rejects a logical ref on a dimension that has no logical form, pointing at the numeric hatch", async () => {
    const perm: DesiredPermission = {
      key: "p",
      domainType: "group_role",
      domainId: 1,
      // ccm_data_category: its values are not resources at all — numbers only, by nature.
      grants: [{ right: "jpmFlowManagerPreview:view custom category", scope: [ref.campus("x")] }],
    };
    await expect(resolveScopeRefs([perm], resolverFor(emptyState(HOST)), emptyState(HOST))).rejects.toThrow(
      /ccm_data_category.*no logical reference form.*numeric dataId/s,
    );
  });

  it("rejects a logical ref on an unscoped right", async () => {
    const perm: DesiredPermission = {
      key: "p",
      domainType: "group_role",
      domainId: 1,
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
      key: "p",
      domainType: "group_role",
      domainId: 1,
      grants: [{ right: VIEW_STATION, scope: ["koblenz"] }],
    };
    const state = stateWithKoblenz(6);
    await expect(tuplesFor(perm, state)).rejects.toThrow(
      /bare string.*scopes by "cdb_station".*\{ campus: "koblenz" \}/s,
    );
  });

  it("a ref that cannot resolve is a hard error, never a dropped or guessed dataId", async () => {
    const perm: DesiredPermission = {
      key: "p",
      domainType: "group_role",
      domainId: 1,
      grants: [{ right: VIEW_STATION, scope: [ref.campus("nowhere")] }],
    };
    await expect(tuplesFor(perm, emptyState(HOST))).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING", type: "campus", key: "nowhere" },
    });
  });

  it("still accepts a numeric dataId on any dimension (the #49 escape hatch is untouched)", async () => {
    const perm: DesiredPermission = {
      key: "p",
      domainType: "group_role",
      domainId: 1,
      grants: [{ right: "churchdb:view alldata", scope: [7] }],
    };
    expect(await tuplesFor(perm, emptyState(HOST))).toEqual([{ authId: 102, dataId: [7], type: "grant" }]);
  });

  it("resolves a group-type scope ref against the managed group type", async () => {
    const state: State = {
      version: 1,
      host: HOST,
      resources: {
        struktur: { type: "group-type", id: 12, key: "struktur", fields: {}, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const perm: DesiredPermission = {
      key: "p",
      domainType: "group_role",
      domainId: 1,
      grants: [{ right: "churchgroup:view groups of grouptype", scope: [ref.groupType("struktur")] }],
    };
    expect(await tuplesFor(perm, state)).toEqual([
      { authId: 1108, dataId: [12], type: "grant", scopeKey: "struktur", scopeType: "group-type" },
    ]);
  });
});

describe("department scopes are a read-but-not-managed ref catalog (cdb_bereich, #98)", () => {
  // `/departments` is GET-only — live-probed 2026-08-13 against the instance's own OpenAPI spec
  // (eqrm prod, CT 3.135.2) — and `ct` drives no other write path for it, so a department resolves by
  // NAME on every host but is never declarable HERE. (ChurchTools itself can create one, through the
  // legacy master-data endpoint the admin UI uses — #108/#109.)
  const departments = [
    { id: 7, name: "Equippers Koblenz" },
    { id: 1, name: "Equippers Rhein-Main" },
  ];
  const client = {
    get: vi.fn(async (path: string) => (path === "/departments" ? departments : [])),
  } as unknown as CtClient;

  const perm = (key: string): DesiredPermission => ({
    key: "p",
    domainType: "group_role",
    domainId: 1,
    grants: [{ right: "churchdb:view alldata", scope: [{ department: key }] }],
  });

  it("resolves a department through an explicit external binding", async () => {
    const state = stateWithExternal("department", "equippers_koblenz", 7, { name: "Equippers Koblenz" });
    expect(await tuplesFor(perm("equippers_koblenz"), state, [], client)).toEqual([
      { authId: 102, dataId: [7], type: "grant" },
    ]);
  });

  it("hard-errors on an unknown department, and NOW advises declaring it (#108)", async () => {
    // Before #108 this said departments could not be declared or adopted. They can: `ct.department`
    // creates one through the legacy master-data endpoint, so the generic advice is correct again.
    await expect(tuplesFor(perm("nope"), emptyState(HOST), [], client)).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING", type: "department", key: "nope" },
    });
  });

  it("is not shadowed by an unrelated managed resource under another key", async () => {
    const state = stateWithExternal("department", "equippers_koblenz", 7, { name: "Equippers Koblenz" });
    state.resources.some_group = {
      type: "group",
      id: 999,
      key: "some_group",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    expect(await tuplesFor(perm("equippers_koblenz"), state, [], client)).toEqual([
      { authId: 102, dataId: [7], type: "grant" },
    ]);
  });
});

describe("security-level scopes resolve by name (cc_securitylevel, #110)", () => {
  // "Security-level ids are universal, so a numeric literal is portable" was an assumption, not a
  // guarantee: cc_securitylevel is admin-editable master data with an auto-increment id. These pin the
  // ref form that says what it means on any host — while keeping the numeric hatch working.
  const levels = [
    { id: 1, name: "Stufe 1 (Niedrig)", sortKey: 1 },
    { id: 2, name: "Stufe 2 (Mittel)", sortKey: 2 },
    { id: 3, name: "Stufe 3 (Hoch)", sortKey: 3 },
  ];
  const client = {
    get: vi.fn(async (path: string) => {
      if (path === "/securitylevels") return levels;
      const id = /^\/securitylevels\/(\d+)$/.exec(path)?.[1];
      return id ? levels.find((level) => level.id === Number(id)) : [];
    }),
  } as unknown as CtClient;

  const perm = (scope: unknown[]): DesiredPermission => ({
    key: "p",
    domainType: "group_role",
    domainId: 1,
    grants: [{ right: "churchdb:security level person", scope: scope as never }],
  });

  it("resolves a level through its explicit external binding", async () => {
    const state = stateWithExternal("security-level", "stufe_3_hoch", 3, { name: "Stufe 3 (Hoch)" });
    expect(await tuplesFor(perm([{ securityLevel: "stufe_3_hoch" }]), state, [], client)).toEqual([
      { authId: 125, dataId: [3], type: "grant" },
    ]);
  });

  it("still accepts the numeric escape hatch, byte-identically (#49)", async () => {
    expect(await tuplesFor(perm([1, 2, 3]), emptyState(HOST), [], client)).toEqual([
      { authId: 125, dataId: [1], type: "grant" },
      { authId: 125, dataId: [2], type: "grant" },
      { authId: 125, dataId: [3], type: "grant" },
    ]);
  });

  it("hard-errors on a level name this host does not have, instead of granting the wrong one", async () => {
    await expect(
      tuplesFor(perm([{ securityLevel: "stufe_9" }]), emptyState(HOST), [], client),
    ).rejects.toMatchObject({ details: { reason: "EXTERNAL_BINDING_MISSING", key: "stufe_9" } });
  });
});

describe("comment-viewer scopes resolve by name (cdb_comment_viewer, #102)", () => {
  // The dimension that made three Pastoral Care role instances undeclarable: each was blocked by
  // exactly ONE comment_viewer-scoped grant. #109 assumed this needed the legacy master-data
  // endpoint; `/person/commentviewers` is conventional REST, so it is just another catalog.
  const viewers = [
    { id: 0, name: "Alle", sortKey: 0 },
    { id: 1, name: "Gemeindeleitung", sortKey: 1 },
    { id: 2, name: "Admins", sortKey: 2 },
  ];
  const client = {
    get: vi.fn(async (path: string) => {
      if (path === "/person/commentviewers") return viewers;
      const id = /^\/person\/commentviewers\/(\d+)$/.exec(path)?.[1];
      return id ? viewers.find((viewer) => viewer.id === Number(id)) : [];
    }),
  } as unknown as CtClient;

  const perm = (scope: unknown[]): DesiredPermission => ({
    key: "p",
    domainType: "group_role",
    domainId: 1,
    grants: [{ right: "churchdb:view comments", scope: scope as never }],
  });

  it("resolves a viewer by name", async () => {
    const state = stateWithExternal("comment-viewer", "gemeindeleitung", 1, { name: "Gemeindeleitung" });
    expect(await tuplesFor(perm([{ commentViewer: "gemeindeleitung" }]), state, [], client)).toEqual([
      { authId: 113, dataId: [1], type: "grant" },
    ]);
  });

  it("resolves the id-0 row — a falsy id must not read as 'not found'", async () => {
    // "Alle" is id 0 on a real instance. Anything treating 0 as missing would silently drop the scope
    // (or worse, fall through to a different row), so this is pinned deliberately.
    const state = stateWithExternal("comment-viewer", "alle", 0, { name: "Alle" });
    expect(await tuplesFor(perm([{ commentViewer: "alle" }]), state, [], client)).toEqual([
      { authId: 113, dataId: [0], type: "grant" },
    ]);
  });

  it("hard-errors on a viewer name this host does not have", async () => {
    await expect(
      tuplesFor(perm([{ commentViewer: "nope" }]), emptyState(HOST), [], client),
    ).rejects.toMatchObject({ details: { reason: "EXTERNAL_BINDING_MISSING", key: "nope" } });
  });
});

describe("scope object sugar", () => {
  it('compiles { campus: "koblenz" } to the same Ref as ref.campus(...)', () => {
    const { ct, permissions } = createContext();
    ct.groupRole({ key: "p", id: 900, grants: [{ right: VIEW_STATION, scope: [{ campus: "koblenz" }] }] });
    expect(permissions[0]?.grants).toEqual([{ right: VIEW_STATION, scope: [ref.campus("koblenz")] }]);
  });

  it("rejects a scope object naming zero or several dimensions", () => {
    const { ct } = createContext();
    expect(() =>
      ct.groupRole({
        key: "a",
        id: 1,
        grants: [{ right: VIEW_STATION, scope: [{ campus: "a", groupType: "b" } as never] }],
      }),
    ).toThrow(/exactly one dimension/);
    expect(() =>
      ct.groupRole({
        key: "b",
        id: 2,
        grants: [{ right: VIEW_STATION, scope: [{ bereich: "a" } as never] }],
      }),
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
    const state: State = {
      version: 1,
      host: HOST,
      resources: {
        koblenz: { type: "campus", id: 23, key: "koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const t = {
      authId: 124,
      dataId: [],
      type: "grant" as const,
      scopeKey: "koblenz",
      scopeType: "campus",
      pending: true,
    };
    expect(reresolveTuple(t, state)).toEqual({ ...t, dataId: [23], pending: false });
  });

  it("refuses to write a grant whose scope key now names a different resource type", () => {
    const state: State = {
      version: 1,
      host: HOST,
      resources: {
        koblenz: { type: "group", id: 5, key: "koblenz", fields: {}, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const t = {
      authId: 124,
      dataId: [],
      type: "grant" as const,
      scopeKey: "koblenz",
      scopeType: "campus",
      pending: true,
    };
    expect(() => reresolveTuple(t, state)).toThrow(/did not resolve to a managed campus/);
  });
});

describe("resolveScope without a pre-resolution pass", () => {
  it("refuses rather than silently dropping a logical scope ref", () => {
    expect(() => resolveScope([ref.campus("koblenz")], emptyState(HOST))).toThrow(/was not pre-resolved/);
  });
});
