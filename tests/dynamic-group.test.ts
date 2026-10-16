import { describe, expect, it, vi } from "vitest";
import { evaluateConfig } from "../src/config/context.js";
import { buildPlan } from "../src/engine/build.js";
import { executePlan } from "../src/engine/execute.js";
import { renderPlan } from "../src/engine/render.js";
import { CtApiError } from "../src/api/ctClient.js";
import { emptyState, type State } from "../src/state/state.js";
import { buildCoverageReport, renderCoverage, renderRoleInstances } from "../src/coverage/report.js";
import { selectRefreshTargets } from "../src/application/operations/refresh.js";
import { removeStateEntry } from "../src/application/operations/state.js";
import { resolveScope } from "../src/permissions/scope.js";

const HOST = "https://example.church.tools";
const RULESET = { description: "demo", query: {}, process: {} };
const idMap = { path: ".ct/ids.example.json", ids: new Map([["group\u0000example_auto", 7]]) };

function fakeClient(opts: { ruleset?: unknown; status?: string; groupMissing?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    get: async <T>(path: string): Promise<T> => {
      calls.push(`GET ${path}`);
      if (path === "/groups/7") {
        if (opts.groupMissing) throw new CtApiError("nf", 404, null);
        return { id: 7, name: "Example", information: { groupTypeId: 1, groupStatusId: 1 } } as T;
      }
      if (path === "/dynamicgroups/7/ruleset")
        return { ...(opts.ruleset as object), dynamicGroupUpdateStarted: "t" } as T;
      if (path === "/dynamicgroups/7/status") return { dynamicGroupStatus: opts.status ?? "active" } as T;
      throw new CtApiError(`not found: ${path}`, 404, null);
    },
  };
}

async function desiredFor(dynamic: unknown) {
  const { resources } = await evaluateConfig((ct) => {
    ct.dynamicGroup({ group: "example_auto", dynamic: dynamic as never });
  });
  return resources;
}

describe("ct.dynamicGroup declaration", () => {
  it("desugars to a ruleset-only group resource with no fields", async () => {
    const [r] = await desiredFor(true);
    expect(r).toMatchObject({
      type: "group",
      key: "example_auto",
      fields: {},
      rulesetOnly: true,
      dynamic: { status: "active", ruleset: { ref: "./rulesets/example_auto.json" } },
    });
  });

  it("takes the explicit and path forms like ct.group", async () => {
    expect((await desiredFor("./r/x.json"))[0]?.dynamic).toEqual({
      status: "active",
      ruleset: { ref: "./r/x.json" },
    });
    expect((await desiredFor({ status: "manual", ruleset: RULESET }))[0]?.dynamic?.status).toBe("manual");
  });

  it("refuses a key also declared with ct.group, in either order", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.group({ key: "example_auto", name: "Example" });
        ct.dynamicGroup({ group: "example_auto", dynamic: true });
      }),
    ).rejects.toThrow(/also declared as group/);
    await expect(
      evaluateConfig((ct) => {
        ct.dynamicGroup({ group: "example_auto", dynamic: true });
        ct.group({ key: "example_auto", name: "Example" });
      }),
    ).rejects.toThrow(/also declared with ct.dynamicGroup/);
  });

  it("refuses two declarations for one group, a missing dynamic and stray fields", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.dynamicGroup({ group: "g", dynamic: true });
        ct.dynamicGroup({ group: "g", dynamic: true });
      }),
    ).rejects.toThrow(/declared twice/);
    await expect(evaluateConfig((ct) => ct.dynamicGroup({ group: "g" } as never))).rejects.toThrow(
      /"dynamic" is required/,
    );
    await expect(
      evaluateConfig((ct) => ct.dynamicGroup({ group: "g", dynamic: true, name: "x" } as never)),
    ).rejects.toThrow(/unsupported field/);
  });
});

