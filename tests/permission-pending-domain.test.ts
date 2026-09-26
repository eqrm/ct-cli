/**
 * Pending permission domains: a permission domain declared BY REFERENCE to a resource created in the
 * SAME run plans as a pending grant block and reconciles at apply time, mirroring resource pending
 * refs (#20/#46) and the scope pending path (#29).
 *
 * #69 introduced this for a `group_type_role` domain named by its group type. #182 found that domain
 * was never the group type: `/permissions/group_type_role/<id>` is keyed by ROLE id, so the pending
 * path wrote to whichever role shared the fresh type's number. A group-type Ref is now refused for
 * that domain, and a group-type-role Ref on a same-run group type is a plan-time error until it can
 * go pending (#189). The group_role pending path (#106) is unaffected.
 *
 * Exercises the REAL build → execute → apply sequence with a mock client. No live instance.
 */
import { describe, it, expect, vi } from "vitest";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { renderPermissionPlan } from "../src/permissions/render.js";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import { ref } from "../src/resolve/refs.js";
import { Resolver } from "../src/resolve/resolver.js";
import type { Plan, DesiredResource } from "../src/engine/types.js";
import type { DesiredPermission } from "../src/permissions/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const HOST = "https://mychurch.church.tools";
const STRUKTUR_TYPE_ID = 9;

/** A mock client: POST /group/grouptypes mints STRUKTUR_TYPE_ID; GETs return whatever `perms` maps. */
function mockClient(perms: Record<string, unknown[]> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/group/grouptypes") return { id: STRUKTUR_TYPE_ID };
    return {};
  });
  const get = vi.fn(async (path: string) => (perms[path] ?? []) as unknown[]);
  return { client: { request, get } as unknown as CtClient, calls, get };
}

const strukturType: DesiredResource[] = [
  { type: "group-type", key: "struktur", fields: { name: "Struktur" }, dependsOn: [] },
];
const grants = ["churchgroup:administer groups"];

