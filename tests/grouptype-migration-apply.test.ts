import { describe, expect, it, vi } from "vitest";

import { executePlan } from "../src/engine/execute.js";
import { resolveGroupTypeMigrations } from "../src/engine/grouptype.js";
import { renderPlan } from "../src/engine/render.js";
import { emptyState, type State } from "../src/state/state.js";
import type { CtClient } from "../src/api/ctClient.js";
import type { Plan, PlanItem } from "../src/engine/types.js";

const HOST = "https://mychurch.church.tools";

/** Two types whose roles overlap partly by name — the shape #171 is about. */
const ROLE_CATALOG = [
  { id: 105, name: "Mitglied", groupTypeId: 5, type: "participant", isDefault: true },
  { id: 108, name: "Leiter", groupTypeId: 5, type: "leader", isDefault: false },
  { id: 201, name: "Supporter", groupTypeId: 5, type: "participant", isDefault: false },
  { id: 114, name: "Mitglied", groupTypeId: 4, type: "participant", isDefault: true },
  { id: 30, name: "Leiter", groupTypeId: 4, type: "leader", isDefault: false },
];

function mockClient(members: { groupTypeRoleId?: number }[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const get = vi.fn(async (path: string) => {
    if (path === "/group/roles") return ROLE_CATALOG;
    if (path.startsWith("/groups/") && path.includes("/members")) return members;
    return [];
  });
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return {};
  });
  return { client: { get, request } as unknown as CtClient, calls, get };
}

const typeChange = (): PlanItem => ({
  type: "group",
  key: "team_academy_first_year",
  displayName: "Academy First Year",
  id: 1182,
  action: "update",
  changes: [
    { field: "groupTypeId", from: 5, to: 4, source: "config" },
    { field: "name", from: "Academy", to: "Academy First Year", source: "config" },
  ],
  actual: { name: "Academy", groupTypeId: 5, groupStatusId: 1, campusId: null },
});

const planWith = (item: PlanItem): Plan => ({ items: [item] });

describe("resolveGroupTypeMigrations", () => {
  it("attaches the mapping a plan can render and an apply can send", async () => {
    const { client } = mockClient([]);
    const plan = planWith(typeChange());
    await resolveGroupTypeMigrations(client, plan, new Map());

    const migration = plan.items[0]!.groupTypeMigration;
    expect(migration).toBeDefined();
    expect(migration).toMatchObject({ fromGroupTypeId: 5, toGroupTypeId: 4 });
    expect(migration!.entries.map((e) => `${e.fromName}->${e.toName}`)).toEqual([
      "Mitglied->Mitglied",
      "Leiter->Leiter",
      "Supporter->Mitglied",
    ]);
  });

  it("issues no request at all when nothing changes type", async () => {
    const { client, get } = mockClient([]);
    const plan = planWith({
      type: "group",
      key: "g",
      id: 7,
      action: "update",
      changes: [{ field: "name", from: "a", to: "b", source: "config" }],
    });
    await resolveGroupTypeMigrations(client, plan, new Map());
    expect(get).not.toHaveBeenCalled();
    expect(plan.items[0]!.groupTypeMigration).toBeUndefined();
  });

  it("refuses at PLAN time when an occupied role has nowhere unambiguous to go", async () => {
    // Two people hold "Supporter", which type 4 has no equivalent for.
    const { client } = mockClient([{ groupTypeRoleId: 201 }, { groupTypeRoleId: 201 }]);
    const plan = planWith(typeChange());
    await expect(resolveGroupTypeMigrations(client, plan, new Map())).rejects.toThrow(
      /cannot change groupTypeId 5 -> 4 without a role mapping/,
    );
  });

  it("accepts the declared mapping that answers that refusal", async () => {
    const { client } = mockClient([{ groupTypeRoleId: 201 }, { groupTypeRoleId: 201 }]);
    const plan = planWith(typeChange());
    await resolveGroupTypeMigrations(
      client,
      plan,
      new Map([["team_academy_first_year", { Supporter: "Leiter" }]]),
    );
    expect(plan.items[0]!.groupTypeMigration!.entries.find((e) => e.fromId === 201)).toMatchObject({
      toId: 30,
      reason: "declared",
      members: 2,
    });
  });
});

describe("renderPlan — a type change must not read like an ordinary field update", () => {
  it("spells out the endpoint and every role's destination", async () => {
    const { client } = mockClient([{ groupTypeRoleId: 105 }]);
    const plan = planWith(typeChange());
    await resolveGroupTypeMigrations(client, plan, new Map());

    const out = renderPlan(plan);
    expect(out).toContain("groupTypeId: 5 -> 4");
    expect(out).toContain("via POST /groups/1182/grouptype");
    expect(out).toContain("Mitglied -> Mitglied  (1 member, matched by name)");
    expect(out).toContain("Supporter -> Mitglied  (0 members, matched by empty-role)");
  });
});

describe("executePlan — the migration endpoint, not the group PATCH", () => {
  async function applyTypeChange(members: { groupTypeRoleId?: number }[] = []) {
    const { client, calls } = mockClient(members);
    const plan = planWith(typeChange());
    await resolveGroupTypeMigrations(client, plan, new Map());
    const state: State = emptyState(HOST);
    state.resources.team_academy_first_year = {
      type: "group",
      id: 1182,
      key: "team_academy_first_year",
      fields: { name: "Academy", groupTypeId: 5, groupStatusId: 1, campusId: null },
      adoptedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await executePlan(plan, { client, state, statePath: "unused", save: async () => {} });
    return { calls, state };
  }

  it("POSTs /groups/{id}/grouptype with the rendered mapping", async () => {
    const { calls } = await applyTypeChange();
    const migration = calls.find((c) => c.path === "/groups/1182/grouptype");
    expect(migration).toBeDefined();
    expect(migration!.method).toBe("POST");
    expect(migration!.body).toEqual({
      groupTypeId: 4,
      roleMapping: { "105": 114, "108": 30, "201": 114 },
    });
  });

  it("withholds groupTypeId from the group PATCH — CT rejects the whole request otherwise", async () => {
    const { calls } = await applyTypeChange();
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/groups/1182");
    expect(patch).toBeDefined();
    expect(patch!.body).toEqual({ name: "Academy First Year" });
    expect(patch!.body).not.toHaveProperty("groupTypeId");
  });

  it("migrates BEFORE touching other fields, so a refusal leaves the rest untouched", async () => {
    const { calls } = await applyTypeChange();
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("POST /groups/1182/grouptype")).toBeLessThan(order.indexOf("PATCH /groups/1182"));
  });

  it("records the new type in state, so a re-plan is a no-op", async () => {
    const { state } = await applyTypeChange();
    expect(state.resources.team_academy_first_year?.fields).toMatchObject({
      groupTypeId: 4,
      name: "Academy First Year",
    });
  });

  it("sends no PATCH at all when the type is the only change", async () => {
    const { client, calls } = mockClient([]);
    const item = typeChange();
    item.changes = [{ field: "groupTypeId", from: 5, to: 4, source: "config" }];
    const plan = planWith(item);
    await resolveGroupTypeMigrations(client, plan, new Map());
    const state: State = emptyState(HOST);
    state.resources.team_academy_first_year = {
      type: "group",
      id: 1182,
      key: "team_academy_first_year",
      fields: { name: "Academy", groupTypeId: 5, groupStatusId: 1, campusId: null },
      adoptedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await executePlan(plan, { client, state, statePath: "unused", save: async () => {} });
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(calls.map((c) => c.path)).toEqual(["/groups/1182/grouptype"]);
  });
});
