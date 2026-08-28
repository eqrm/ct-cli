import { describe, it, expect, vi, beforeEach } from "vitest";
import { CtApiError, type CtClient } from "../src/api/ctClient.js";
import { buildPlan } from "../src/engine/build.js";
import { executePlan } from "../src/engine/execute.js";
import { renderPlan } from "../src/engine/render.js";
import { createContext, evaluateConfig, ref } from "../src/config/context.js";
import { emptyState, type State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";
import {
  memberFieldPseudo,
  isGroupScopedMemberField,
  actualMemberFieldProps,
  groupScopedRows,
  matchingMemberFieldRows,
} from "../src/engine/member-fields.js";

const HOST = "https://mychurch.church.tools";

/**
 * `renderPlan` colours its output, and picocolors decides that at module load: on a CI runner the
 * ambient `CI` env var forces colour ON, so a pinned plan string only matches locally. Compare the
 * plain text — the colours are render.test.ts's subject, not this file's.
 */
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * An in-memory ChurchTools double for group member fields (#135).
 *
 * Deliberately models the ONE property that makes them interesting: a member field lives under its
 * group (`/groups/{id}/memberfields`) and gets a globally unique id when created, so two groups can
 * hold a field with the same local key and still be two independent resources.
 */
function makeCt(seed: { groups?: Record<number, Record<string, unknown>> } = {}) {
  const groups: Record<number, Record<string, unknown>> = seed.groups ?? {
    100: { id: 100, name: "Praktikum 1", information: { groupTypeId: 5, groupStatusId: 1 } },
    101: { id: 101, name: "Praktikum 2", information: { groupTypeId: 5, groupStatusId: 1 } },
  };
  const memberFields: Record<number, Record<string, unknown>[]> = {};
  const rulesets: Record<number, unknown> = {};
  const statuses: Record<number, string> = {};
  let nextGroupId = 900;
  let nextFieldId = 500;
  const calls: string[] = [];

  const get = async (path: string): Promise<unknown> => {
    calls.push(`GET ${path}`);
    let m = /^\/groups\/(\d+)$/.exec(path);
    if (m) {
      const g = groups[Number(m[1])];
      if (!g) throw new CtApiError("not found", 404, null);
      return g;
    }
    m = /^\/groups\/(\d+)\/memberfields$/.exec(path);
    if (m) return memberFields[Number(m[1])] ?? [];
    m = /^\/dynamicgroups\/(\d+)\/ruleset$/.exec(path);
    if (m) {
      const rs = rulesets[Number(m[1])];
      if (rs === undefined) throw new CtApiError("not found", 404, null);
      return rs;
    }
    m = /^\/dynamicgroups\/(\d+)\/status$/.exec(path);
    if (m) return { dynamicGroupStatus: statuses[Number(m[1])] ?? "none" };
    throw new CtApiError(`unmocked GET ${path}`, 404, null);
  };

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (method === "GET") return get(path);
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/groups") {
      const id = nextGroupId++;
      groups[id] = { id, ...(body as Record<string, unknown>) };
      return { id };
    }
    let m = /^\/groups\/(\d+)\/memberfields\/group$/.exec(path);
    if (m && method === "POST") {
      const groupId = Number(m[1]);
      const id = nextFieldId++;
      const row = { id, type: "group", ...(body as Record<string, unknown>) };
      memberFields[groupId] = [...(memberFields[groupId] ?? []), row];
      return { id };
    }
    m = /^\/groups\/(\d+)\/memberfields\/group\/(\d+)$/.exec(path);
    if (m) {
      const groupId = Number(m[1]);
      const fieldId = Number(m[2]);
      const rows = memberFields[groupId] ?? [];
      const i = rows.findIndex((r) => r.id === fieldId);
      if (i < 0) throw new CtApiError("not found", 404, null);
      if (method === "DELETE") rows.splice(i, 1);
      else rows[i] = { ...rows[i], ...(body as Record<string, unknown>) };
      return undefined;
    }
    m = /^\/dynamicgroups\/(\d+)\/ruleset$/.exec(path);
    if (m) {
      if (method === "DELETE") delete rulesets[Number(m[1])];
      else rulesets[Number(m[1])] = (body as { dynamicGroupRuleSet: unknown[] }).dynamicGroupRuleSet[0];
      return undefined;
    }
    m = /^\/dynamicgroups\/(\d+)\/status$/.exec(path);
    if (m) {
      statuses[Number(m[1])] = (body as { dynamicGroupStatus: string }).dynamicGroupStatus;
      return undefined;
    }
    m = /^\/groups\/(\d+)$/.exec(path);
    if (m) {
      groups[Number(m[1])] = { ...groups[Number(m[1])], ...(body as Record<string, unknown>) };
      return undefined;
    }
    throw new CtApiError(`unmocked ${method} ${path}`, 404, null);
  };

  const getFn = vi.fn(get);
  const requestFn = vi.fn(request);
  return {
    get: getFn,
    request: requestFn,
    /** The same doubles, typed as the client surface `buildPlan`/`executePlan` expect. */
    client: { get: getFn, request: requestFn } as unknown as Pick<CtClient, "get" | "request">,
    groups,
    memberFields,
    rulesets,
    statuses,
    calls,
  };
}

