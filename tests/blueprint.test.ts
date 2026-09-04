import { describe, it, expect } from "vitest";
import { evaluateConfig, type ConfigContext } from "../src/config/context.js";
import { orderKeys } from "../src/engine/graph.js";

// A blueprint instantiated across two campuses — the core #7 guarantee.
const blueprint = (ct: ConfigContext): void => {
  for (const c of ["mainz", "berlin"]) {
    ct.campus({ key: c, name: `Campus ${c}`, shorty: c.slice(0, 3) });
    ct.group({ key: `${c}_lead`, name: `${c} lead`, groupTypeId: 2, parents: [] });
    ct.group({ key: `${c}_team`, name: `${c} team`, groupTypeId: 2, parents: [`${c}_lead`] });
  }
};

describe("campus blueprint", () => {
  it("instantiates the full structure for every campus", async () => {
    const { resources } = await evaluateConfig(blueprint);
    const keys = resources.map((r) => r.key).sort();
    expect(keys).toEqual(["berlin", "berlin_lead", "berlin_team", "mainz", "mainz_lead", "mainz_team"]);
  });

  it("produces a correctly ordered plan: campuses before groups, parents before children", async () => {
    const { resources } = await evaluateConfig(blueprint);
    const order = orderKeys(resources);
    const pos = (k: string) => order.indexOf(k);
    for (const c of ["mainz", "berlin"]) {
      expect(pos(c)).toBeLessThan(pos(`${c}_lead`)); // campus (tier 0) before its groups (tier 1)
      expect(pos(`${c}_lead`)).toBeLessThan(pos(`${c}_team`)); // parent before child (intra-tier dependency)
    }
  });

  it("retains an undeclared hierarchy key for plan-time external binding validation", async () => {
    const broken = (ct: ConfigContext) => {
      ct.group({ key: "g", name: "g", groupTypeId: 2, parents: ["missing"] });
    };
    await expect(evaluateConfig(broken)).resolves.toMatchObject({
      resources: [expect.objectContaining({ parents: ["missing"] })],
    });
  });
});
