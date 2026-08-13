import { describe, it, expect, vi } from "vitest";
import { desiredTuples, buildPermissionPlan } from "../src/permissions/plan.js";
import { CATALOG_META } from "../src/permissions/catalog.js";
import { ref } from "../src/resolve/refs.js";
import type { State } from "../src/state/state.js";

const state: State = { version: 1, host: "h", resources: {
  kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
  other: { type: "group", id: 7, key: "other", fields: {}, adoptedAt: "t", updatedAt: "t" },
}};

describe("desiredTuples", () => {
  it("resolves names and scope to tuples", () => {
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        "churchgroup:administer groups",                            // authId 1113, unscoped (no scopeField) → global
        { right: "churchgroup:view group", scope: ["kids_area"] },  // authId 1104, scoped, dataId [42]
      ]}, state);
    expect(tuples).toEqual([
      { authId: 1113, dataId: [], type: "grant" },
      { authId: 1104, dataId: [42], type: "grant", scopeKey: "kids_area", scopeType: "group" }, // scoped tuples retain their symbolic key for re-resolution
    ]);
  });

  it("rejects a bare-string scoped right — it would silently grant globally", () => {
    // churchgroup:view group carries scopeField "cdb_gruppe" (it IS scoped). Declared as a bare
    // string it would emit dataId: [] — a global grant. It must be declared as { right, scope }.
    expect(() => desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:view group"] }, state),
    ).toThrow(/is a scoped right.*must be declared as \{ right/is);
  });
  it("accepts an admin-authored authId >= 10000 member right on group_type_role (#65)", () => {
    // The old authId>=10000 rejection is gone — admin-authored member rights CT lets you write are
    // now declarable. "churchdb:+add person" (authId 10107) is unscoped, so a bare string is valid.
    expect(desiredTuples({ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchdb:+add person"] }, state))
      .toEqual([{ authId: 10107, dataId: [], type: "grant" }]);
  });

  it("fans out a multi-element scope into one single-dataId tuple per dataId (idempotency: ChurchTools reads scoped grants back one row per dataId)", () => {
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchgroup:view group", scope: ["kids_area", "other"] },
      ]}, state);
    // resolveScope sorts resolved dataIds ascending (7 < 42), independent of scope-key order.
    expect(tuples).toEqual([
      { authId: 1104, dataId: [7], type: "grant", scopeKey: "other", scopeType: "group" },
      { authId: 1104, dataId: [42], type: "grant", scopeKey: "kids_area", scopeType: "group" },
    ]);
    expect(tuples.every((t) => t.dataId.length <= 1)).toBe(true);
  });

  it("rejects a scoped grant on a right with no scopeField", () => {
    // churchcore:administer settings has scopeField: null in the catalog — not a scoped right.
    expect(() => desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchcore:administer settings", scope: ["kids_area"] },
      ]}, state),
    ).toThrow(/not a scoped right/);
  });

  it("accepts a raw numeric scope entry (escape hatch, #49) for a right scoped by a non-group dimension", () => {
    // churchdb:view comments (authId 113) is scoped by "cdb_comment_viewer" — not a group. There is
    // no managed-group representation for it, so the DSL's numeric escape hatch is the only way to
    // declare it. Numeric entries fan out just like logical keys, and MUST NOT retain a scopeKey —
    // there is no state resource to re-resolve at apply time.
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchdb:view comments", scope: [1, 2] },
      ]}, state);
    expect(tuples).toEqual([
      { authId: 113, dataId: [1], type: "grant" },
      { authId: 113, dataId: [2], type: "grant" },
    ]);
    expect(tuples.every((t) => t.scopeKey === undefined)).toBe(true);
  });

  it("mixes a numeric scope entry with a logical group key in the same declaration", () => {
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchgroup:view group", scope: ["kids_area", 3] },
      ]}, state);
    expect(tuples).toEqual([
      { authId: 1104, dataId: [3], type: "grant" },
      { authId: 1104, dataId: [42], type: "grant", scopeKey: "kids_area", scopeType: "group" },
    ]);
  });
});

