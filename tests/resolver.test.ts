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

  it("resolves a campus from the live catalog by slug(name)", async () => {
    const client = fakeClient({ "/campuses": [{ id: 3, name: "Berlin", shorty: "BE" }, { id: 5, name: "Mainz" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    expect(await r.resolve(ref.campus("mainz"), "site")).toBe(5);
  });

  it("resolves a group type from the live catalog", async () => {
    const client = fakeClient({ "/group/grouptypes": [{ id: 2, name: "Ministry Team" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    expect(await r.resolve(ref.groupType("ministry_team"), "site")).toBe(2);
  });

  // PERSON statuses DO have a flat catalog (`GET /statuses`), unlike GROUP statuses in the test below (#90).
  it("resolves a person status from the /statuses catalog by slug(name)", async () => {
    const client = fakeClient({
      "/statuses": [
        { id: 0, name: "Unbekannt" },
        { id: 4, name: "3 - Group Active" },
        { id: 6, name: "5 - Core" },
      ],
    });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    expect(await r.resolve(ref.personStatus("3_group_active"), "site")).toBe(4);
    // Exact-name fallback, for a name that does not survive slugging cleanly.
    expect(await r.resolve(ref.personStatus("5 - Core"), "site")).toBe(6);
    // Status id 0 must come back as 0, not be mistaken for "unresolved".
    expect(await r.resolve(ref.personStatus("unbekannt"), "site")).toBe(0);
    expect(client.calls["/statuses"]).toBe(1); // one fetch, memoized across all three
  });

  it("errors on a person-status ref with no catalog match", async () => {
    const client = fakeClient({ "/statuses": [{ id: 0, name: "Unbekannt" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.personStatus("5_core"), "site")).rejects.toThrow(/5_core/);
  });

  it("has no group-status catalog — a group-status ref is a hard error, never resolved against /group/memberstatus (#67)", async () => {
    // /group/memberstatus IS mocked here (as a member-statuses catalog would be on a live host), to
    // prove the resolver never even looks at it for a group-status ref — group statuses have no
    // REST catalog to resolve against (a different, unrelated dimension from member statuses).
    const client = fakeClient({ "/group/memberstatus": [{ id: 1, name: "Active" }, { id: 2, name: "Candidate" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.status("candidate"), "site")).rejects.toThrow(
      /Cannot resolve group-status:candidate referenced at site on hostA/,
    );
    expect(client.calls).toEqual({}); // /group/memberstatus never fetched for a group-status ref
  });

  it("gives the same actionable no-catalog message as the eval-time guard, not the generic 'declare/adopt it' advice (#67 reviewer follow-up)", async () => {
    // A `groupStatusId: ref.status(...)` value bypasses the eval-time guard in context.ts (the
    // id-field escape hatch accepts any Ref) and reaches the resolver directly. The generic
    // notFound() advice ("Declare/adopt it, fix the key/name, or use a numeric id") is wrong here —
    // there is no group-status resource type and no catalog to adopt against — so this must be the
    // SAME message context.ts's eval-time guard uses, not the generic one.
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.status("candidate"), "group \"g\".groupStatusId")).rejects.toThrow(
      'Cannot resolve group-status:candidate referenced at group "g".groupStatusId on hostA: group statuses ' +
        "have no REST catalog (GET /group/memberstatus is a different dimension: member statuses, string ids " +
        '— verified 2026-07-10). Declare a numeric "groupStatusId" instead (e.g. "groupStatusId: 1").',
    );
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
    const client = fakeClient({ "/campuses": [{ id: 1, name: "Mainz" }, { id: 2, name: "Mainz" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.campus("mainz"), "group \"g\"")).rejects.toThrow(
      /Ambiguous campus:mainz referenced at group "g" on hostA: 2 live campuss match/,
    );
  });

  it("throws a clear error on an unknown reference (kind + key + site + host)", async () => {
    const client = fakeClient({ "/campuses": [{ id: 1, name: "Berlin" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostB" });
    await expect(r.resolve(ref.campus("mainz"), "group \"g\".campusId")).rejects.toThrow(
      /Cannot resolve campus:mainz referenced at group "g".campusId on hostB/,
    );
  });

  it("resolves a group_role (group, role) pair to the pairing domainId via the group's role list (#25)", async () => {
    const state = stateWith({
      kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({
      "/groups/42/roles": [{ id: 2882, name: "Leiter" }, { id: 2883, name: "Mitglied" }],
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    // slug("Leiter") === "leiter", so either the slug key or the exact name resolves.
    expect(await r.resolve(ref.groupRole("kids", "leiter"), "perm \"p\"")).toBe(2882);
    expect(await r.resolve(ref.groupRole("kids", "Mitglied"), "perm \"p\"")).toBe(2883);
    expect(client.calls["/groups/42/roles"]).toBe(1); // fetched once, cached across both refs
  });

  it("errors clearly when the role name is not on the group's role list", async () => {
    const state = stateWith({
      kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({ "/groups/42/roles": [{ id: 2882, name: "Leiter" }] });
    const r = new Resolver({ client, state, desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.groupRole("kids", "Ghost"), "perm \"p\"")).rejects.toThrow(
      /group #42 has no role named "Ghost".*available: "Leiter".*pass a numeric id/is,
    );
  });

  it("errors when a group_role names a group that isn't managed", async () => {
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.groupRole("ghost", "Leiter"), "perm \"p\"")).rejects.toThrow(
      /no managed group named "ghost".*pass a numeric id/is,
    );
  });

  it("errors when a group_role names a same-run-declared (not-yet-created) group", async () => {
    const desired: DesiredResource[] = [{ type: "group", key: "kids", fields: {}, dependsOn: [] }];
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired });
    await expect(r.resolve(ref.groupRole("kids", "Leiter"), "perm \"p\"")).rejects.toThrow(
      /declared in this config but not yet created.*Apply the group first/is,
    );
  });

  it("errors on a group ref with no managed match (groups have no catalog)", async () => {
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.group("ghost"), "site")).rejects.toThrow(/no managed group named "ghost"/);
  });

  it("falls back to an exact-name secondary match when the slug misses", async () => {
    const client = fakeClient({ "/group/grouptypes": [{ id: 8, name: "K-9" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    // slug("K-9") === "k_9", so ref.groupType("k_9") hits the slug path; "K-9" hits the exact path.
    expect(await r.resolve(ref.groupType("K-9"), "site")).toBe(8);
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
  const groupTypesCatalog = [{ id: 12, name: "Local Lead" }, { id: 2, name: "Team" }];

  it("resolves a (group-type, role) pair to its groupTypeRoleId, disambiguating same-named roles", async () => {
    const client = fakeClient({ "/group/grouptypes": groupTypesCatalog, "/group/roles": rolesCatalog });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    // Same role NAME ("Leiter"), different group type → different id: the pair disambiguates.
    expect(await r.resolve(ref.groupTypeRole("local_lead", "Leiter"), "site")).toBe(84);
    expect(await r.resolve(ref.groupTypeRole("team", "Leiter"), "site")).toBe(16);
    // slug- and exact-name both resolve; /group/roles fetched once, cached across all refs.
    expect(await r.resolve(ref.groupTypeRole("team", "Organisator"), "site")).toBe(17);
    expect(client.calls["/group/roles"]).toBe(1);
  });

  it("resolves the group-type half from managed state (no group-type catalog fetch)", async () => {
    const state = stateWith({
      local_lead: { type: "group-type", id: 12, key: "local_lead", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({ "/group/roles": rolesCatalog });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.groupTypeRole("local_lead", "Organisator"), "site")).toBe(85);
    expect(client.calls["/group/grouptypes"]).toBeUndefined(); // state hit — no catalog fetch
  });

  it("errors clearly when no role of that name exists on the group type (lists candidates)", async () => {
    const client = fakeClient({ "/group/grouptypes": groupTypesCatalog, "/group/roles": rolesCatalog });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.groupTypeRole("team", "Ghost"), "ruleset \"r\"")).rejects.toThrow(
      /group-type-role\(groupType=team, role=Ghost\) referenced at ruleset "r" on hostA: group type #2 has no role named "Ghost".*available: "Leiter", "Organisator".*pass a numeric id/is,
    );
  });

  it("errors listing candidates when two roles on the same group type share the name (ambiguous)", async () => {
    const client = fakeClient({
      "/group/grouptypes": groupTypesCatalog,
      "/group/roles": [
        { id: 84, name: "Leiter", groupTypeId: 12 },
        { id: 800, name: "Leiter", groupTypeId: 12 }, // duplicate on the SAME group type
      ],
    });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.groupTypeRole("local_lead", "Leiter"), "site")).rejects.toThrow(
      /Ambiguous group-type-role\(groupType=local_lead, role=Leiter\).*2 roles on group type #12 match — "Leiter" \(#84\), "Leiter" \(#800\)/,
    );
  });

  it("errors when the group-type key itself cannot be resolved", async () => {
    const client = fakeClient({ "/group/grouptypes": groupTypesCatalog, "/group/roles": rolesCatalog });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostB" });
    await expect(r.resolve(ref.groupTypeRole("ghost_type", "Leiter"), "site")).rejects.toThrow(
      /Cannot resolve group-type:ghost_type referenced at site on hostB/,
    );
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
    const client = fakeClient({ "/campuses": [{ id: 5, name: "Mainz" }, { id: 6, name: "Berlin" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    const value = {
      campusId: ref.campus("mainz"),
      query: { or: [{ "==": [{ var: "ctgroup.campusId" }, ref.campus("mainz")] }, { "==": [{ var: "ctgroup.campusId" }, ref.campus("berlin")] }] },
      untouched: 42,
    };
    const out = await r.resolveValue(value, "site");
    expect(out).toEqual({
      campusId: 5,
      query: { or: [{ "==": [{ var: "ctgroup.campusId" }, 5] }, { "==": [{ var: "ctgroup.campusId" }, 6] }] },
      untouched: 42,
    });
    expect(client.calls["/campuses"]).toBe(1); // cached across the two mainz refs + the berlin ref
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

  it("resolves a campus that lives past CT's default first page", async () => {
    const client = pagingClient({ "/campuses": campusPages });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    expect(await r.resolve(ref.campus("koblenz"), "site")).toBe(42);
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
    expect(await r.resolve(ref.groupRole("kids", "Leiter"), "perm \"p\"")).toBe(2882);
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
    expect(reresolvePendingValue({ campusId: 4, n: [1, 2] }, emptyState("h"))).toEqual({ campusId: 4, n: [1, 2] });
  });
});
