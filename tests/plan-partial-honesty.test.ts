/**
 * A partial plan must never be a WRONG plan (#126).
 *
 * Under HTTP 429 the tool used to log the failed reads as warnings and then diff config against the
 * partial actuals it managed to fetch, so a resource whose sub-resource GET was rate-limited showed
 * up as an ordinary `update`. In a PR comment that is indistinguishable from a real drift, and it
 * invites the same response: apply it. These tests pin the two properties that make the degraded
 * plan honest instead — an unread resource is a no-op flagged `fetch-failed`, and the summary line
 * that humans approve says so on its face.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildPlan } from "../src/engine/build.js";
import { renderPlan } from "../src/engine/render.js";
import { emptyState } from "../src/state/state.js";
import { CtApiError } from "../src/api/ctClient.js";
import type { DesiredResource } from "../src/engine/types.js";

/** The state + config used by every case: one managed group that declares a dynamic ruleset. */
function fixture() {
  const state = emptyState("https://x.church.tools");
  state.resources.sll_koblenz = {
    type: "group",
    id: 3213,
    key: "sll_koblenz",
    fields: { name: "SLL Koblenz" },
    adoptedAt: "t",
    updatedAt: "t",
  };
  const desired: DesiredResource[] = [
    {
      type: "group",
      key: "sll_koblenz",
      fields: { name: "SLL Koblenz" },
      dependsOn: [],
      dynamic: { status: "active", ruleset: { "==": [{ var: "person.id" }, 1] } },
    },
  ];
  return { state, desired };
}

beforeEach(() => {
  // The fold path warns on the failed read; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("plan degradation under 429 (#126)", () => {
  it("does NOT fabricate an update when the ruleset read is rate-limited", async () => {
    const { state, desired } = fixture();
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/groups/3213") return { name: "SLL Koblenz" } as T;
        // The sub-resource read is the one that 429s — the top-level GET succeeded, which is
        // exactly the "mild" regime the issue describes as the dangerous one.
        throw new CtApiError("GET /dynamicgroups/3213/ruleset failed (HTTP 429)", 429, null);
      },
    };

    const { plan, fetchErrors } = await buildPlan(client, state, desired);
    const item = plan.items.find((i) => i.key === "sll_koblenz")!;

    expect(item.action).toBe("no-op"); // NOT "update" — the old behaviour
    expect(item.note).toBe("fetch-failed");
    expect(item.changes).toEqual([]);
    // The failure is still reported, so `plan` exits 1 and `apply` refuses to run.
    expect(fetchErrors).toHaveLength(1);
    expect(fetchErrors[0]).toContain("429");
  });

  it("still diffs the ruleset normally when the read succeeds", async () => {
    const { state, desired } = fixture();
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/groups/3213") return { name: "SLL Koblenz" } as T;
        if (path === "/dynamicgroups/3213/ruleset") return { "==": [{ var: "person.id" }, 2] } as T;
        if (path === "/dynamicgroups/3213/status") return { dynamicGroupStatus: "active" } as T;
        throw new CtApiError(`not found: ${path}`, 404, null);
      },
    };

    const { plan, fetchErrors } = await buildPlan(client, state, desired);
    expect(fetchErrors).toEqual([]);
    // A genuine difference (person.id 2 live vs 1 declared) must still surface as an update —
    // the fix must not have bought its honesty by going blind.
    expect(plan.items.find((i) => i.key === "sll_koblenz")?.action).toBe("update");
  });

  it("a hierarchy read failure reports the opted-in groups rather than silently dropping parents", async () => {
    const state = emptyState("https://x.church.tools");
    state.resources.child = {
      type: "group",
      id: 10,
      key: "child",
      fields: { name: "Child" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    state.externals!.parent = {
      type: "group",
      id: 20,
      key: "parent",
      identity: { name: "Parent" },
      boundAt: "t",
    };
    const desired: DesiredResource[] = [
      { type: "group", key: "child", fields: { name: "Child" }, dependsOn: [], parents: ["parent"] },
    ];
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/groups/10") return { name: "Child" } as T;
        if (path === "/groups/20") return { name: "Parent" } as T;
        throw new CtApiError("GET /groups/hierarchies failed (HTTP 429)", 429, null);
      },
    };

    const { plan, fetchErrors } = await buildPlan(client, state, desired);
    const item = plan.items.find((i) => i.key === "child")!;
    expect(item.note).toBe("fetch-failed");
    expect(item.action).toBe("no-op");
    expect(fetchErrors.some((e) => e.includes("group hierarchies"))).toBe(true);
  });

  it("the summary line humans approve carries the unread count", () => {
    const rendered = renderPlan({
      items: [
        {
          type: "group",
          key: "a",
          id: 1,
          action: "update",
          changes: [{ field: "name", from: "x", to: "y", source: "config" }],
        },
        { type: "group", key: "b", id: 2, action: "no-op", changes: [], note: "fetch-failed", detail: "429" },
      ],
    } as unknown as Parameters<typeof renderPlan>[0]);

    // eslint-disable-next-line no-control-regex -- strip the colour codes renderPlan emits
    const plain = rendered.replace(/\[[0-9;]*m/g, "");
    expect(plain).toContain("Plan: 0 to create, 1 to update, 0 to delete.");
    // "1 to update" must never stand alone when a resource could not be read.
    expect(plain).toMatch(/to delete\..*INCOMPLETE — 1 resource\(s\) could not be read\./);
  });

  it("a complete plan's summary line stays exactly as it was", () => {
    const rendered = renderPlan({
      items: [
        {
          type: "group",
          key: "a",
          id: 1,
          action: "update",
          changes: [{ field: "name", from: "x", to: "y", source: "config" }],
        },
      ],
    } as unknown as Parameters<typeof renderPlan>[0]);
    // eslint-disable-next-line no-control-regex
    const plain = rendered.replace(/\[[0-9;]*m/g, "");
    expect(plain).toContain("Plan: 0 to create, 1 to update, 0 to delete.");
    expect(plain).not.toContain("INCOMPLETE");
  });
});
