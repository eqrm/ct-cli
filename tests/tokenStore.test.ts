import { describe, it, expect, afterEach } from "vitest";
import { readToken, parseCredentials } from "../src/auth/tokenStore.js";

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
    await expect(readToken()).resolves.toBe("env-token");
  });
});

describe("parseCredentials", () => {
  it("parses a well-formed {host, token} blob", () => {
    expect(parseCredentials('{"host":"https://x.church.tools","token":"tok"}')).toEqual({
      host: "https://x.church.tools",
      token: "tok",
    });
  });

  it("rejects a legacy bare-token value (non-JSON)", () => {
    expect(parseCredentials("just-a-raw-token")).toBeNull();
  });

  it("rejects a blob missing host or token", () => {
    expect(parseCredentials('{"token":"tok"}')).toBeNull();
    expect(parseCredentials('{"host":"https://x","token":""}')).toBeNull();
  });
});