function stateWith(entries: Record<string, { type: string; id: number; fields: Record<string, unknown> }>) {
  const state: State = emptyState(HOST);
  for (const [key, e] of Object.entries(entries)) {
    state.resources[key] = {
      ...e,
      key,
      adoptedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }
  return state;
}

/** The OJBP blueprint from #135, parametrised — the point being it can be called twice. */
function praktikum(key: string, name: string): DesiredResource {
  const { ct, resources } = createContext();
  ct.group({
    key,
    name,
    groupTypeId: 5,
    groupStatusId: 1,
    memberFields: [{ key: "wahl", name: "Wahl", fieldTypeCode: "text" }],
  });
  return resources[0]!;
}

let warnings: string[];
beforeEach(() => {
  warnings = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });
});

describe("group member fields — DSL and identity (#135)", () => {
  it("scopes identity by the managed group, so two groups sharing a local key stay independent", async () => {
    const ct = makeCt();
    const state = stateWith({});
    const desired = [praktikum("praktikum_1", "Praktikum 1"), praktikum("praktikum_2", "Praktikum 2")];

    const { plan } = await buildPlan(ct.client, state, desired);
    expect(plan.items.map((i) => `${i.action} ${i.key}`)).toEqual([
      "create praktikum_1",
      "create praktikum_2",
    ]);

    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });

    const g1 = state.resources.praktikum_1!.id;
    const g2 = state.resources.praktikum_2!.id;
    expect(g1).not.toBe(g2);
    // Two ChurchTools fields, two ids, no state-key collision: the identity is the GROUP key plus
    // the local key, and each group's own state entry carries its own id mapping.
    const id1 = state.resources.praktikum_1!.memberFields!.wahl;
    const id2 = state.resources.praktikum_2!.memberFields!.wahl;
    expect(id1).toBeTypeOf("number");
    expect(id2).toBeTypeOf("number");
    expect(id1).not.toBe(id2);
    expect(ct.memberFields[g1]!.map((r) => r.referenceName)).toEqual(["wahl"]);
    expect(ct.memberFields[g2]!.map((r) => r.referenceName)).toEqual(["wahl"]);
  });

  it("refuses a declaration carrying a ChurchTools field id — the portability guarantee", () => {
    const { ct } = createContext();
    expect(() =>
      ct.group({
        key: "g",
        name: "G",
        memberFields: [{ key: "wahl", name: "Wahl", id: 42 }],
      }),
    ).toThrow(/"id" must never appear in config/);
  });

  it("rejects a duplicate local key within one group", () => {
    const { ct } = createContext();
    expect(() =>
      ct.group({
        key: "g",
        name: "G",
        memberFields: [
          { key: "wahl", name: "Wahl" },
          { key: "wahl", name: "Wahl 2" },
        ],
      }),
    ).toThrow(/duplicate member field key "wahl"/);
  });

  it("rejects memberFields on a non-group declaration", () => {
    const { ct } = createContext();
    expect(() => ct.campus({ key: "mz", name: "Mainz", memberFields: [] })).toThrow(/only valid on a group/);
  });
});

