import { describe, it, expect } from "vitest";
import { resolveConfig, normalizeHost } from "../src/config.js";

const noStoredHost = async () => null;

describe("normalizeHost", () => {
  it("strips trailing slashes", () => {
    expect(normalizeHost("https://x.church.tools/")).toBe("https://x.church.tools");
    expect(normalizeHost("https://x.church.tools///")).toBe("https://x.church.tools");
  });
});

describe("resolveConfig", () => {
  it("prefers CT_HOST env over the stored host", async () => {
    const config = await resolveConfig({ CT_HOST: "https://env.church.tools" }, async () => "https://stored.church.tools");
    expect(config.host).toBe("https://env.church.tools");
  });

  it("falls back to the stored login host when no env is set", async () => {
    const config = await resolveConfig({}, async () => "https://stored.church.tools/");
    expect(config.host).toBe("https://stored.church.tools");
  });

  it("throws with a login hint when neither env nor a stored host is available", async () => {
    await expect(resolveConfig({}, noStoredHost)).rejects.toThrow(/ct auth login --host/);
  });
});
