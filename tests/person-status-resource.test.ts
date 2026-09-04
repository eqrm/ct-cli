/**
 * Person statuses as a declarable resource (#96).
 *
 * Before this, `ct.status` could declare grants ON a person status but the status itself could not
 * be declared, adopted or created — so a config using the `status` domain was NOT self-sufficient
 * across hosts: every target instance had to already carry a byte-identically-named status, created
 * by hand. The resolver even advised "Declare/adopt it", which was impossible. These tests pin that
 * the whole loop now closes: declare → resolve (state first, catalog second) → create → grant.
 */
import { describe, it, expect, vi } from "vitest";
import { RESOURCES, resourceType, knownFields } from "../src/resources/registry.js";
import { isKnownType } from "../src/engine/graph.js";
import { createContext } from "../src/config/context.js";
import { Resolver } from "../src/resolve/resolver.js";
import { ref } from "../src/resolve/refs.js";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { executePlan } from "../src/engine/execute.js";
import { assertNotPeople } from "../src/engine/guard.js";
import { emptyState, type State } from "../src/state/state.js";
import type { DesiredPermission } from "../src/permissions/types.js";
import type { DesiredResource, Plan } from "../src/engine/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const HOST = "https://mychurch.church.tools";

describe("the person-status registry entry", () => {
  it("is CRUD-wired against /statuses", () => {
    const spec = resourceType("person-status");
    expect(spec.collectionPath).toBe("/statuses");
    expect(spec.itemPath(3)).toBe("/statuses/3");
    expect(spec.updateMethod).toBe("PUT");
  });

  it("keys by the status NAME — the same slug the /statuses ref resolver matches on", () => {
    expect(RESOURCES["person-status"]?.deriveKey({ id: 3, name: "3 - Group Active" })).toBe("3_group_active");
  });

  it("manages the WHOLE required PUT contract — a subset would 400 and blank the rest", () => {
    // Live-probed 2026-08-13 (eqrm prod, CT 3.135.2) against the instance's own OpenAPI spec:
    //   PUT /statuses/{id} required: name, shorty, isMember, isSearchable, sortKey, securityLevelId
    // Uniquely strict among managed types (campus/age-group/target-group/group-role/group-type PUTs
    // declare no required fields at all). The executor sends the declared bag as a full-replace PUT,
    // so anything left unmanaged here would be dropped from the body — a 400, or a silent blanking.
    expect([...knownFields("person-status")].sort()).toEqual([
      "isMember",
      "isSearchable",
      "name",
      "securityLevelId",
      "shorty",
      "sortKey",
    ]);
    expect(
      RESOURCES["person-status"]?.managedFields({
        id: 3,
        name: "3 - Group Active",
        shorty: "GA",
        isMember: true,
        isSearchable: false,
        sortKey: 30,
        securityLevelId: 1,
        extra: 1,
      }),
    ).toEqual({
      name: "3 - Group Active",
      shorty: "GA",
      isMember: true,
      isSearchable: false,
      sortKey: 30,
      securityLevelId: 1,
    });
  });

  it("declares NO create defaults — every POST-required field is already managed", () => {
    // POST /statuses requires name, shorty, isMember (same probe) — all three are in managedFields,
    // so a create-only default would only diverge from what the update path sends.
    expect(resourceType("person-status").createDefaults).toBeUndefined();
  });

  it("has an apply tier, so the engine can order it", () => {
    expect(isKnownType("person-status")).toBe(true);
    expect(resourceType("person-status").tier).toBe(0); // master data — before groups
  });

  it("is master data, not a people surface — the people guard does not (and must not) block it", () => {
    expect(() => assertNotPeople("/statuses")).not.toThrow();
    expect(() => assertNotPeople("/statuses/3")).not.toThrow();
    expect(() => assertNotPeople("/persons/3")).toThrow(/never managed/);
  });
});