describe("group member fields — plan (#135)", () => {
  it("pins the rendered plan for a CREATE", async () => {
    const ct = makeCt();
    const state = stateWith({});
    const { plan } = await buildPlan(ct.client, state, [praktikum("praktikum_1", "Praktikum 1")]);
    const rendered = plain(renderPlan(plan));
    expect(rendered).toContain("+ group.praktikum_1");
    expect(rendered).toContain(
      'memberField:wahl: {"referenceName":"wahl","name":"Wahl","fieldTypeCode":"text"}',
    );
    expect(rendered).toContain("Plan: 1 to create, 0 to update, 0 to delete.");
  });

  it("pins the rendered plan for an UPDATE to a field definition", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [
      { id: 501, type: "group", referenceName: "wahl", name: "Wahl", fieldTypeCode: "text" },
    ];
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [{ key: "wahl", name: "Wahl (neu)", fieldTypeCode: "text" }],
    });
    const { plan } = await buildPlan(ct.client, state, resources);
    const rendered = plain(renderPlan(plan));
    expect(rendered).toContain("~ group.praktikum_1 (#100)");
    expect(rendered).toContain(
      'memberField:wahl: {"referenceName":"wahl","name":"Wahl","fieldTypeCode":"text"} -> {"referenceName":"wahl","name":"Wahl (neu)","fieldTypeCode":"text"}',
    );
    expect(rendered).toContain("Plan: 0 to create, 1 to update, 0 to delete.");
  });

  it("ignores a live property the declaration does not name, so a clean apply is a no-op", async () => {
    const ct = makeCt();
    const state = stateWith({});
    const desired = [praktikum("praktikum_1", "Praktikum 1")];

    const { plan } = await buildPlan(ct.client, state, desired);
    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });

    // ChurchTools echoes back more than was declared (server defaults, the id, the referenceName).
    const gid = state.resources.praktikum_1!.id;
    ct.memberFields[gid] = ct.memberFields[gid]!.map((r) => ({ ...r, sortKey: 7, nameTranslated: null }));

    const again = await buildPlan(ct.client, state, [praktikum("praktikum_1", "Praktikum 1")]);
    expect(plain(renderPlan(again.plan))).toBe("No changes. Desired state matches ChurchTools.");
  });

  it("treats server-assigned option ids and an id-backed default as the portable name declaration", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [
      {
        id: 501,
        type: "group",
        referenceName: "wahl",
        name: "Wahl",
        fieldTypeCode: "select",
        defaultValue: "702",
        options: [
          { id: "701", name: "A" },
          { id: "702", name: "B" },
        ],
      },
    ];
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    state.resources.praktikum_1!.memberFields = { wahl: 501 };
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [
        {
          key: "wahl",
          name: "Wahl",
          fieldTypeCode: "select",
          defaultValue: "B",
          options: [{ name: "A" }, { name: "B" }],
        },
      ],
    });

    const { plan } = await buildPlan(ct.client, state, resources);
    expect(plain(renderPlan(plan))).toBe("No changes. Desired state matches ChurchTools.");
  });

  it("surfaces an undeclared live field as a DELETE CANDIDATE and never plans a delete", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [
      { id: 501, type: "group", referenceName: "wahl", name: "Wahl", fieldTypeCode: "text" },
      { id: 502, type: "group", referenceName: "alt", name: "Alt", fieldTypeCode: "text" },
    ];
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    // `alt` was dropped from config — the exact scenario that must NOT delete anything.
    const { plan } = await buildPlan(ct.client, state, [
      { ...praktikum("praktikum_1", "Praktikum 1"), key: "praktikum_1" },
    ]);
    expect(plan.items.every((i) => i.action !== "delete")).toBe(true);
    expect(plain(renderPlan(plan))).toBe("No changes. Desired state matches ChurchTools.");
    expect(warnings.join("\n")).toMatch(
      /praktikum_1::alt.*DELETE CANDIDATE.*ct destroy --member-field praktikum_1::alt/s,
    );

    // …and applying the plan issues no DELETE at all.
    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });
    expect(ct.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(ct.memberFields[100]).toHaveLength(2);
  });

  it("does not fabricate creates when the member-field read fails (plan stays honest)", async () => {
    const ct = makeCt();
    const realGet = ct.get.getMockImplementation()!;
    ct.get.mockImplementation(async (path: string) => {
      if (path === "/groups/100/memberfields") throw new CtApiError("boom", 429, null);
      return realGet(path);
    });
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    const { plan } = await buildPlan(ct.client, state, [praktikum("praktikum_1", "Praktikum 1")]);
    const item = plan.items.find((i) => i.key === "praktikum_1")!;
    expect(item.action).toBe("no-op");
    expect(item.note).toBe("fetch-failed");
    expect(renderPlan(plan)).toContain("INCOMPLETE");
  });

  it("leaves a stale-bound field unreconciled without blocking the rest of its group", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [];
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    state.resources.praktikum_1!.memberFields = { wahl: 501 };

    // The group itself has real drift (a rename): a stale binding on ONE member field must not stop
    // the group's own properties — or its other sub-resources — from being planned.
    const { plan, fetchErrors } = await buildPlan(ct.client, state, [
      praktikum("praktikum_1", "Praktikum 2"),
    ]);
    const item = plan.items.find((i) => i.key === "praktikum_1")!;
    expect(item.action).toBe("update");
    expect(item.note).toBeUndefined();
    expect(item.changes.map((c) => c.field)).toEqual(["name"]);
    // …and no replacement POST is planned for the stale field.
    expect(item.changes.some((c) => c.field.startsWith("memberField:"))).toBe(false);
    expect(fetchErrors.join("\n")).toMatch(
      /praktikum_1::wahl: state binds it to #501.*ct destroy --member-field praktikum_1::wahl/s,
    );
    // A non-empty `fetchErrors` still makes `ct plan` INCOMPLETE and exit 1 (see commands/plan.ts);
    // what changed is that the group is no longer rendered as an unreadable resource.
    expect(fetchErrors).toHaveLength(1);
    expect(renderPlan(plan)).not.toContain("could not be read");
  });
});