describe("ct.dynamicGroup plan", () => {
  const inline = { status: "active", ruleset: RULESET };

  it("plans one dynamic update when the ruleset changed, and nothing else", async () => {
    const { Resolver } = await import("../src/resolve/resolver.js");
    const state = emptyState(HOST);
    const desired = await desiredFor(inline);
    const resolver = new Resolver({ client: { get: async () => [] as never }, state, desired, idMap });
    const { plan } = await buildPlan(
      fakeClient({ ruleset: { ...RULESET, description: "old" } }),
      state,
      desired,
      {
        resolver,
      },
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ key: "example_auto", id: 7, action: "update", rulesetOnly: true });
    expect(plan.items[0]!.changes.map((c) => c.field)).toEqual(["dynamic"]);
    const text = renderPlan(plan);
    expect(text).toContain("group.example_auto");
    expect(text).not.toMatch(/\+ |- group/);
  });

  it("resolves from the id map for real and no-ops (acceptance: id map, not state)", async () => {
    const { Resolver } = await import("../src/resolve/resolver.js");
    const state = emptyState(HOST);
    const desired = await desiredFor(inline);
    const resolver = new Resolver({ client: { get: async () => [] as never }, state, desired, idMap });
    const { plan } = await buildPlan(fakeClient({ ruleset: RULESET }), state, desired, { resolver });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ id: 7, action: "no-op" });
    expect(renderPlan(plan)).toContain("No changes");
  });

  it("plans a no-op and writes nothing when the declaration is dropped", async () => {
    const state = emptyState(HOST);
    const client = fakeClient({ ruleset: RULESET });
    const { plan } = await buildPlan(client, state, []);
    expect(plan.items).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(renderPlan(plan)).toContain("No changes");
  });

  it("fails at plan time for a key in neither state nor the id map, never a create", async () => {
    const { Resolver } = await import("../src/resolve/resolver.js");
    const state = emptyState(HOST);
    const desired = await desiredFor(inline);
    const resolver = new Resolver({
      client: { get: async () => [] as never },
      state,
      desired,
      idMap: { path: ".ct/ids.example.json", ids: new Map() },
    });
    await expect(buildPlan(fakeClient({}), state, desired, { resolver })).rejects.toThrow(
      /no group with this key.*never creates a group/s,
    );
  });

  it("refuses a key that ct's state holds as another resource type", async () => {
    const { Resolver } = await import("../src/resolve/resolver.js");
    const state = emptyState(HOST);
    state.resources.example_auto = {
      type: "campus",
      id: 3,
      key: "example_auto",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const desired = await desiredFor(inline);
    const resolver = new Resolver({ client: { get: async () => [] as never }, state, desired, idMap });
    await expect(buildPlan(fakeClient({ ruleset: RULESET }), state, desired, { resolver })).rejects.toThrow(
      /state holds "example_auto" as a campus/,
    );
  });

  it("fails (not a recreate) when the group is gone from ChurchTools", async () => {
    const { Resolver } = await import("../src/resolve/resolver.js");
    const state = emptyState(HOST);
    const desired = await desiredFor(inline);
    const resolver = new Resolver({ client: { get: async () => [] as never }, state, desired, idMap });
    await expect(buildPlan(fakeClient({ groupMissing: true }), state, desired, { resolver })).rejects.toThrow(
      /does not exist in ChurchTools/,
    );
  });

  it("degrades an unreadable ruleset to fetch-failed (#126)", async () => {
    const { Resolver } = await import("../src/resolve/resolver.js");
    const state = emptyState(HOST);
    const desired = await desiredFor(inline);
    const resolver = new Resolver({ client: { get: async () => [] as never }, state, desired, idMap });
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/groups/7") return { id: 7, name: "Example", information: {} } as T;
        throw new CtApiError("busy", 429, null);
      },
    };
    const { plan, fetchErrors } = await buildPlan(client, state, desired, { resolver });
    expect(plan.items[0]).toMatchObject({ action: "no-op", note: "fetch-failed" });
    expect(fetchErrors.length).toBe(1);
  });

  it("prefers the state id when the group is in ct's state, and never reports drift on its fields", async () => {
    const { Resolver } = await import("../src/resolve/resolver.js");
    const state = emptyState(HOST);
    state.resources.example_auto = {
      type: "group",
      id: 7,
      key: "example_auto",
      fields: { name: "Old name" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const desired = await desiredFor(inline);
    const resolver = new Resolver({ client: { get: async () => [] as never }, state, desired });
    const { plan } = await buildPlan(fakeClient({ ruleset: RULESET }), state, desired, { resolver });
    expect(plan.items[0]).toMatchObject({ action: "no-op" });
    expect(plan.items[0]!.drift).toBeUndefined();
  });
});

