import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTHETIC_FIELDS, syntheticField, foldSynthetic } from "../src/engine/synthetic.js";
import { normalizeDynamic, resolveRulesetRef } from "../src/engine/dynamic.js";
import { diffFields } from "../src/engine/plan.js";
import { loadConfig } from "../src/config/load.js";
import { CtApiError } from "../src/api/ctClient.js";
import type { State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const dynamicField = () => syntheticField("dynamic")!;
const getClient = (client: unknown) => client as unknown as Pick<CtClient, "get">;

describe("dynamic synthetic field — fold", () => {
  it("injects normalized dynamic into desired.fields and actual for an opted-in managed group", async () => {
    expect(SYNTHETIC_FIELDS.some((f) => f.field === "dynamic")).toBe(true);
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      {
        type: "group",
        key: "g",
        fields: { name: "G" },
        dependsOn: [],
        dynamic: { status: "manual", ruleset: { description: "x", query: {}, process: {} } },
      },
    ];
    const client = {
      get: vi.fn(async (p: string) =>
        p.endsWith("/ruleset")
          ? { description: "x", query: {}, process: {}, dynamicGroupUpdateStarted: "t" }
          : { dynamicGroupStatus: "manual" },
      ),
    };
    const out = await dynamicField().fold({
      client: client as unknown as Pick<CtClient, "get">,
      state,
      desired,
      actual,
    });
    expect(out.errors).toEqual([]);
    expect(actual.get("g")?.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "x", query: {}, process: {} },
    });
    expect(out.desired[0]?.fields.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "x", query: {}, process: {} },
    });
  });

  it("tolerates a 404 on the ruleset fetch — group is not (yet) a dynamic group", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      {
        type: "group",
        key: "g",
        fields: { name: "G" },
        dependsOn: [],
        dynamic: { status: "active", ruleset: { description: "x", query: {}, process: {} } },
      },
    ];
    const client = {
      get: vi.fn(async () => {
        throw new CtApiError("Not Found", 404, null);
      }),
    };
    const out = await dynamicField().fold({
      client: client as unknown as Pick<CtClient, "get">,
      state,
      desired,
      actual,
    });
    expect(out.errors).toEqual([]);
    expect(actual.get("g")?.dynamic).toEqual({ status: "none", ruleset: {} });
  });

  it("demote-to-none is a no-op against the 404 sentinel", () => {
    expect(normalizeDynamic({ status: "none", ruleset: {} })).toEqual({ status: "none", ruleset: {} });
  });

  it("propagates a status-GET failure as an error rather than fabricating the 'none' sentinel", async () => {
    // FIX 5: the ruleset GET succeeded, so this group HAS a real ruleset. A subsequent status-GET
    // failure must NOT be swallowed into { status: "none", ruleset: {} } (which would discard the
    // ruleset and propose a spurious re-PUT) — it degrades the plan via `errors`.
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      {
        type: "group",
        key: "g",
        fields: { name: "G" },
        dependsOn: [],
        dynamic: { status: "active", ruleset: { description: "x", query: {}, process: {} } },
      },
    ];
    const client = {
      get: vi.fn(async (p: string) => {
        if (p.endsWith("/ruleset")) return { description: "x", query: {}, process: {} };
        throw new CtApiError("Server Error", 500, null); // status GET fails AFTER a good ruleset GET
      }),
    };
    const out = await dynamicField().fold({ client: getClient(client), state, desired, actual });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/dynamic g status \(#5\)/);
    expect(actual.get("g")).not.toHaveProperty("dynamic"); // NOT clobbered with the sentinel
  });

  it("demote-to-none converges: a kept authored ruleset folds to the same sentinel as the actual side (no-op)", async () => {
    // docs/handbuch/dynamic-groups.md tells users to KEEP the dynamic block when demoting, so the authored
    // ruleset is still present with status "none". The actual side is the { status:"none", ruleset:{} }
    // sentinel — folding the full ruleset would diff forever. Both must collapse to the same sentinel.
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      {
        type: "group",
        key: "g",
        fields: { name: "G" },
        dependsOn: [],
        dynamic: {
          status: "none",
          ruleset: { description: "kept", query: { "==": [{ var: "x" }, "1"] }, process: {} },
        },
      },
    ];
    // Group is already non-dynamic in CT → ruleset GET 404s → actual sentinel.
    const client = {
      get: vi.fn(async () => {
        throw new CtApiError("Not Found", 404, null);
      }),
    };
    const out = await dynamicField().fold({ client: getClient(client), state, desired, actual });
    expect(out.errors).toEqual([]);
    const sentinel = { status: "none", ruleset: {} };
    expect(actual.get("g")?.dynamic).toEqual(sentinel); // actual side sentinel
    expect(out.desired[0]?.fields.dynamic).toEqual(sentinel); // desired folds to the SAME sentinel
    // Second plan is a no-op: the two sides are deep-equal, so diffFields reports no dynamic change.
    expect(
      diffFields(out.desired[0]!.fields, actual.get("g")!).find((c) => c.field === "dynamic"),
    ).toBeUndefined();
  });

  it("folds many opted-in groups concurrently, each with its own (ruleset, status) pair (#35 item 1)", async () => {
    // Behavior must be identical to the old serial loop: every opted-in managed group gets its actual
    // dynamic filled from its own ruleset+status GETs, keyed by group id.
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g1: { type: "group", id: 1, key: "g1", fields: { name: "G1" }, adoptedAt: "t", updatedAt: "t" },
        g2: { type: "group", id: 2, key: "g2", fields: { name: "G2" }, adoptedAt: "t", updatedAt: "t" },
        g3: { type: "group", id: 3, key: "g3", fields: { name: "G3" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([
      ["g1", { name: "G1" }],
      ["g2", { name: "G2" }],
      ["g3", { name: "G3" }],
    ]);
    const desired: DesiredResource[] = ["g1", "g2", "g3"].map((key) => ({
      type: "group",
      key,
      fields: { name: key.toUpperCase() },
      dependsOn: [],
      dynamic: { status: "manual", ruleset: { description: key, query: {}, process: {} } },
    }));
    const client = {
      get: vi.fn(async (p: string) => {
        const id = p.match(/dynamicgroups\/(\d+)\//)![1];
        return p.endsWith("/ruleset")
          ? { description: `rs${id}`, query: {}, process: {} }
          : { dynamicGroupStatus: "manual" };
      }),
    };
    const out = await dynamicField().fold({ client: getClient(client), state, desired, actual });
    expect(out.errors).toEqual([]);
    expect(actual.get("g1")?.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "rs1", query: {}, process: {} },
    });
    expect(actual.get("g2")?.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "rs2", query: {}, process: {} },
    });
    expect(actual.get("g3")?.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "rs3", query: {}, process: {} },
    });
    expect(client.get).toHaveBeenCalledTimes(6); // ruleset + status per group
  });

  it("ignores groups that did not opt into dynamic", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [{ type: "group", key: "g", fields: { name: "G" }, dependsOn: [] }];
    const client = { get: vi.fn() };
    await dynamicField().fold({ client: client as unknown as Pick<CtClient, "get">, state, desired, actual });
    expect(client.get).not.toHaveBeenCalled();
    expect(actual.get("g")).not.toHaveProperty("dynamic");
  });
});