describe("group member fields — apply (#135)", () => {
  it("creates fields only after the owning group exists, and updates existing ones idempotently", async () => {
    const ct = makeCt();
    const state = stateWith({});
    const { plan } = await buildPlan(ct.client, state, [praktikum("praktikum_1", "Praktikum 1")]);
    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });

    const groupCreate = ct.calls.indexOf("POST /groups");
    const fieldCreate = ct.calls.findIndex((c) => c.includes("/memberfields/group"));
    expect(groupCreate).toBeGreaterThanOrEqual(0);
    expect(fieldCreate).toBeGreaterThan(groupCreate);

    // Second run: rename the field. The existing row is PATCHed, never re-created.
    const { ct: dsl, resources } = createContext();
    const gid = state.resources.praktikum_1!.id;
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [{ key: "wahl", name: "Wahl (neu)", fieldTypeCode: "text" }],
    });
    const second = await buildPlan(ct.client, state, resources);
    await executePlan(second.plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });
    expect(ct.memberFields[gid]).toHaveLength(1);
    expect(ct.memberFields[gid]![0]!.name).toBe("Wahl (neu)");
    expect(ct.calls.filter((c) => c.startsWith("PATCH /groups/") && c.includes("memberfields"))).toHaveLength(
      1,
    );
  });

  it("normalises live response variants and PATCHes the current state-bound id", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [
      { id: 501, type: "group", referenceName: "birkmann", name: "Birkman", fieldTypeCode: "textarea" },
    ];
    const realGet = ct.get.getMockImplementation()!;
    ct.get.mockImplementation(async (path: string) => {
      if (path === "/groups/100/memberfields") {
        // The live endpoint used by the process wraps group-owned rows in `group` and serialises
        // their ids as strings. Losing either compatibility makes the list look empty and causes a
        // duplicate POST even though the current owner-local state already knows id 501.
        return {
          group: ct.memberFields[100]!.map((row) => ({
            ...row,
            id: String(row.id),
            // On the live endpoint this describes where VALUES live, while the `group` bucket
            // already identifies the definition's writable scope.
            type: "person",
          })),
        };
      }
      return realGet(path);
    });
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    state.resources.praktikum_1!.memberFields = { birkmann: 501 };
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [
        {
          key: "birkmann",
          name: "Birkman (neu)",
          fieldTypeCode: "textarea",
        },
      ],
    });

    const { plan } = await buildPlan(ct.client, state, resources);
    expect(plan.items[0]!.changes.map((change) => change.field)).toContain("memberField:birkmann");
    ct.calls.length = 0;
    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });

    expect(ct.calls.filter((call) => call === "POST /groups/100/memberfields/group")).toHaveLength(0);
    expect(ct.calls.filter((call) => call === "PATCH /groups/100/memberfields/group/501")).toHaveLength(1);
    expect(ct.memberFields[100]).toHaveLength(1);
    expect(ct.memberFields[100]![0]!.name).toBe("Birkman (neu)");
    expect(state.resources.praktikum_1!.memberFields).toEqual({ birkmann: 501 });
  });

  it("orders field creation before the dependent dynamic ruleset is installed", async () => {
    const ct = makeCt();
    const state = stateWith({});
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [{ key: "wahl", name: "Wahl", fieldTypeCode: "text" }],
      dynamic: {
        status: "active",
        ruleset: {
          description: "wahl",
          query: { "==": [{ var: "memberfield.id" }, ref.groupMemberField("praktikum_1", "wahl")] },
          process: {},
        },
      },
    });
    const { plan } = await buildPlan(ct.client, state, resources);
    const changes = plan.items[0]!.changes.map((c) => c.field);
    expect(changes.indexOf("memberField:wahl")).toBeLessThan(changes.indexOf("dynamic"));

    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });
    const fieldCreate = ct.calls.findIndex((c) => c.includes("/memberfields/group"));
    const rulesetPut = ct.calls.findIndex((c) => c.startsWith("PUT /dynamicgroups/"));
    expect(fieldCreate).toBeGreaterThanOrEqual(0);
    expect(rulesetPut).toBeGreaterThan(fieldCreate);

    // The pending `<group>::<field>` reference was completed with the id the create just minted —
    // never a host-specific id frozen at authoring time.
    const gid = state.resources.praktikum_1!.id;
    const stored = ct.rulesets[gid] as { query: { "==": unknown[] } };
    expect(stored.query["=="][1]).toBe(state.resources.praktikum_1!.memberFields!.wahl);
  });

  it("keeps local key, exact API referenceName, and ruleset assignment separate (#158)", async () => {
    const ct = makeCt();
    const state = stateWith({});
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [
        {
          key: "stand_bewerbung",
          referenceName: "stand-bewerbung",
          name: "Stand",
          fieldTypeCode: "select",
        },
      ],
      dynamic: {
        status: "active",
        ruleset: {
          description: "Stand Bewerbung",
          query: {},
          process: {
            queryResultOnly: {
              none: {
                handleMembership: {
                  groupMemberFields: { "stand-bewerbung": "❓Offen" },
                },
              },
            },
          },
        },
      },
    });

    const { plan } = await buildPlan(ct.client, state, resources);
    expect(
      plan.items[0]!.changes.find((change) => change.field === "memberField:stand_bewerbung")?.to,
    ).toMatchObject({ referenceName: "stand-bewerbung" });
    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });

    const groupId = state.resources.praktikum_1!.id;
    expect(ct.memberFields[groupId]).toEqual([
      expect.objectContaining({ referenceName: "stand-bewerbung", name: "Stand" }),
    ]);
    expect(state.resources.praktikum_1!.memberFields).toEqual({ stand_bewerbung: expect.any(Number) });
    expect(ct.rulesets[groupId]).toMatchObject({
      process: {
        queryResultOnly: {
          none: {
            handleMembership: {
              groupMemberFields: { "stand-bewerbung": "❓Offen" },
            },
          },
        },
      },
    });
  });
});

