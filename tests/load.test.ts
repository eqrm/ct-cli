import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config/load.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("loadConfig", () => {
  it("loads a .ts config that default-exports a function", async () => {
    const resources = await loadConfig(join(here, "fixtures/sample.config.ts"));
    expect(resources.map((r) => r.key)).toEqual(["mainz", "kids_lead"]);
    expect(resources[1]).toMatchObject({ type: "group", parent: "mainz", dependsOn: ["mainz"] });
  });

  it("rejects a config that does not default-export a function", async () => {
    await expect(loadConfig(join(here, "fixtures/bad.config.ts"))).rejects.toThrow(
      /default-export a function/,
    );
  });
});