describe("ct.dynamicGroup apply", () => {
  it("writes the ruleset and status and leaves ct's state untouched", async () => {
    const state: State = emptyState(HOST);
    const save = vi.fn(async () => {});
    const calls: string[] = [];
    const client = {
      request: async <T>(method: string, path: string): Promise<T> => {
        calls.push(`${method} ${path}`);
        return {} as T;
      },
    };
    const result = await executePlan(
      {
        items: [
          {
            type: "group",
            key: "example_auto",
            id: 7,
            action: "update",
            rulesetOnly: true,
            actual: { name: "Example" },
            changes: [
              {
                field: "dynamic",
                from: { status: "active", ruleset: { description: "old", query: {}, process: {} } },
                to: { status: "active", ruleset: RULESET },
              },
            ],
          },
        ],
      },
      { client, state, statePath: "s.json", save },
    );
    expect(result.updated).toEqual(["example_auto"]);
    expect(calls).toEqual(["PUT /dynamicgroups/7/ruleset", "PUT /dynamicgroups/7/status"]);
    expect(Object.keys(state.resources)).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("bare-string group scopes", () => {
  it("fail with a hint to use { group } when the group is only in the id map", () => {
    expect(() => resolveScope(["example_auto"], emptyState(HOST), new Set(), {})).toThrow(
      /write \{ group: "example_auto" \} instead/,
    );
  });
});

describe("ct state rm guard", () => {
  const entry = {
    type: "group",
    id: 7,
    key: "example_auto",
    fields: {},
    adoptedAt: "t",
    updatedAt: "t",
  };
  const project = {
    cwd: "/project",
    configPath: "/project/ct.config.ts",
    statePath: "/project/state.json",
    environmentsPath: "/project/ct.envs.json",
    configDisplayPath: "ct.config.ts",
    stateDisplayPath: "state.json",
    environment: "dev",
    protected: false,
    host: HOST,
  };
  const deps = async (withMap: boolean, dynamicGroup: boolean) => {
    const state = emptyState(HOST);
    state.resources.example_auto = { ...entry };
    const loaded = await evaluateConfig((ct) => {
      if (dynamicGroup) ct.dynamicGroup({ group: "example_auto", dynamic: true });
      ct.groupRole({ key: "r", group: "example_auto", role: "Leader", grants: [] } as never);
    });
    return {
      state,
      saveState: vi.fn(async () => {}),
      resolveProject: vi.fn(async () => project),
      loadState: vi.fn(async () => state),
      loadConfig: vi.fn(async () => ({ ...loaded, configDir: "/project" })),
      loadIdMap: vi.fn(async () =>
        withMap ? { ...idMap, meta: null, entries: [], keysByLabel: new Map() } : null,
      ),
    };
  };

  it("refuses removal of a state-only group a grant still names", async () => {
    const d = await deps(false, false);
    await expect(removeStateEntry({ type: "group", key: "example_auto" }, d)).rejects.toThrow(
      /only ct's state can resolve/,
    );
  });

  it("allows removal when the id map already resolves the group", async () => {
    const d = await deps(true, true);
    const result = await removeStateEntry({ type: "group", key: "example_auto" }, d);
    expect(result.value.removed).toBe(true);
    expect(d.state.resources.example_auto).toBeUndefined();
  });

  it("does not treat a ruleset-only declaration as a declaration that would recreate the group", async () => {
    const d = await deps(true, true);
    await expect(removeStateEntry({ type: "group", key: "example_auto" }, d)).resolves.toBeDefined();
  });

  it("fails closed, not open, when the id map is unreadable", async () => {
    const d = await deps(true, true);
    d.loadIdMap.mockRejectedValueOnce(new Error("Id map was generated for another host"));
    await expect(removeStateEntry({ type: "group", key: "example_auto" }, d)).rejects.toThrow(
      /only ct's state can resolve/,
    );
    expect(d.state.resources.example_auto).toBeDefined();
  });

  it("still refuses when a ct.dynamicGroup names a group only ct's state can resolve", async () => {
    const d = await deps(false, true);
    await expect(removeStateEntry({ type: "group", key: "example_auto" }, d)).rejects.toThrow(
      /only ct's state can resolve/,
    );
  });
});

describe("ct refresh --group with the id map", () => {
  const client = { getAll: async () => ({ data: [{ id: 7 }] }) } as never;

  it("selects an id-map group that is not in state", async () => {
    const targets = await selectRefreshTargets(client, emptyState(HOST), "example_auto", idMap);
    expect(targets.map((t) => [t.key, t.id])).toEqual([["example_auto", 7]]);
  });

  it("still rejects a key in neither", async () => {
    await expect(selectRefreshTargets(client, emptyState(HOST), "nope", idMap)).rejects.toThrow(
      /state file or the OpenTofu id map/,
    );
  });
});

describe("ct coverage with the id map", () => {
  it("labels id-map groups as owned elsewhere, not unmanaged", () => {
    const report = buildCoverageReport({
      host: HOST,
      state: emptyState(HOST),
      groups: [
        {
          id: 7,
          name: "Example",
          groupTypeId: 1,
          roles: [{ domainId: 70, groupId: 7, groupName: "Example", groupTypeId: 1, roleName: "Leader" }],
        },
      ],
      groupTypeNames: new Map([[1, "Type"]]),
      dynamicGroupIds: new Set([7]),
      groupRolePermissions: [{ authId: 1, domainId: 70, domainType: "group_role", dataId: [] } as never],
      idMapGroupKeys: new Map([[7, "example_auto"]]),
    });
    expect(report.groups.ownedElsewhere).toBe(1);
    expect(report.byType[0]).toMatchObject({ unmanagedWithGrants: 0, ownedElsewhere: 1 });
    expect(renderCoverage(report)).toContain("1 owned elsewhere (id map)");
    expect(renderCoverage(report)).toMatch(/unmanaged\+grants\s+elsewhere/);
    for (const r of report.roleInstances) {
      expect(renderRoleInstances([r])).toContain('owned elsewhere (id map) as "example_auto"');
    }
  });
});