describe("group member fields — exact referenceName identity (#158)", () => {
  it("marks an existing punctuation mismatch incomplete and never plans a silent rename", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [
      {
        id: 501,
        type: "group",
        referenceName: "stand_bewerbung",
        name: "Stand",
        fieldTypeCode: "select",
      },
    ];
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    state.resources.praktikum_1!.memberFields = { stand_bewerbung: 501 };
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [
        {
          key: "stand_bewerbung",
          referenceName: "stand-bewerbung",
          name: "Stand",
          fieldTypeCode: "select",
        },
      ],
    });

    const { plan, fetchErrors } = await buildPlan(ct.client, state, resources);
    expect(fetchErrors.join("\n")).toMatch(
      /stand_bewerbung.*"stand_bewerbung".*"stand-bewerbung".*not rename.*ct destroy --member-field praktikum_1::stand_bewerbung/s,
    );
    expect(warnings.join("\n")).toContain('exact ChurchTools referenceName is "stand_bewerbung"');
    expect(plan.items[0]!.changes.some((change) => change.field.startsWith("memberField:"))).toBe(false);
  });

  it("refuses a duplicate create for an unbound row whose normalised spelling merely looks equal", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [{ id: 501, type: "group", referenceName: "stand_bewerbung", name: "Stand" }];
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
    });
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [
        {
          key: "stand_bewerbung",
          referenceName: "stand-bewerbung",
          name: "Stand",
        },
      ],
    });

    const { plan, fetchErrors } = await buildPlan(ct.client, state, resources);
    expect(fetchErrors.join("\n")).toMatch(/"stand_bewerbung".*"stand-bewerbung"/s);
    expect(plan.items[0]!.changes.some((change) => change.field.startsWith("memberField:"))).toBe(false);
  });

  it("does not collapse hyphens and underscores when matching API reference names", () => {
    const rows = [
      { id: 1, referenceName: "foo-bar", name: "Foo" },
      { id: 2, referenceName: "foo_bar", name: "Foo" },
    ];
    expect(matchingMemberFieldRows(rows, "foo_bar", "foo-bar")).toEqual([rows[0]]);
    expect(matchingMemberFieldRows(rows, "foo-bar", "foo_bar")).toEqual([rows[1]]);
  });

  it("rejects duplicate exact API identities but permits hyphen/underscore as distinct", () => {
    const { ct } = createContext();
    expect(() =>
      ct.group({
        key: "duplicate",
        name: "Duplicate",
        memberFields: [
          { key: "first", referenceName: "same", name: "First" },
          { key: "second", referenceName: "same", name: "Second" },
        ],
      }),
    ).toThrow(/duplicate member field referenceName "same"/);

    expect(() =>
      ct.group({
        key: "distinct",
        name: "Distinct",
        memberFields: [
          { key: "first", referenceName: "foo-bar", name: "First" },
          { key: "second", referenceName: "foo_bar", name: "Second" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("group member fields — one spelling of identity (#135 review)", () => {
  it("resolves a differently-cased ref against the declared key, end to end", async () => {
    // `matchesLocalKey` slugs both sides, so `wahl` and `Wahl` are deliberately the SAME field.
    // Everything downstream has to agree: if the id were recorded under the raw declaration key and
    // read back under the raw ref key, apply would hard-fail here — after the group and the field
    // had already been created in ChurchTools.
    const ct = makeCt();
    const state = stateWith({});
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [{ key: "wahl", name: "Wahl", fieldTypeCode: "text" }],
      dynamic: {
        status: "active",
        ruleset: {
          description: "wahl",
          query: { "==": [{ var: "memberfield.id" }, ref.groupMemberField("praktikum_1", "Wahl")] },
          process: {},
        },
      },
    });
    const { plan } = await buildPlan(ct.client, state, resources);
    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });

    const gid = state.resources.praktikum_1!.id;
    const stored = ct.rulesets[gid] as { query: { "==": unknown[] } };
    expect(stored.query["=="][1]).toBe(ct.memberFields[gid]![0]!.id);
    expect(state.resources.praktikum_1!.memberFields).toEqual({ wahl: ct.memberFields[gid]![0]!.id });
  });

  it("rejects two declarations that differ only in case, since both name the same live row", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.group({
          key: "a",
          name: "A",
          memberFields: [
            { key: "wahl", name: "Wahl" },
            { key: "Wahl", name: "Wahl again" },
          ],
        });
      }),
    ).rejects.toThrow(/duplicate member field key/);
  });

  it("reads a group's member fields ONCE per apply, however many fields it declares", async () => {
    const ct = makeCt();
    const state = stateWith({});
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "praktikum_1",
      name: "Praktikum 1",
      groupTypeId: 5,
      groupStatusId: 1,
      memberFields: [
        { key: "wahl", name: "Wahl", fieldTypeCode: "text" },
        { key: "alt", name: "Alt", fieldTypeCode: "text" },
        { key: "dritte", name: "Dritte", fieldTypeCode: "text" },
      ],
    });
    const { plan } = await buildPlan(ct.client, state, resources);
    ct.calls.length = 0;
    await executePlan(plan, { client: ct.client, state, statePath: "s.json", save: async () => {} });

    const reads = ct.calls.filter((c) => c === `GET /groups/${state.resources.praktikum_1!.id}/memberfields`);
    expect(reads).toHaveLength(1); // not one per declared field (#145: the API rate-limits)
    expect(ct.memberFields[state.resources.praktikum_1!.id]).toHaveLength(3);
  });
});

