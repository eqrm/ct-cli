/**
 * Scope-resolution bootstrap + stale-id-after-recreate (#29, #33 item 3).
 *
 * Exercises the REAL build → execute → apply sequence with a mock client, so the
 * shared re-resolution point is proven end-to-end: a scope key naming a group
 * created (or recreated) in the same apply is resolved to that group's fresh id.
 */
import { describe, it, expect, vi } from "vitest";
import { buildPermissionPlan, desiredTuples } from "../src/permissions/plan.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { renderPermissionPlan } from "../src/permissions/render.js";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import type { Plan, DesiredResource } from "../src/engine/types.js";
import type { DesiredPermission } from "../src/permissions/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const HOST = "https://mychurch.church.tools";

// churchgroup:view group — authId 1104, scoped (scopeField cdb_gruppe).
const scopedPerm: DesiredPermission = {
  key: "gtr",
  domainType: "group_type_role",
  domainId: 8,
  grants: [{ right: "churchgroup:view group", scope: ["kids"] }],
};
const desiredKidsGroup: DesiredResource[] = [
  { type: "group", key: "kids", fields: { name: "Kids" }, dependsOn: [] },
];

/** A mock client: GET /permissions/* returns no existing rows; POST /groups mints `newId`. */
function mockClient(newId: number) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/groups") return { id: newId };
    return {};
  });
  const get = vi.fn(async () => [] as unknown[]);
  return { client: { request, get } as unknown as CtClient, calls };
}

const createKidsPlan: Plan = {
  items: [{ type: "group", key: "kids", id: null, action: "create", changes: [{ field: "name", from: undefined, to: "Kids" }] }],
};

describe("scope bootstrap: declare group + grant scoped to it in one config (#29)", () => {
  it("plans cleanly from empty state — no throw, grant rendered as pending", async () => {
    const { client } = mockClient(555);
    const state = emptyState(HOST);
    const { items, fetchErrors } = await buildPermissionPlan(client, state, [scopedPerm], desiredKidsGroup);
    expect(fetchErrors).toEqual([]);
    // The scoped grant survives planning and lands in toPut as a pending tuple.
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1104, dataId: [], type: "grant", scopeKey: "kids", scopeType: "group", pending: true }]);
    // Read-only `ct plan` renders instead of aborting, and labels the pending scope.
    expect(renderPermissionPlan(items)).toContain("kids (created this apply)");
  });

  it("applies cleanly in ONE run — grant PUT carries the id the group create returned", async () => {
    const { client, calls } = mockClient(555);
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [scopedPerm], desiredKidsGroup);

    await executePlan(createKidsPlan, { client, state, statePath: "unused", save: async () => {} });
    expect(state.resources.kids?.id).toBe(555); // executePlan upserted the real id

    const res = await applyPermissionPlan(items, client, state);
    expect(res.granted).toBe(1);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/permissions/group_type_role/8");
    expect(put?.body).toEqual({ authId: 1104, type: "grant", dataId: [555] }); // the FRESH id, not a pending placeholder
  });
});

describe("stale id after recreate (#33 item 3)", () => {
  it("re-resolves the scope dataId against post-execute state — grant PUT carries the NEW id", async () => {
    const { client, calls } = mockClient(777);
    // Pre-apply state has kids under a stale id 100 (it vanished from CT and will be recreated).
    const state: State = { version: 1, host: HOST, resources: {
      kids: { type: "group", id: 100, key: "kids", fields: { name: "Kids" }, adoptedAt: "t", updatedAt: "t" },
    }};
    const { items } = await buildPermissionPlan(client, state, [scopedPerm], desiredKidsGroup);
    // At plan time the tuple resolves to the OLD id 100…
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1104, dataId: [100], type: "grant", scopeKey: "kids", scopeType: "group" }]);

    // …then a recreate mints id 777 in state.
    await executePlan(createKidsPlan, { client, state, statePath: "unused", save: async () => {} });
    expect(state.resources.kids?.id).toBe(777);

    await applyPermissionPlan(items, client, state);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/permissions/group_type_role/8");
    expect(put?.body).toEqual({ authId: 1104, type: "grant", dataId: [777] }); // NOT the stale 100
  });
});

describe("truly-unknown scope key still hard-fails (#29 acceptance)", () => {
  it("throws the clear error when a key is neither in state nor declared", () => {
    expect(() => desiredTuples(scopedPerm, emptyState(HOST), new Set())).toThrow(/scope key "kids" does not resolve/i);
  });
});
