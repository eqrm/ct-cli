import { describe, it, expect } from "vitest";
import { Resolver, reresolvePendingValue } from "../src/resolve/resolver.js";
import { ref, isPendingRef } from "../src/resolve/refs.js";
import { CtApiError } from "../src/api/ctClient.js";
import { emptyState, type State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";

/** A fake client returning canned catalogs by path; 404s on a miss. Counts GET calls per path. */
function fakeClient(byPath: Record<string, unknown>) {
  const calls: Record<string, number> = {};
  return {
    calls,
    get: async <T>(path: string): Promise<T> => {
      calls[path] = (calls[path] ?? 0) + 1;
      if (!(path in byPath)) throw new CtApiError(`not found: ${path}`, 404, null);
      return byPath[path] as T;
    },
  };
}

function stateWith(resources: State["resources"]): State {
  return { ...emptyState("https://x.church.tools"), resources };
}

function stateWithExternals(
  externals: NonNullable<State["externals"]>,
  host = "https://x.church.tools",
): State {
  return { ...emptyState(host), externals };
}

function external(type: string, key: string, id: number, identity: Record<string, unknown>) {
  return { type, key, id, identity, boundAt: "t" };
}

const NO_DESIRED: DesiredResource[] = [];

describe("Resolver.resolve", () => {
  it("resolves a campus from managed state by logical key (before any catalog fetch)", async () => {
    const state = stateWith({
      mainz: { type: "campus", id: 7, key: "mainz", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({});
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.campus("mainz"), "site")).toBe(7);
    expect(client.calls).toEqual({}); // state hit, no /campuses fetch
  });

  it("resolves an external campus only after validating its bound id live", async () => {
    const client = fakeClient({ "/campuses/5": { id: 5, name: "Mainz", shorty: "MZ" } });
    const state = stateWithExternals({ mainz: external("campus", "mainz", 5, { name: "Mainz" }) });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.campus("mainz"), "site")).toBe(5);
    expect(client.calls).toEqual({ "/campuses/5": 1 });
  });

  it("resolves an external group type", async () => {
    const client = fakeClient({ "/group/grouptypes/2": { id: 2, name: "Ministry Team" } });
    const state = stateWithExternals({
      ministry_team: external("group-type", "ministry_team", 2, { name: "Ministry Team" }),
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.groupType("ministry_team"), "site")).toBe(2);
  });

  it("blocks a changed hard identity with a field diff and acceptance command", async () => {
    const client = fakeClient({
      "/groups/9": { id: 9, name: "Renamed", information: { groupTypeId: 3, campusId: 99 } },
    });
    const state = stateWithExternals({
      team: external("group", "team", 9, { name: "Team", groupTypeId: 2 }),
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.group("team"), "ruleset")).rejects.toMatchObject({
      details: {
        reason: "EXTERNAL_IDENTITY_MISMATCH",
        identityDiff: expect.arrayContaining([
          expect.objectContaining({ field: "name", expected: "Team", actual: "Renamed" }),
          expect.objectContaining({ field: "groupTypeId", expected: 2, actual: 3 }),
        ]),
      },
      message: expect.stringContaining("ct use group 9 --key team"),
    });
  });

  it("ignores display-only changes while validating a bound external", async () => {
    const client = fakeClient({
      "/groups/9": { id: 9, name: "Team", information: { groupTypeId: 2, campusId: 99, groupStatusId: 4 } },
    });
    const state = stateWithExternals({
      team: external("group", "team", 9, { name: "Team", groupTypeId: 2 }),
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    await expect(r.resolve(ref.group("team"), "ruleset")).resolves.toBe(9);
  });

  it("blocks a stale external id and directs repair to the owner, not ct use", async () => {
    const client = fakeClient({});
    const state = stateWithExternals({
      team: { ...external("group", "team", 9, { name: "Team", groupTypeId: 2 }), owner: "master" },
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    await expect(r.resolve(ref.group("team"), "ruleset")).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_STALE" },
      message: expect.not.stringContaining("ct use group 9"),
    });
  });

  // PERSON statuses DO have a flat catalog (`GET /statuses`), unlike GROUP statuses in the test below (#90).
  it("resolves externally bound person statuses, including id 0", async () => {
    const client = fakeClient({
      "/statuses/0": { id: 0, name: "Unbekannt" },
      "/statuses/4": { id: 4, name: "3 - Group Active" },
      "/statuses/6": { id: 6, name: "5 - Core" },
    });
    const state = stateWithExternals({
      unbekannt: external("person-status", "unbekannt", 0, { name: "Unbekannt" }),
      "3_group_active": external("person-status", "3_group_active", 4, { name: "3 - Group Active" }),
      "5 - Core": external("person-status", "5 - Core", 6, { name: "5 - Core" }),
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.personStatus("3_group_active"), "site")).toBe(4);
    // Exact-name fallback, for a name that does not survive slugging cleanly.
    expect(await r.resolve(ref.personStatus("5 - Core"), "site")).toBe(6);
    // Status id 0 must come back as 0, not be mistaken for "unresolved".
    expect(await r.resolve(ref.personStatus("unbekannt"), "site")).toBe(0);
    expect(client.calls["/statuses/0"]).toBe(1);
  });

  it("errors on a person-status ref with no catalog match", async () => {
    const client = fakeClient({ "/statuses": [{ id: 0, name: "Unbekannt" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.personStatus("5_core"), "site")).rejects.toThrow(/5_core/);
  });

  it("resolves group statuses by technical name across hosts with different ids (#157)", async () => {
    const clientA = fakeClient({
      "/person/masterdata": { groupStatuses: [{ id: 41, name: "active", nameTranslated: "Aktiv" }] },
    });
    const clientB = fakeClient({
      "/person/masterdata": { groupStatuses: [{ id: 7, name: "active", nameTranslated: "Aktiv" }] },
    });
    const resolverA = new Resolver({ client: clientA, state: emptyState("hostA"), desired: NO_DESIRED });
    const resolverB = new Resolver({ client: clientB, state: emptyState("hostB"), desired: NO_DESIRED });
    expect(await resolverA.resolve(ref.status("active"), "site")).toBe(41);
    expect(await resolverB.resolve(ref.status("active"), "site")).toBe(7);
    expect(clientA.calls).toEqual({ "/person/masterdata": 1 });
    expect(clientB.calls).toEqual({ "/person/masterdata": 1 });
  });

  it("keeps numeric ids as the backward-compatible escape hatch and errors on unknown logical names", async () => {
    const client = fakeClient({ "/person/masterdata": { groupStatuses: [{ id: 1, name: "active" }] } });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.status("candidate"), 'group "g".groupStatusId')).rejects.toThrow(
      /no live group-status at \/person\/masterdata matches key "candidate"/,
    );
    expect(await r.resolveValue(99, "site")).toBe(99);
  });

  it("returns a pending marker for a same-run-declared managed target (not yet in state)", async () => {
    const desired: DesiredResource[] = [{ type: "campus", key: "mainz", fields: {}, dependsOn: [] }];
    const client = fakeClient({ "/campuses": [{ id: 99, name: "Mainz" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired });
    const res = await r.resolve(ref.campus("mainz"), "site");
    expect(isPendingRef(res)).toBe(true);
    expect(client.calls).toEqual({}); // desired hit wins over the catalog
  });

  it("throws listing candidates on an ambiguous catalog match", async () => {
    const client = fakeClient({
      "/campuses": [
        { id: 1, name: "Mainz" },
        { id: 2, name: "Mainz" },
      ],
    });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.campus("mainz"), 'group "g"')).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_AMBIGUOUS" },
      message: expect.stringContaining("ct use campus 2 --key mainz"),
    });
  });

  it("throws a clear error on an unknown reference (kind + key + site + host)", async () => {
    const client = fakeClient({ "/campuses": [{ id: 1, name: "Berlin" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostB" });
    await expect(r.resolve(ref.campus("mainz"), 'group "g".campusId')).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING" },
      message: expect.stringContaining('resource:    campus "mainz"'),
    });
  });

  it("resolves a group_role (group, role) pair to the pairing domainId via the group's role list (#25)", async () => {
    const state = stateWith({
      kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({
      "/groups/42/roles": [
        { id: 2882, name: "Leiter" },
        { id: 2883, name: "Mitglied" },
      ],
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    // slug("Leiter") === "leiter", so either the slug key or the exact name resolves.
    expect(await r.resolve(ref.groupRole("kids", "leiter"), 'perm "p"')).toBe(2882);
    expect(await r.resolve(ref.groupRole("kids", "Mitglied"), 'perm "p"')).toBe(2883);
    expect(client.calls["/groups/42/roles"]).toBe(1); // fetched once, cached across both refs
  });

  it("errors clearly when the role name is not on the group's role list", async () => {
    const state = stateWith({
      kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({ "/groups/42/roles": [{ id: 2882, name: "Leiter" }] });
    const r = new Resolver({ client, state, desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.groupRole("kids", "Ghost"), 'perm "p"')).rejects.toThrow(
      /group #42 has no role named "Ghost".*available: "Leiter".*pass a numeric id/is,
    );
  });

  it("errors when a group_role names a group without an external binding", async () => {
    const client = fakeClient({ "/groups": [] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.groupRole("ghost", "Leiter"), 'perm "p"')).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING", type: "group", key: "ghost" },
    });
  });

  it("errors when a group_role names a same-run-declared (not-yet-created) group", async () => {
    const desired: DesiredResource[] = [{ type: "group", key: "kids", fields: {}, dependsOn: [] }];
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired });
    await expect(r.resolve(ref.groupRole("kids", "Leiter"), 'perm "p"')).rejects.toThrow(
      /declared in this config but not yet created.*Apply the group first/is,
    );
  });

  it("errors on an unbound group ref without consuming discovery", async () => {
    const client = fakeClient({ "/groups": [] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.group("ghost"), "site")).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING" },
    });
  });

  it("reports an exact-name discovery match but still requires ct use", async () => {
    const client = fakeClient({ "/group/grouptypes": [{ id: 8, name: "K-9" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.groupType("K-9"), "site")).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING" },
      message: expect.stringContaining("ct use group-type 8 --key K-9"),
    });
  });
});

describe("Resolver.resolve — group-type-role (groupTypeRoleId, #76)", () => {
  // The real shape from live prod /group/roles: role NAMES repeat across group types ("Leiter" on both
  // group type 12 and 2), which is exactly why #86's `role-def` mapping was ambiguous. Only the
  // (groupTypeId, name) PAIR is unique, so this ref carries the group-type + role name.
  const rolesCatalog = [
    { id: 84, name: "Leiter", groupTypeId: 12 },
    { id: 85, name: "Organisator", groupTypeId: 12 },
    { id: 16, name: "Leiter", groupTypeId: 2 }, // SAME name as #84, different group type
    { id: 17, name: "Organisator", groupTypeId: 2 },
  ];
  const groupTypesCatalog = [
    { id: 12, name: "Local Lead" },
    { id: 2, name: "Team" },
  ];

  it("resolves a (group-type, role) pair to its groupTypeRoleId, disambiguating same-named roles", async () => {
    const client = fakeClient({
      "/group/grouptypes/12": groupTypesCatalog[0],
      "/group/grouptypes/2": groupTypesCatalog[1],
      "/group/roles": rolesCatalog,
    });
    const state = stateWithExternals({
      local_lead: external("group-type", "local_lead", 12, { name: "Local Lead" }),
      team: external("group-type", "team", 2, { name: "Team" }),
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    // Same role NAME ("Leiter"), different group type → different id: the pair disambiguates.
    expect(await r.resolve(ref.groupTypeRole("local_lead", "Leiter"), "site")).toBe(84);
    expect(await r.resolve(ref.groupTypeRole("team", "Leiter"), "site")).toBe(16);
    // slug- and exact-name both resolve; /group/roles fetched once, cached across all refs.
    expect(await r.resolve(ref.groupTypeRole("team", "Organisator"), "site")).toBe(17);
    expect(client.calls["/group/roles"]).toBe(1);
  });

  it("resolves the group-type half from managed state (no group-type catalog fetch)", async () => {
    const state = stateWith({
      local_lead: {
        type: "group-type",
        id: 12,
        key: "local_lead",
        fields: {},
        adoptedAt: "t",
        updatedAt: "t",
      },
    });
    const client = fakeClient({ "/group/roles": rolesCatalog });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.groupTypeRole("local_lead", "Organisator"), "site")).toBe(85);
    expect(client.calls["/group/grouptypes"]).toBeUndefined(); // state hit — no catalog fetch
  });

  it("errors clearly when no role of that name exists on the group type (lists candidates)", async () => {
    const client = fakeClient({ "/group/grouptypes/2": groupTypesCatalog[1], "/group/roles": rolesCatalog });
    const state = stateWithExternals({ team: external("group-type", "team", 2, { name: "Team" }) });
    const r = new Resolver({ client, state, desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.groupTypeRole("team", "Ghost"), 'ruleset "r"')).rejects.toThrow(
      /group-type-role\(groupType=team, role=Ghost\) referenced at ruleset "r" on hostA: group type #2 has no role named "Ghost".*available: "Leiter", "Organisator".*pass a numeric id/is,
    );
  });

  it("errors listing candidates when two roles on the same group type share the name (ambiguous)", async () => {
    const client = fakeClient({
      "/group/grouptypes/12": groupTypesCatalog[0],
      "/group/roles": [
        { id: 84, name: "Leiter", groupTypeId: 12 },
        { id: 800, name: "Leiter", groupTypeId: 12 }, // duplicate on the SAME group type
      ],
    });
    const state = stateWithExternals({
      local_lead: external("group-type", "local_lead", 12, { name: "Local Lead" }),
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.groupTypeRole("local_lead", "Leiter"), "site")).rejects.toThrow(
      /Ambiguous group-type-role\(groupType=local_lead, role=Leiter\).*2 roles on group type #12 match — "Leiter" \(#84\), "Leiter" \(#800\)/,
    );
  });

  it("errors when the group-type key itself cannot be resolved", async () => {
    const client = fakeClient({ "/group/grouptypes": groupTypesCatalog, "/group/roles": rolesCatalog });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostB" });
    await expect(r.resolve(ref.groupTypeRole("ghost_type", "Leiter"), "site")).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING", type: "group-type", key: "ghost_type" },
    });
  });

  it("rejects a same-run-declared (not-yet-created) group type — id only exists once it does", async () => {
    const desired: DesiredResource[] = [{ type: "group-type", key: "local_lead", fields: {}, dependsOn: [] }];
    const client = fakeClient({ "/group/roles": rolesCatalog });
    const r = new Resolver({ client, state: emptyState("h"), desired, host: "hostA" });
    await expect(r.resolve(ref.groupTypeRole("local_lead", "Leiter"), "site")).rejects.toThrow(
      /declared in this config but not yet created.*Apply the group type first.*pass a numeric id/is,
    );
  });
});