describe("group member fields — ruleset validation (#135)", () => {
  it("fails at config-eval time when a ruleset names a field the target group does not declare", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.group({ key: "a", name: "A", memberFields: [{ key: "wahl", name: "Wahl" }] });
        ct.group({
          key: "b",
          name: "B",
          dynamic: {
            status: "active",
            ruleset: { query: { "==": [{ var: "x" }, ref.groupMemberField("a", "nope")] } },
          },
        });
      }),
    ).rejects.toThrow(/does not declare.*it declares: wahl/s);
  });

  it("fails when the referenced group does not manage member fields at all", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.group({ key: "a", name: "A" });
        ct.group({
          key: "b",
          name: "B",
          dynamic: {
            status: "active",
            ruleset: { query: { "==": [{ var: "x" }, ref.groupMemberField("a", "wahl")] } },
          },
        });
      }),
    ).rejects.toThrow(/does not manage member fields/);
  });

  it("accepts a reference to a field the target group does declare", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.group({ key: "a", name: "A", memberFields: [{ key: "wahl", name: "Wahl" }] });
      ct.group({
        key: "b",
        name: "B",
        dynamic: {
          status: "active",
          ruleset: { query: { "==": [{ var: "x" }, ref.groupMemberField("a", "wahl")] } },
        },
      });
    });
    expect(resources).toHaveLength(2);
  });

  it("hard-errors at plan time for a ref into an ADOPTED group that has no such field", async () => {
    const ct = makeCt();
    ct.memberFields[100] = [{ id: 501, type: "group", referenceName: "wahl", name: "Wahl" }];
    const state = stateWith({
      praktikum_1: {
        type: "group",
        id: 100,
        fields: { name: "Praktikum 1", groupTypeId: 5, groupStatusId: 1 },
      },
      other: { type: "group", id: 101, fields: { name: "Praktikum 2", groupTypeId: 5, groupStatusId: 1 } },
    });
    const { ct: dsl, resources } = createContext();
    dsl.group({
      key: "other",
      name: "Praktikum 2",
      groupTypeId: 5,
      groupStatusId: 1,
      dynamic: {
        status: "active",
        ruleset: { query: { "==": [{ var: "x" }, ref.groupMemberField("praktikum_1", "nope")] } },
      },
    });
    await expect(buildPlan(ct.client, state, resources)).rejects.toThrow(
      /group #100 has no member field "nope"/,
    );
  });
});