describe("buildPermissionPlan", () => {
  it("diffs desired vs actual (bulk fetch filtered to managed domainIds)", async () => {
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 8, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 1 } },
      { domainType: "group_type_role", domainId: 99, authId: 1, dataId: null, type: "grant", meta: { modifiedPid: 1 } }, // unmanaged domainId → ignored
    ]) };
    const { items, fetchErrors } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]);     // 1113 unscoped already present
    expect(items[0]?.diff.toDelete).toEqual([]);  // domainId 99 is unmanaged → invisible
  });

  it("multi-scope grant is idempotent against ChurchTools's one-row-per-dataId read shape (no churn)", async () => {
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 8, authId: 1104, dataId: 42, type: "grant", meta: { modifiedPid: 1 } },
      { domainType: "group_type_role", domainId: 8, authId: 1104, dataId: 7, type: "grant", meta: { modifiedPid: 1 } },
    ]) };
    const { items, fetchErrors } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchgroup:view group", scope: ["kids_area", "other"] },
      ]}]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]);
    expect(items[0]?.diff.toDelete).toEqual([]);
  });

  it("resolves a group_role domain by (group, role) reference and reconciles idempotently (#25)", async () => {
    const client = { get: vi.fn(async (path: string) => {
      if (path === "/groups/42/roles") return [{ id: 2882, name: "Leiter" }];
      if (path === "/permissions/group_role") return [
        { domainType: "group_role", domainId: 2882, authId: 1104, dataId: 42, type: "grant", meta: { modifiedPid: 1 } },
      ];
      throw new Error(`unexpected path ${path}`);
    }) };
    // Declared with ZERO numeric ids: right name + group key + role name only.
    const { items, warnings, fetchErrors } = await buildPermissionPlan(client as never, state, [
      { key: "kids_lead", domainType: "group_role", domainId: ref.groupRole("kids_area", "Leiter"),
        grants: [{ right: "churchgroup:view group", scope: ["kids_area"] }] },
    ]);
    expect(fetchErrors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(items[0]?.domainId).toBe(2882);          // resolved from the (group, role) pair
    expect(items[0]?.diff.toPut).toEqual([]);        // adopted live row already matches → no-op
    expect(items[0]?.diff.toDelete).toEqual([]);
  });

  it("warns and never revokes a live grant whose authId is unknown to the catalog (#25)", async () => {
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 8, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 1 } },   // known + desired
      { domainType: "group_type_role", domainId: 8, authId: 987654, dataId: null, type: "grant", meta: { modifiedPid: 1 } }, // unknown authId
    ]) };
    const { items, warnings } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }]);
    expect(items[0]?.diff.toDelete).toEqual([]); // the unnameable grant is NOT proposed for revocation
    expect(items[0]?.diff.toPut).toEqual([]);
    expect(warnings.some((w) => w.includes("987654") && w.includes("group_type_role #8"))).toBe(true);
  });

  it("reconciles admin-authored member rights; excludes system-baseline + inherited rows (#65)", async () => {
    // eqrm prod, group_type_role 9: admin-authored churchdb:+… MEMBER rights (authId >= 10000,
    // isInherited:false, modifiedPid != -1) ARE managed — an undeclared one must be revoked. The
    // self-re-adding system baseline (modifiedPid === -1) and truly-inherited rows are excluded by
    // normalizeActual and NEVER revoked (the #65 bug was "0 to grant, 24 to remove"). The boundary is
    // inheritance + system-baseline, NOT the authId — so the excluded rows below carry authId >= 10000 too.
    const client = { get: vi.fn(async () => [
      // declared writable grant — matches, no diff
      { domainType: "group_type_role", domainId: 9, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 5 } },
      // admin-authored member right (authId >= 10000, pid 5) that is UNDECLARED → must be revoked
      { domainType: "group_type_role", domainId: 9, authId: 10107, dataId: null, type: "grant", meta: { modifiedPid: 5 } },
      // system baseline + inherited (authId >= 10000) → excluded, never revoked
      { domainType: "group_type_role", domainId: 9, authId: 10122, dataId: null, type: "grant", meta: { modifiedPid: -1 } },
      { domainType: "group_type_role", domainId: 9, authId: 10111, dataId: null, type: "grant", isInherited: true },
    ]) };
    const { items, warnings, fetchErrors } = await buildPermissionPlan(client as never, state,
      [{ key: "struktur", domainType: "group_type_role", domainId: 9, grants: ["churchgroup:administer groups"] }]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]); // the declared writable grant already matches
    // the undeclared admin-authored member right IS revoked; the baseline + inherited rows are NOT
    expect(items[0]?.diff.toDelete).toEqual([{ authId: 10107, dataId: [], type: "grant" }]);
    // the old "inherited right" informational warning is gone (that authId-based exclusion is removed)
    expect(warnings.filter((w) => w.includes("inherited right"))).toHaveLength(0);
  });

  it("reconciles admin-authored authId >= 10000 rights on group_role too (no authId cutoff, #65)", async () => {
    // No authId cutoff on either domain: on group_role the churchdb:+… rights ARE writable/declarable,
    // so a live admin-authored one that is undeclared must still be revoked (no blanket exclusion).
    const client = { get: vi.fn(async (path: string) => {
      if (path === "/groups/42/roles") return [{ id: 2882, name: "Leiter" }];
      if (path === "/permissions/group_role") return [
        { domainType: "group_role", domainId: 2882, authId: 10122, dataId: null, type: "grant", meta: { modifiedPid: 5 } },
      ];
      throw new Error(`unexpected path ${path}`);
    }) };
    const { items } = await buildPermissionPlan(client as never, state, [
      { key: "kids_lead", domainType: "group_role", domainId: ref.groupRole("kids_area", "Leiter"), grants: [] },
    ]);
    expect(items[0]?.diff.toDelete).toEqual([{ authId: 10122, dataId: [], type: "grant" }]);
  });

  it("still revokes a REAL user-authored grant (authId < 10000) that is undeclared (#65 guard)", async () => {
    // Regression guard: the inherited-rights exclusion must NOT swallow ordinary undeclared grants —
    // those are exactly the drift a plan is meant to surface as a revoke.
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 9, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 5 } }, // declared
      { domainType: "group_type_role", domainId: 9, authId: 1104, dataId: 42, type: "grant", meta: { modifiedPid: 5 } },   // undeclared user grant
      { domainType: "group_type_role", domainId: 9, authId: 10101, dataId: null, type: "grant", isInherited: true },        // inherited → excluded
    ]) };
    const { items } = await buildPermissionPlan(client as never, state,
      [{ key: "struktur", domainType: "group_type_role", domainId: 9, grants: ["churchgroup:administer groups"] }]);
    expect(items[0]?.diff.toDelete).toEqual([{ authId: 1104, dataId: [42], type: "grant" }]);
  });

  it("warns when the instance CT version differs from the catalog's recorded version (#25)", async () => {
    const client = { get: vi.fn(async () => []) };
    const { warnings } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }],
      [], undefined, "9.99.0");
    expect(warnings.some((w) => /catalog was captured from ChurchTools .* but this instance\s+runs 9\.99\.0/is.test(w))).toBe(true);
  });

  it("does NOT warn about staleness when the instance version matches the catalog version (#25)", async () => {
    const client = { get: vi.fn(async () => []) };
    const { warnings } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }],
      [], undefined, CATALOG_META!.ctVersion);
    expect(warnings).toEqual([]);
  });
  // The PERSON-status domain end to end (#90): a `personStatus` ref resolves against /statuses, the
  // planner bulk-fetches /permissions/status, and the live `dataId: -1` ALL sentinel round-trips to
  // a clean no-op — which is the whole point (an instance-wide grant that churned every plan would
  // rewrite everyone's rights on every apply).
  it("resolves a status domain by person-status name and reconciles the -1 ALL sentinel idempotently", async () => {
    const client = { get: vi.fn(async (path: string) => {
      if (path === "/statuses") return [{ id: 4, name: "3 - Group Active" }, { id: 6, name: "5 - Core" }];
      if (path === "/permissions/status") return [
        { domainType: "status", domainId: 6, authId: 18, dataId: -1, type: "grant", meta: { modifiedPid: 1 } },
      ];
      throw new Error(`unexpected path ${path}`);
    }) };
    const { items, warnings, fetchErrors } = await buildPermissionPlan(client as never, state, [
      { key: "core_login", domainType: "status", domainId: ref.personStatus("5 - Core"),
        grants: [{ right: "churchcore:login to external system", scope: [-1] }] },
    ]);
    expect(fetchErrors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(items[0]?.domainId).toBe(6);       // resolved from the /statuses catalog
    expect(items[0]?.diff.toPut).toEqual([]); // live -1 row matches the declaration
    expect(items[0]?.diff.toDelete).toEqual([]);
  });

  it("proposes the status grant on a status that does not carry it yet", async () => {
    const client = { get: vi.fn(async (path: string) => {
      if (path === "/statuses") return [{ id: 4, name: "3 - Group Active" }];
      if (path === "/permissions/status") return [];
      throw new Error(`unexpected path ${path}`);
    }) };
    const { items } = await buildPermissionPlan(client as never, state, [
      { key: "group_active_login", domainType: "status", domainId: ref.personStatus("3 - Group Active"),
        grants: [{ right: "churchcore:login to external system", scope: [-1] }] },
    ]);
    expect(items[0]?.domainId).toBe(4);
    expect(items[0]?.diff.toPut).toEqual([{ authId: 18, dataId: [-1], type: "grant" }]);
  });
});