describe("ct.personStatus in the config DSL", () => {
  it("declares a person-status resource", () => {
    const { ct, resources } = createContext();
    ct.personStatus({ key: "group_active", name: "3 - Group Active", shorty: "GA" });
    expect(resources[0]).toMatchObject({
      type: "person-status",
      key: "group_active",
      fields: { name: "3 - Group Active", shorty: "GA" },
    });
  });

  it("warns on a field the registry does not manage, rather than silently ignoring it", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { ct, resources } = createContext();
      ct.personStatus({ key: "s", name: "3 - Group Active", nameTranslated: "Group Active" });
      expect(String(spy.mock.calls[0]![0])).toContain(
        'person-status "s": unknown field "nameTranslated" (ignored)',
      );
      expect(resources[0]?.fields).toHaveProperty("nameTranslated", "Group Active"); // still passed through
    } finally {
      spy.mockRestore();
    }
  });
});

describe("resolving a personStatus reference", () => {
  const client = {
    get: vi.fn(async (path: string) =>
      path === "/statuses/3" ? { id: 3, name: "3 - Group Active" } : [{ id: 3, name: "3 - Group Active" }],
    ),
  };

  it("prefers a MANAGED status in state over the live /statuses catalog", async () => {
    const state: State = {
      version: 1,
      host: HOST,
      resources: {
        group_active: {
          type: "person-status",
          id: 8,
          key: "group_active",
          fields: {},
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const resolver = new Resolver({ client: client as never, state, desired: [] });
    expect(await resolver.resolve(ref.personStatus("group_active"), "site")).toBe(8);
  });

  it("resolves an explicitly bound external status", async () => {
    const state = emptyState(HOST);
    state.externals!["3_group_active"] = {
      type: "person-status",
      id: 3,
      key: "3_group_active",
      identity: { name: "3 - Group Active" },
      boundAt: "t",
    };
    const resolver = new Resolver({ client: client as never, state, desired: [] });
    expect(await resolver.resolve(ref.personStatus("3_group_active"), "site")).toBe(3);
  });
});

describe("declare a status AND grants on it, in one config (the #96 trap)", () => {
  const desired: DesiredResource[] = [
    { type: "person-status", key: "group_active", fields: { name: "3 - Group Active" }, dependsOn: [] },
  ];
  const perm: DesiredPermission = {
    key: "group_active_login",
    domainType: "status",
    domainId: ref.personStatus("group_active"),
    grants: [{ right: "churchcore:login to external system", scope: [-1] }],
  };

  function mockClient(newId: number) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/statuses") return { id: newId };
      return {};
    });
    // A FRESH instance: /statuses is empty, so the old catalog-only path would hard-error here.
    const get = vi.fn(async () => [] as unknown[]);
    return { client: { request, get } as unknown as CtClient, calls };
  }

  it("plans without the 'no managed resource and no live person-status' hard error", async () => {
    const { client } = mockClient(9);
    const { items, fetchErrors } = await buildPermissionPlan(client, emptyState(HOST), [perm], desired);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.domainId).toBeNull(); // pending: the status is created in this same run
    expect(items[0]?.pendingDomain).toEqual(ref.personStatus("group_active"));
    expect(items[0]?.diff.toPut).toHaveLength(1);
  });

  it("applies in one run — the grant is written against the id the status create returned", async () => {
    const { client, calls } = mockClient(9);
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [perm], desired);

    const createStatus: Plan = {
      items: [
        {
          type: "person-status",
          key: "group_active",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "3 - Group Active" }],
        },
      ],
    };
    await executePlan(createStatus, { client, state, statePath: "unused", save: async () => {} });
    expect(state.resources.group_active?.id).toBe(9);

    const res = await applyPermissionPlan(items, client, state);
    expect(res.granted).toBe(1);
    expect(calls.some((c) => c.method === "PUT" && c.path === "/permissions/status/9")).toBe(true);
  });
});