describe("memberFieldPseudo", () => {
  it("is the diff key a declaration folds into", () => {
    expect(memberFieldPseudo("wahl")).toBe("memberField:wahl");
  });
});

describe("isGroupScopedMemberField (#135 review)", () => {
  it("keeps a row whose only string discriminator is a field TYPE, not a scope", () => {
    // The failure this guards against is silent and compounding: read `type: "text"` as "not a
    // group field" and EVERY group's list comes back empty — adopt emits nothing, and apply finds
    // no match and POSTs a brand-new field on every single run, duplicating the group's fields.
    expect(isGroupScopedMemberField({ id: 1, type: "text", name: "Wahl" })).toBe(true);
    expect(isGroupScopedMemberField({ id: 1, type: "date", fieldTypeCode: "date" })).toBe(true);
  });

  it("keeps a row with no discriminator at all, and one that says group in any key", () => {
    expect(isGroupScopedMemberField({ id: 1, name: "Wahl" })).toBe(true);
    expect(isGroupScopedMemberField({ id: 1, type: "group" })).toBe(true);
    expect(isGroupScopedMemberField({ id: 1, fieldCategory: "Group" })).toBe(true);
    expect(isGroupScopedMemberField({ id: 1, source: "group", type: "text" })).toBe(true);
  });

  it("drops a row that positively names a source outside the group", () => {
    expect(isGroupScopedMemberField({ id: 1, type: "person" })).toBe(false);
    expect(isGroupScopedMemberField({ id: 1, source: "masterdata" })).toBe(false);
    expect(isGroupScopedMemberField({ id: 1, fieldSource: "group-type" })).toBe(false);
  });
});