describe("group_type_role is keyed by role, not by group type (#182)", () => {
  it("refuses a group-type Ref as the domain instead of writing to the type id", async () => {
    // Before #182 this resolved to STRUKTUR_TYPE_ID and granted on whichever ROLE carries that id.
    const { client, get } = mockClient({ "/group/grouptypes": [{ id: STRUKTUR_TYPE_ID, name: "Struktur" }] });
    const typePerm: DesiredPermission = {
      key: "struktur_roles",
      domainType: "group_type_role",
      domainId: ref.groupType("struktur"),
      grants,
    };
    await expect(buildPermissionPlan(client, emptyState(HOST), [typePerm], [])).rejects.toThrow(
      /group_type_role "struktur_roles".domainId: a group type \(group-type:struktur\) does not name a group_type_role domain/,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("hard-errors (not pending) on a role of a group type created this run, until #189", async () => {
    const { client } = mockClient();
    const rolePerm: DesiredPermission = {
      key: "struktur_leiter",
      domainType: "group_type_role",
      domainId: ref.groupTypeRole("struktur", "Leiter"),
      grants,
    };
    await expect(buildPermissionPlan(client, emptyState(HOST), [rolePerm], strukturType)).rejects.toThrow(
      /group type "struktur" is declared in this config but not yet created/,
    );
  });

  it("still hard-errors on a TRUE typo — the resolver's notFound message", async () => {
    // "strucktur" is neither declared, nor in state, nor a live catalog match → genuinely unresolvable.
    const typoPerm: DesiredPermission = {
      key: "struktur_leiter",
      domainType: "group_type_role",
      domainId: ref.groupTypeRole("strucktur", "Leiter"),
      grants,
    };
    const { client } = mockClient({ "/group/grouptypes": [{ id: STRUKTUR_TYPE_ID, name: "Struktur" }] });
    await expect(buildPermissionPlan(client, emptyState(HOST), [typoPerm], strukturType)).rejects.toThrow(
      /Cannot resolve group-type:strucktur referenced at group_type_role "struktur_leiter".domainId/,
    );
  });
});

describe("group_role symmetry: a same-run group DOES go pending and completes in one apply (#106)", () => {
  // The domain half of #29's deadlock. A group_role domainId is the (group, role) PAIRING id, exposed
  // only on GET /groups/{id}/roles — so it cannot be completed from post-execute state alone the way a
  // person-status domain can. It is completed with a live fetch inside applyPermissionPlan instead.
  // Before #106 this was a hard error, which made the very same config plan clean on prod (group
  // exists) and exit 1 on dev (group does not) — non-portable by construction.
  const GROUP_ID = 4711;
  const PAIRING_ID = 44675;

  const declaredGroup: DesiredResource[] = [
    { type: "group", key: "kids_area", fields: { name: "Kids" }, dependsOn: [] },
  ];
  const grPerm: DesiredPermission = {
    key: "kids_lead",
    domainType: "group_role",
    domainId: ref.groupRole("kids_area", "Leiter"),
    grants: ["churchgroup:administer groups"],
  };
  const createGroupPlan: Plan = {
    items: [
      {
        type: "group",
        key: "kids_area",
        id: null,
        action: "create",
        changes: [{ field: "name", from: undefined, to: "Kids" }],
      },
    ],
  };

  /** Like `mockClient`, but POST /groups mints GROUP_ID and the group's role list is readable. */
  function groupClient(roles: unknown[] = [{ id: PAIRING_ID, name: "Leiter", groupTypeRoleId: 12 }]) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/groups") return { id: GROUP_ID };
      return {};
    });
    const get = vi.fn(async (path: string) => (path === `/groups/${GROUP_ID}/roles` ? roles : []));
    return { client: { request, get } as unknown as CtClient, calls, get };
  }

  it("plans from EMPTY state as a pending domain instead of the old hard error", async () => {
    const { client, get } = groupClient();
    const { items, fetchErrors } = await buildPermissionPlan(
      client,
      emptyState(HOST),
      [grPerm],
      declaredGroup,
    );

    expect(fetchErrors).toEqual([]);
    expect(items[0]?.domainId).toBeNull();
    expect(items[0]?.pendingDomain).toEqual(ref.groupRole("kids_area", "Leiter"));
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1113, dataId: [], type: "grant" }]);
    // Nothing is fetched at plan time — the group does not exist yet, so neither does its role list.
    expect(get).not.toHaveBeenCalled();
    expect(renderPermissionPlan(items)).toContain(
      "<group-role(group=kids_area, role=Leiter) (created this apply)>",
    );
  });

  it("applies in ONE run — create the group, read its roles, grant on the pairing id", async () => {
    const { client, calls, get } = groupClient();
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [grPerm], declaredGroup);

    await executePlan(createGroupPlan, { client, state, statePath: "unused", save: async () => {} });
    expect(state.resources.kids_area?.id).toBe(GROUP_ID);

    const res = await applyPermissionPlan(items, client, state);
    expect(res.granted).toBe(1);
    expect(res.failed).toEqual([]);
    // The role list is read from the FRESHLY created group, and the pairing id — not the group id —
    // is what lands in the write path.
    expect(get).toHaveBeenCalledWith(`/groups/${GROUP_ID}/roles`);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/permissions/group_role/${PAIRING_ID}`);
    expect(put?.body).toEqual({ authId: 1113, type: "grant" });
  });

  it("still hard-errors on a role the created group does not have, listing what it does have", async () => {
    const { client } = groupClient([
      { id: PAIRING_ID, name: "Mitglied" },
      { id: PAIRING_ID + 1, name: "Organisator" },
    ]);
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [grPerm], declaredGroup);
    await executePlan(createGroupPlan, { client, state, statePath: "unused", save: async () => {} });

    await expect(applyPermissionPlan(items, client, state)).rejects.toThrow(
      /group #4711 has no role named "Leiter" \(available: "Mitglied", "Organisator"\)/,
    );
  });

  it("survives a client whose reads are PROTOTYPE methods using `this` (the real CtClient shape)", async () => {
    // Regression guard. `applyPermissionPlan` hands the role-list fetcher a narrowed reading client;
    // building that as `{ get: client.get }` DETACHES the method from its instance, so the real
    // CtClient — whose `get` calls `this.requestEnvelope` internally — dies with "this.… is not a
    // function" on every pending group_role domain. The plain-object doubles above cannot catch it
    // (they close over nothing), so this double mimics the class: state on `this`, method on the
    // prototype.
    class ProtoClient {
      readonly seen: string[] = [];
      async request(method: string, path: string, body?: unknown): Promise<unknown> {
        this.seen.push(`${method} ${path}`);
        void body;
        return method === "POST" && path === "/groups" ? { id: GROUP_ID } : {};
      }
      async get(path: string): Promise<unknown> {
        // The load-bearing part: reaching a sibling through `this`, exactly as CtClient.get does.
        this.seen.push(`GET ${path}`);
        return path === `/groups/${GROUP_ID}/roles`
          ? [{ id: PAIRING_ID, name: "Leiter", groupTypeRoleId: 12 }]
          : [];
      }
    }
    const proto = new ProtoClient();
    const client = proto as unknown as CtClient;
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [grPerm], declaredGroup);
    await executePlan(createGroupPlan, { client, state, statePath: "unused", save: async () => {} });

    const res = await applyPermissionPlan(items, client, state);
    expect(res.failed).toEqual([]);
    expect(res.granted).toBe(1);
    expect(proto.seen).toContain(`GET /groups/${GROUP_ID}/roles`);
    expect(proto.seen).toContain(`PUT /permissions/group_role/${PAIRING_ID}`);
  });

  it("is unchanged on a host where the group already exists — concrete domain, no pending path", async () => {
    const { client, get } = groupClient();
    const state: State = {
      version: 1,
      host: HOST,
      resources: {
        kids_area: {
          type: "group",
          id: GROUP_ID,
          key: "kids_area",
          fields: { name: "Kids" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const { items, fetchErrors } = await buildPermissionPlan(client, state, [grPerm], declaredGroup);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.pendingDomain).toBeUndefined();
    expect(items[0]?.domainId).toBe(PAIRING_ID);
    // Resolved at PLAN time here, from the already-existing group's role list.
    expect(get).toHaveBeenCalledWith(`/groups/${GROUP_ID}/roles`);
  });

  it("keeps the fail-fast message where a pending group_role can NOT be completed (query var)", async () => {
    // Only the permission-domain position opts into pending group-roles, because only it gets a live
    // fetch after the group exists. A group-role ref anywhere else keeps the old actionable error.
    const resolver = new Resolver({
      client: { get: async () => [] } as unknown as CtClient,
      state: emptyState(HOST),
      desired: declaredGroup,
    });
    await expect(
      resolver.resolve(ref.groupRole("kids_area", "Leiter"), 'dynamic group "x" var'),
    ).rejects.toThrow(/group "kids_area" is declared in this config but not yet created/);
  });
});