describe("Resolver.resolveValue", () => {
  it("deep-rewrites refs to ids and fetches each catalog at most once", async () => {
    const client = fakeClient({
      "/campuses/5": { id: 5, name: "Mainz" },
      "/campuses/6": { id: 6, name: "Berlin" },
    });
    const state = stateWithExternals({
      mainz: external("campus", "mainz", 5, { name: "Mainz" }),
      berlin: external("campus", "berlin", 6, { name: "Berlin" }),
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    const value = {
      campusId: ref.campus("mainz"),
      query: {
        or: [
          { "==": [{ var: "ctgroup.campusId" }, ref.campus("mainz")] },
          { "==": [{ var: "ctgroup.campusId" }, ref.campus("berlin")] },
        ],
      },
      untouched: 42,
    };
    const out = await r.resolveValue(value, "site");
    expect(out).toEqual({
      campusId: 5,
      query: { or: [{ "==": [{ var: "ctgroup.campusId" }, 5] }, { "==": [{ var: "ctgroup.campusId" }, 6] }] },
      untouched: 42,
    });
    expect(client.calls["/campuses/5"]).toBe(1); // cached across the two mainz refs
    expect(client.calls["/campuses/6"]).toBe(1);
  });

  it("returns the original reference untouched when there are no refs", async () => {
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    const value = { campusId: 4, groupTypeId: 2 };
    expect(await r.resolveValue(value, "site")).toBe(value); // identity — no rebuild, no fetch
    expect(client.calls).toEqual({});
  });
});

describe("catalogs are read PAGINATED (#99 review)", () => {
  /**
   * A client that also has `getAll`, like the real one. `get` returns only the first page — which is
   * exactly what CT does for a plain list read (10 rows by default) — so a resolver that used `get`
   * would report the page-2 row as non-existent while `ct get campuses` happily lists it.
   */
  function pagingClient(pages: Record<string, unknown[][]>) {
    const calls: Record<string, number> = {};
    return {
      calls,
      get: async <T>(path: string): Promise<T> => {
        calls[path] = (calls[path] ?? 0) + 1;
        return (pages[path]?.[0] ?? []) as T;
      },
      getAll: async <T>(path: string): Promise<{ data: T[] }> => {
        calls[path] = (calls[path] ?? 0) + 1;
        return { data: (pages[path] ?? []).flat() as T[] };
      },
    };
  }

  const campusPages = [
    Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Campus ${i + 1}` })),
    [{ id: 42, name: "Koblenz" }], // page 2 — invisible to a single `get`
  ];

  it("discovers a campus past the default first page but still refuses an ephemeral binding", async () => {
    const client = pagingClient({ "/campuses": campusPages });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.campus("koblenz"), "site")).rejects.toMatchObject({
      details: { reason: "EXTERNAL_BINDING_MISSING" },
      message: expect.stringContaining("ct use campus 42 --key koblenz"),
    });
    expect(client.calls["/campuses"]).toBe(1); // still fetched once per run
  });

  it("pages the per-group role list too", async () => {
    const state = stateWith({
      kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = pagingClient({
      "/groups/42/roles": [
        Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Rolle ${i + 1}` })),
        [{ id: 2882, name: "Leiter" }],
      ],
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.groupRole("kids", "Leiter"), 'perm "p"')).toBe(2882);
  });
});

describe("reresolvePendingValue", () => {
  it("replaces a pending marker with the id from post-execute state", () => {
    const state = stateWith({
      mainz: { type: "campus", id: 12, key: "mainz", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const body = { name: "G", campusId: { __pendingRef: ref.campus("mainz") } };
    expect(reresolvePendingValue(body, state)).toEqual({ name: "G", campusId: 12 });
  });

  it("throws if a pending target never landed in state", () => {
    const body = { campusId: { __pendingRef: ref.campus("mainz") } };
    expect(() => reresolvePendingValue(body, emptyState("h"))).toThrow(/did not resolve after apply/);
  });

  it("passes non-pending values through untouched", () => {
    expect(reresolvePendingValue({ campusId: 4, n: [1, 2] }, emptyState("h"))).toEqual({
      campusId: 4,
      n: [1, 2],
    });
  });
});