describe("actualMemberFieldProps — defaultValue ↔ option id (#154 review)", () => {
  it("treats the option id CT echoes for a by-name default as no drift", () => {
    const row = {
      defaultValue: 7,
      options: [
        { id: 7, name: "Ja" },
        { id: 8, name: "Nein" },
      ],
    };
    expect(actualMemberFieldProps(row, { defaultValue: "Ja" })).toEqual({ defaultValue: "Ja" });
  });

  it("does not match an ABSENT default against an id-less option", () => {
    // Both sides stringify to "undefined": coercing them would report the field converged forever
    // and the declared default would never be written.
    const row = { options: [{ name: "Ja" }, { name: "Nein" }] };
    expect(actualMemberFieldProps(row, { defaultValue: "Ja" })).toEqual({ defaultValue: undefined });
    expect(
      actualMemberFieldProps(
        { defaultValue: null, options: [{ id: null, name: "Ja" }] },
        {
          defaultValue: "Ja",
        },
      ),
    ).toEqual({ defaultValue: null });
  });
});

describe("groupScopedRows — { type, field } wrapper (#154 review)", () => {
  it("keeps a wrapper-held id when the inner definition carries none", () => {
    // Losing it would make adopt skip the group and apply refuse the update for want of a row id.
    const rows = groupScopedRows([{ type: "group", id: 42, field: { name: "Wahl", referenceName: "wahl" } }]);
    expect(rows).toEqual([{ type: "group", id: 42, name: "Wahl", referenceName: "wahl" }]);
  });

  it("lets the inner definition win on every key it names", () => {
    const rows = groupScopedRows([{ type: "group", id: 42, name: "Outer", field: { id: 7, name: "Wahl" } }]);
    expect(rows).toEqual([{ type: "group", id: 7, name: "Wahl" }]);
  });

  it("leaves a plain row that merely carries an unrelated `field` object alone", () => {
    const row = { id: 3, name: "Wahl", referenceName: "wahl", field: { label: "irrelevant" } };
    expect(groupScopedRows([row])).toEqual([row]);
  });
});
