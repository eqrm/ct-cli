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

function stateOf(...entries: ManagedResource[]): State {
  return { version: 1, host: HOST, resources: Object.fromEntries(entries.map((e) => [e.key, e])) };
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
      new Map([[0, { name: "Mainz" }]]),
    );
    expect(plan.items[0]).toMatchObject({ action: "no-op", key: "mainz", id: 0 });
  });

  it("plans an update with just the changed fields", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz HQ", shortName: "MZ" })],
      stateOf(managed("mainz", 5, { name: "Mainz", shortName: "MZ" })),
      new Map([[5, { name: "Mainz", shortName: "MZ" }]]),
    );
    expect(plan.items[0]).toMatchObject({ action: "update", id: 5 });
    expect(plan.items[0]?.changes).toEqual([{ field: "name", from: "Mainz", to: "Mainz HQ" }]);
  });

  it("plans a delete for a managed resource dropped from config", () => {
    const plan = computePlan(
      [],
      stateOf(managed("old", 9, { name: "Old" })),
      new Map([[9, { name: "Old" }]]),
    );
    expect(plan.items[0]).toMatchObject({ action: "delete", key: "old", id: 9 });
  });

  it("reports drift when ChurchTools differs from the last-known snapshot", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 5, { name: "Mainz", shortName: "MZ" })),
      new Map([[5, { name: "Mainz", shortName: "CHANGED" }]]),
    );
    expect(plan.items[0]?.drift).toEqual([{ field: "shortName", from: "MZ", to: "CHANGED" }]);
  });

  it("recreates a managed resource that has vanished from ChurchTools", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 5, { name: "Mainz" })),
      new Map(), // actual absent → 404
    );
    expect(plan.items[0]).toMatchObject({ action: "create", recreated: true });
  });

  it("never surfaces unmanaged resources", () => {
    // actual contains an id that is neither in config nor state — must be ignored.
    const plan = computePlan([], stateOf(), new Map([[42, { name: "Unmanaged" }]]));
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
});
