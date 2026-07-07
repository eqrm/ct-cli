import { describe, it, expect } from "vitest";
import { computePlan } from "../src/engine/plan.js";
import type { DesiredResource } from "../src/engine/types.js";
import type { State, ManagedResource } from "../src/state/state.js";

const HOST = "https://eqrm.church.tools";

function desired(
  key: string,
  fields: Record<string, unknown>,
  opts: Partial<DesiredResource> = {},
): DesiredResource {
  return { type: "campus", key, fields, dependsOn: [], ...opts };
}

function managed(key: string, id: number, fields: Record<string, unknown>): ManagedResource {
  return { type: "campus", id, key, fields, adoptedAt: "t", updatedAt: "t" };
}

function managedT(type: string, key: string, id: number, fields: Record<string, unknown>): ManagedResource {
  return { type, id, key, fields, adoptedAt: "t", updatedAt: "t" };
}

function stateOf(...entries: ManagedResource[]): State {
  return { version: 1, host: HOST, resources: Object.fromEntries(entries.map((e) => [e.key, e])) };
}

/** actual is keyed by logical key. */
function actualOf(entries: Record<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(Object.entries(entries));
}

describe("computePlan", () => {
  it("plans a create for a config resource absent from state", () => {
    const plan = computePlan([desired("mainz", { name: "Mainz" })], stateOf(), new Map());
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ action: "create", key: "mainz", id: null });
    expect(plan.items[0]?.changes).toEqual([{ field: "name", from: undefined, to: "Mainz" }]);
  });

  it("is a no-op when desired matches actual (id 0 handled)", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 0, { name: "Mainz" })),
      actualOf({ mainz: { name: "Mainz" } }),
    );
    expect(plan.items[0]).toMatchObject({ action: "no-op", key: "mainz", id: 0 });
  });

  it("does not collide two resources of different types that share a CT id", () => {
    // campus 'mainz' #0 and group-type 'lead' #0 — a numeric-id map would overwrite one with the other.
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" }), desired("lead", { name: "Lead" }, { type: "group-type" })],
      stateOf(managed("mainz", 0, { name: "Mainz" }), managedT("group-type", "lead", 0, { name: "Lead" })),
      actualOf({ mainz: { name: "Mainz" }, lead: { name: "Lead" } }),
    );
    const byKey = Object.fromEntries(plan.items.map((i) => [i.key, i]));
    expect(byKey.mainz?.action).toBe("no-op");
    expect(byKey.lead?.action).toBe("no-op");
  });

  it("throws when a config key collides with a different type in state", () => {
    expect(() =>
      computePlan(
        [desired("x", { name: "A" }, { type: "campus" })],
        stateOf(managedT("group", "x", 1, { name: "A" })),
        actualOf({ x: { name: "A" } }),
      ),
    ).toThrow(/campus.*group|group.*campus/i);
  });

  it("throws for a desired resource whose type has no apply tier", () => {
    expect(() =>
      computePlan([desired("x", { name: "A" }, { type: "made-up" })], stateOf(), new Map()),
    ).toThrow(/Unknown resource type/);
  });

  it("plans an update with just the changed fields", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz HQ", shortName: "MZ" })],
      stateOf(managed("mainz", 5, { name: "Mainz", shortName: "MZ" })),
      actualOf({ mainz: { name: "Mainz", shortName: "MZ" } }),
    );
    expect(plan.items[0]).toMatchObject({ action: "update", id: 5 });
    expect(plan.items[0]?.changes).toEqual([{ field: "name", from: "Mainz", to: "Mainz HQ" }]);
  });

  it("does not flag a mere object-key-order difference as a change", () => {
    const plan = computePlan(
      [desired("mz", { nameTranslated: { en: "M", de: "M" } })],
      stateOf(managed("mz", 1, { nameTranslated: { en: "M", de: "M" } })),
      actualOf({ mz: { nameTranslated: { de: "M", en: "M" } } }), // reversed key order
    );
    expect(plan.items[0]?.action).toBe("no-op");
    expect(plan.items[0]?.changes).toEqual([]);
  });

  it("plans a delete for a managed resource dropped from config", () => {
    const plan = computePlan(
      [],
      stateOf(managed("old", 9, { name: "Old" })),
      actualOf({ old: { name: "Old" } }),
    );
    expect(plan.items[0]).toMatchObject({ action: "delete", key: "old", id: 9 });
  });

  it("surfaces a dropped resource already gone from ChurchTools as stale, not a silent no-op", () => {
    const plan = computePlan([], stateOf(managed("old", 9, { name: "Old" })), new Map());
    expect(plan.items[0]).toMatchObject({ action: "no-op", key: "old", id: 9, note: "stale" });
  });

  it("reports drift when ChurchTools differs from the last-known snapshot", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 5, { name: "Mainz", shortName: "MZ" })),
      actualOf({ mainz: { name: "Mainz", shortName: "CHANGED" } }),
    );
    expect(plan.items[0]?.drift).toEqual([{ field: "shortName", from: "MZ", to: "CHANGED" }]);
  });

  it("recreates a managed resource that has vanished from ChurchTools", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 5, { name: "Mainz" })),
      new Map(), // actual absent → 404
    );
    expect(plan.items[0]).toMatchObject({ action: "create", note: "recreate" });
  });

  it("leaves an unresolved-type managed resource untouched instead of recreating it", () => {
    const plan = computePlan(
      [desired("ag", { name: "A" }, { type: "age-group" })],
      stateOf(managedT("age-group", "ag", 3, { name: "A" })),
      new Map(), // could not fetch: type has no registry entry
      { unresolved: new Set(["ag"]) },
    );
    expect(plan.items[0]).toMatchObject({ action: "no-op", note: "unresolved-type" });
  });

  it("never surfaces unmanaged resources", () => {
    // actual contains a key that is neither in config nor state — must be ignored.
    const plan = computePlan([], stateOf(), actualOf({ ghost: { name: "Unmanaged" } }));
    expect(plan.items).toHaveLength(0);
  });

  it("orders create items by dependency (parent before child)", () => {
    const plan = computePlan(
      [
        desired("child", { name: "C" }, { type: "group", parent: "parent", dependsOn: ["parent"] }),
        desired("parent", { name: "P" }, { type: "group" }),
      ],
      stateOf(),
      new Map(),
    );
    expect(plan.items.map((i) => i.key)).toEqual(["parent", "child"]);
  });

  it("orders deletes in reverse tier order (higher tier first)", () => {
    const plan = computePlan(
      [],
      stateOf(managedT("campus", "c", 1, {}), managedT("group", "g", 2, {})),
      actualOf({ c: {}, g: {} }),
    );
    expect(plan.items.map((i) => i.key)).toEqual(["g", "c"]);
  });
});