describe("dynamic synthetic field — apply", () => {
  it("PUTs the ruleset wrapped in the [RuleSet] array envelope (#77), then the status", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    await dynamicField().apply({
      client: { request } as unknown as Pick<CtClient, "request">,
      state,
      id: 5,
      key: "g",
      change: {
        field: "dynamic",
        from: undefined,
        to: { status: "active", ruleset: { description: "x", query: {}, process: {} } },
      },
    });
    // PUT envelope: `{ dynamicGroupRuleSet: [ruleset] }` — object root, array property (live-decoded, #77).
    expect(request).toHaveBeenNthCalledWith(1, "PUT", "/dynamicgroups/5/ruleset", {
      dynamicGroupRuleSet: [{ description: "x", query: {}, process: {} }],
    });
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", {
      dynamicGroupStatus: "active",
    });
  });

  it("status-only change (ruleset byte-identical) PUTs only the status, skipping the ruleset re-PUT (#35 item 15)", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    const ruleset = { description: "x", query: {}, process: {} };
    await dynamicField().apply({
      client: { request } as unknown as Pick<CtClient, "request">,
      state,
      id: 5,
      key: "g",
      change: {
        field: "dynamic",
        from: { status: "active", ruleset }, // same ruleset, only the status flips
        to: { status: "inactive", ruleset },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("PUT", "/dynamicgroups/5/status", {
      dynamicGroupStatus: "inactive",
    });
    expect(request).not.toHaveBeenCalledWith("PUT", "/dynamicgroups/5/ruleset", expect.anything());
  });

  it("still PUTs both when the ruleset changed alongside the status", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    await dynamicField().apply({
      client: { request } as unknown as Pick<CtClient, "request">,
      state,
      id: 5,
      key: "g",
      change: {
        field: "dynamic",
        from: { status: "active", ruleset: { description: "old", query: {}, process: {} } },
        to: { status: "active", ruleset: { description: "new", query: {}, process: {} } },
      },
    });
    expect(request).toHaveBeenNthCalledWith(1, "PUT", "/dynamicgroups/5/ruleset", {
      dynamicGroupRuleSet: [{ description: "new", query: {}, process: {} }],
    });
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", {
      dynamicGroupStatus: "active",
    });
  });

  it("demotes to a normal group when status is none: DELETE ruleset then status none", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    await dynamicField().apply({
      client: { request } as unknown as Pick<CtClient, "request">,
      state,
      id: 5,
      key: "g",
      change: {
        field: "dynamic",
        from: { status: "active", ruleset: {} },
        to: { status: "none", ruleset: {} },
      },
    });
    expect(request).toHaveBeenNthCalledWith(1, "DELETE", "/dynamicgroups/5/ruleset");
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", {
      dynamicGroupStatus: "none",
    });
  });

  it("tolerates a 404 on the demote DELETE (never-dynamic / already-demoted group) and still PUTs status none", async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (method === "DELETE" && path.endsWith("/ruleset")) throw new CtApiError("Not Found", 404, null);
      return {};
    });
    const state: State = { version: 1, host: "h", resources: {} };
    await expect(
      dynamicField().apply({
        client: { request } as unknown as Pick<CtClient, "request">,
        state,
        id: 5,
        key: "g",
        change: { field: "dynamic", from: undefined, to: { status: "none", ruleset: {} } },
      }),
    ).resolves.toBeUndefined(); // 404 swallowed — apply does not abort
    expect(request).toHaveBeenNthCalledWith(1, "DELETE", "/dynamicgroups/5/ruleset");
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", {
      dynamicGroupStatus: "none",
    });
  });

  it("re-throws a non-404 error on the demote DELETE (real failures still abort)", async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (method === "DELETE" && path.endsWith("/ruleset")) throw new CtApiError("Server Error", 500, null);
      return {};
    });
    const state: State = { version: 1, host: "h", resources: {} };
    await expect(
      dynamicField().apply({
        client: { request } as unknown as Pick<CtClient, "request">,
        state,
        id: 5,
        key: "g",
        change: { field: "dynamic", from: undefined, to: { status: "none", ruleset: {} } },
      }),
    ).rejects.toThrow(/Server Error/);
  });
});

