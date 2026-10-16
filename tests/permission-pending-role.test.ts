/**
 * Pending ROLE definitions in a `group_role` domain (#120).
 *
 * #106 made "declare a group + a `ct.groupRole` on it in one config" work against a host that lacks
 * the group. The same was NOT true when the missing piece was the ROLE: the resolver only ever
 * considered pending groups, so a `groupRole` naming a `roleDefinition` declared three lines up
 * hard-errored — with a message ("Fix the role name, or pass a numeric id") whose two remedies are
 * both wrong for a shared, multi-host config. Role definitions are per group type and drift easily
 * between two hosts of one instance, which is exactly when this bites.
 */
import { describe, it, expect, vi } from "vitest";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { executePlan } from "../src/engine/execute.js";
import { Resolver } from "../src/resolve/resolver.js";
import { emptyState } from "../src/state/state.js";
import { ref } from "../src/resolve/refs.js";
import type { DesiredResource, Plan } from "../src/engine/types.js";
import type { DesiredPermission } from "../src/permissions/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const HOST = "https://mychurch.church.tools";
const GROUP_ID = 864;

/** The group exists on this host; the custom "Admin" role does not (only CT's stock roles do). */
const STOCK_ROLES = [
  { id: 11, name: "Systemdesign" },
  { id: 12, name: "leader" },
  { id: 13, name: "participant" },
];

/** Config declares the role definition AND a grant block that names it — the #120 shape. */
const desired: DesiredResource[] = [
  {
    type: "group-role",
    key: "appmodule_admin",
    fields: { name: "Admin", nameTranslated: "Admin", groupTypeId: 30 },
    dependsOn: [],
  },
];

const grantBlock: DesiredPermission = {
  key: "amflowsequip_admin",
  domainType: "group_role",
  domainId: ref.groupRole("amflowsequip", "Admin"),
  grants: ["churchgroup:administer groups"],
};

function mockClient(roles: unknown[]) {
  const get = vi.fn(async (path: string) => {
    if (path === `/groups/${GROUP_ID}/roles`) return roles;
    return [];
  });
  return { get, request: vi.fn(async () => ({})) } as unknown as CtClient;
}

function stateWithGroup() {
  const state = emptyState(HOST);
  state.resources.amflowsequip = {
    type: "group",
    id: GROUP_ID,
    key: "amflowsequip",
    fields: { name: "AM Flows Equip" },
    adoptedAt: "t",
    updatedAt: "t",
  };
  return state;
}

