import { describe, it, expect, afterEach } from "vitest";
import { readToken } from "../src/auth/tokenStore.js";

const original = process.env.CT_LOGINTOKEN;

afterEach(() => {
  if (original === undefined) {
    delete process.env.CT_LOGINTOKEN;
  } else {
    process.env.CT_LOGINTOKEN = original;
  }
});

describe("readToken", () => {
  it("prefers the CT_LOGINTOKEN env var over any store", async () => {
    process.env.CT_LOGINTOKEN = "env-token";
    await expect(readToken("https://eqrm.church.tools")).resolves.toBe("env-token");
  });
});