describe("resolveRulesetRef", () => {
  it("resolves { ref } relative to the given baseDir (config dir), not the process cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-ref-"));
    writeFileSync(join(dir, "rs.json"), JSON.stringify({ description: "from-file", query: {}, process: {} }));
    expect(resolveRulesetRef({ ref: "./rs.json" }, dir)).toEqual({
      description: "from-file",
      query: {},
      process: {},
    });
  });

  it("passes an inline ruleset through unchanged", () => {
    expect(resolveRulesetRef({ description: "inline" }, "/nowhere")).toEqual({ description: "inline" });
  });

  it("throws a clear error naming the group and resolved path when the ref file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-ref-"));
    expect(() => resolveRulesetRef({ ref: "./missing.json" }, dir, "all_mainz")).toThrow(
      /group "all_mainz".*cannot read.*missing\.json/is,
    );
  });

  it("throws a clear error when the ref file is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-ref-"));
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => resolveRulesetRef({ ref: "./bad.json" }, dir, "g")).toThrow(/not valid JSON/i);
  });
});

describe("dynamic { ref } ruleset — resolved relative to the config file", () => {
  const mkConfig = (rulesetLiteral: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "ct-cfg-"));
    writeFileSync(
      join(dir, "ct.config.ts"),
      `export default (ct) => { ct.group({ key: "g", name: "G", groupTypeId: 1, ` +
        `dynamic: { status: "manual", ruleset: ${rulesetLiteral} } }); };`,
    );
    return dir;
  };
  const state: State = {
    version: 1,
    host: "h",
    resources: { g: { type: "group", id: 5, key: "g", fields: {}, adoptedAt: "t", updatedAt: "t" } },
  };
  const foldClient = () => ({
    get: vi.fn(async (p: string) =>
      p.endsWith("/ruleset")
        ? { description: "actual", query: {}, process: {} }
        : { dynamicGroupStatus: "manual" },
    ),
  });

  it("threads the config dir so { ref } resolves against the config file, not the cwd", async () => {
    const dir = mkConfig(`{ ref: "./rules.json" }`);
    writeFileSync(
      join(dir, "rules.json"),
      JSON.stringify({ description: "from-ref", importance: 0, query: {}, process: {} }),
    );
    const { resources, configDir } = await loadConfig(join(dir, "ct.config.ts"));
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const out = await foldSynthetic({
      client: getClient(foldClient()),
      state,
      desired: resources,
      actual,
      configDir,
    });
    expect(out.desired.find((d) => d.key === "g")?.fields.dynamic).toMatchObject({
      status: "manual",
      ruleset: { description: "from-ref" },
    });
  });

  it("surfaces a clear error (group + path) when the { ref } file is missing", async () => {
    const dir = mkConfig(`{ ref: "./missing.json" }`);
    const { resources, configDir } = await loadConfig(join(dir, "ct.config.ts"));
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    await expect(
      foldSynthetic({ client: getClient(foldClient()), state, desired: resources, actual, configDir }),
    ).rejects.toThrow(/group "g".*cannot read.*missing\.json/is);
  });
});