describe("pending role definition in a group_role domain (#120)", () => {
  it("plans as pending instead of hard-erroring when the role is declared in the same config", async () => {
    const state = stateWithGroup();
    const client = mockClient(STOCK_ROLES);
    const { items, fetchErrors } = await buildPermissionPlan(client, state, [grantBlock], desired);

    expect(fetchErrors).toEqual([]);
    expect(items).toHaveLength(1);
    // The domain is deferred to apply time, exactly like a pending GROUP (#106).
    expect(items[0]?.pendingDomain).toEqual(ref.groupRole("amflowsequip", "Admin"));
  });

  it("still hard-errors when the role is NOT declared anywhere — that is a real config mistake", async () => {
    const state = stateWithGroup();
    const client = mockClient(STOCK_ROLES);
    const orphan: DesiredPermission = {
      ...grantBlock,
      domainId: ref.groupRole("amflowsequip", "Nonexistent"),
    };

    await expect(buildPermissionPlan(client, state, [orphan], [])).rejects.toThrow(
      /has no role named "Nonexistent"/,
    );
  });

  // Role NAMES repeat across group types (live prod: 3 "Leiter", 6 "Organisator", 6 "Mitglied"), so
  // "a roleDefinition by this name is declared" cannot on its own mean "it will land on THIS group".
  // Reading it that way turns a plain config error into a pending domain, deferring the failure past
  // executePlan to the post-apply fetch — same message, but only after the resource tier has written.
  it("hard-errors at PLAN time when the declared role is for a different group type", async () => {
    const state = stateWithGroup();
    // The group is of type 99; the declared "Admin" roleDefinition is for type 30.
    state.resources.amflowsequip!.fields.groupTypeId = 99;
    const client = mockClient(STOCK_ROLES);

    await expect(buildPermissionPlan(client, state, [grantBlock], desired)).rejects.toThrow(
      /has no role named "Admin"/,
    );
  });

  it("still plans as pending when the declared role IS for this group's type", async () => {
    const state = stateWithGroup();
    state.resources.amflowsequip!.fields.groupTypeId = 30; // matches the declaration
    const client = mockClient(STOCK_ROLES);
    const { items } = await buildPermissionPlan(client, state, [grantBlock], desired);
    expect(items[0]?.pendingDomain).toEqual(ref.groupRole("amflowsequip", "Admin"));
  });

  it("stays lenient when state does not record the group's type — #120 behaviour, unchanged", async () => {
    // `stateWithGroup` records no groupTypeId, which is the shape of an entry adopted before it was
    // managed. Nothing offline can contradict the declaration, so the pending path is kept.
    const state = stateWithGroup();
    expect(state.resources.amflowsequip?.fields.groupTypeId).toBeUndefined();
    const { items } = await buildPermissionPlan(mockClient(STOCK_ROLES), state, [grantBlock], desired);
    expect(items[0]?.pendingDomain).toBeTruthy();
  });

  it("resolves normally once the role exists on the host — no spurious pending", async () => {
    const state = stateWithGroup();
    const client = mockClient([...STOCK_ROLES, { id: 114, name: "Admin" }]);
    const { items } = await buildPermissionPlan(client, state, [grantBlock], desired);
    expect(items[0]?.pendingDomain).toBeUndefined();
    expect(items[0]?.domainId).toBe(114);
  });

  it("applies in ONE run — create the role definition, re-read the roles, grant on the pairing id", async () => {
    // The whole point of #120: two merges become one. Role definitions are tier 3, which executes
    // before permissions, so by the time the domain is completed the role is on the group's list.
    const NEW_PAIRING_ID = 114;
    let roleCreated = false;
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const client = {
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (method === "POST" && path === "/group/roles") {
          roleCreated = true;
          return { id: 77 };
        }
        return {};
      }),
      get: vi.fn(async (path: string) =>
        path === `/groups/${GROUP_ID}/roles`
          ? roleCreated
            ? [...STOCK_ROLES, { id: NEW_PAIRING_ID, name: "Admin" }]
            : STOCK_ROLES
          : [],
      ),
    } as unknown as CtClient;

    const state = stateWithGroup();
    const { items } = await buildPermissionPlan(client, state, [grantBlock], desired);
    expect(items[0]?.pendingDomain).toBeTruthy(); // planned before the role exists

    await executePlan(
      {
        items: [
          {
            type: "group-role",
            key: "appmodule_admin",
            id: null,
            action: "create",
            changes: [
              { field: "name", from: undefined, to: "Admin" },
              { field: "groupTypeId", from: undefined, to: 30 },
            ],
          },
        ],
      } as unknown as Plan,
      { client, state, statePath: "unused", save: async () => {} },
    );

    const res = await applyPermissionPlan(items, client, state);
    expect(res.failed).toEqual([]);
    expect(res.granted).toBe(1);
    // The grant lands on the pairing id of the role created moments earlier — in the SAME run.
    expect(calls.find((c) => c.method === "PUT")?.path).toBe(`/permissions/group_role/${NEW_PAIRING_ID}`);
  });

  it("the direct resolver error names the real remedy, not 'fix the role name'", async () => {
    // Outside the permission-domain position there is nothing to finish a pending ref, so this
    // stays an error — but the message must stop recommending two things that cannot work.
    const resolver = new Resolver({ client: mockClient(STOCK_ROLES), state: stateWithGroup(), desired });
    await expect(
      resolver.resolve(ref.groupRole("amflowsequip", "Admin"), 'group_role "x".domainId'),
    ).rejects.toThrow(/declared as a roleDefinition in this config but does not exist on this host yet/);
  });

  it("fails at plan time instead of deferring when the group is only in the id map", async () => {
    // A group tofu owns is in neither ct's state nor its config. A pending domain is finished at apply
    // from state, so deferring would only fail after the resource tier had written.
    const state = emptyState(HOST);
    const client = mockClient(STOCK_ROLES);
    const idMap = { path: ".ct/ids.h.json", ids: new Map([["group\u0000amflowsequip", GROUP_ID]]) };
    const resolver = new Resolver({ client, state, desired, host: HOST, idMap });
    const plan = buildPermissionPlan(client, state, [grantBlock], desired, resolver);
    await expect(plan).rejects.toThrow(
      /"Admin" is declared as a roleDefinition.*Apply the master data first/is,
    );
  });
});