describe("dynamic synthetic field — un-portablized ruleset reporting (#101)", () => {
  /**
   * A ruleset carrying another host's ids round-trips byte-identically against the host it was
   * written for, so the plan is green and the auto-group quietly collects the wrong people on the
   * other host. Plan time is the only place a config author sees this before it matters.
   */
  it("warns at plan time, naming the dimension, the ids and why they stayed numeric", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const ruleset = {
      description: "x",
      query: { and: [{ oneof: [{ var: "ctgroup.id" }, [1246]] }] },
      process: {},
    };
    const desired: DesiredResource[] = [
      {
        type: "group",
        key: "g",
        fields: { name: "G" },
        dependsOn: [],
        dynamic: { status: "active", ruleset },
      },
    ];
    const client = {
      get: vi.fn(async (p: string) => (p.endsWith("/ruleset") ? ruleset : { dynamicGroupStatus: "active" })),
    };
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
    let result: Awaited<ReturnType<ReturnType<typeof dynamicField>["fold"]>> | undefined;
    try {
      result = await dynamicField().fold({ client: getClient(client), state, desired, actual });
    } finally {
      spy.mockRestore();
    }
    const out = errs.join("");
    expect(out).toContain('dynamic group "g": ruleset carries 1 host-specific id(s)');
    expect(out).toMatch(/ctgroup\.id: 1246 left numeric/);
    expect(result?.warnings?.join("\n")).toContain("ctgroup.id: 1246 left numeric");
  });

  it("stays silent for a fully portable ruleset — the warning must mean something", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const ruleset = {
      description: "x",
      query: { and: [{ oneof: [{ var: "ctgroup.id" }, [{ __ctRef: true, kind: "group", key: "other" }]] }] },
      process: {},
    };
    const desired: DesiredResource[] = [
      {
        type: "group",
        key: "g",
        fields: { name: "G" },
        dependsOn: [],
        dynamic: { status: "active", ruleset },
      },
    ];
    const client = {
      get: vi.fn(async (p: string) => (p.endsWith("/ruleset") ? ruleset : { dynamicGroupStatus: "active" })),
    };
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
    try {
      await dynamicField().fold({ client: getClient(client), state, desired, actual });
    } finally {
      spy.mockRestore();
    }
    expect(errs.join("")).not.toContain("host-specific");
  });
});
