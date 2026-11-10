import { describe, it, expect } from "vitest";
import { checkRequest } from "../src/gateway/filter.js";

describe("gateway request filter", () => {
  it("allows a GET under /api and keeps the query", () => {
    expect(checkRequest("GET", "/api/groups/123?page=2", "")).toEqual({
      ok: true,
      method: "GET",
      path: "/api/groups/123",
      query: [["page", "2"]],
    });
  });

  it("strips login_token (any case) from the query", () => {
    const r = checkRequest("GET", "/api/whoami?login_token=secret&Login_Token=x&keep=1", "");
    expect(r).toMatchObject({ ok: true, query: [["keep", "1"]] });
  });

  it.each(["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])("blocks %s", (method) => {
    expect(checkRequest(method, "/api/groups/1", "{}").ok).toBe(false);
  });

  it("blocks GET outside /api and traversal", () => {
    expect(checkRequest("GET", "/index.php?q=churchdb/ajax", "").ok).toBe(false);
    expect(checkRequest("GET", "/api/../admin", "").ok).toBe(false);
    expect(checkRequest("GET", "/api//groups", "").ok).toBe(false);
  });

  it("allows exactly the two getMasterData POSTs", () => {
    for (const q of ["churchauth/ajax", "churchdb/ajax"]) {
      expect(checkRequest("POST", `/index.php?q=${q}`, "func=getMasterData").ok).toBe(true);
    }
  });

  it("blocks POSTs with another func, extra params, another module or another path", () => {
    expect(checkRequest("POST", "/index.php?q=churchdb/ajax", "func=deleteMasterData").ok).toBe(false);
    expect(checkRequest("POST", "/index.php?q=churchdb/ajax", "func=getMasterData&id=1").ok).toBe(false);
    expect(checkRequest("POST", "/index.php?q=churchdb/ajax&x=1", "func=getMasterData").ok).toBe(false);
    expect(checkRequest("POST", "/index.php?q=churchcal/ajax", "func=getMasterData").ok).toBe(false);
    expect(checkRequest("POST", "/api/groups", "func=getMasterData").ok).toBe(false);
    expect(checkRequest("POST", "/index.php?login_token=x", "func=getMasterData").ok).toBe(false);
  });
});

describe("gateway request filter: /simulate", () => {
  const on = { simulate: true };

  it("is denied without the option, and the reason names the flag", () => {
    const r = checkRequest("GET", "/simulate/42/api/persons/42", "");
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/--simulate/);
  });

  it("allows GET /simulate/<id>/api/... with the option, keeping the query and stripping login_token", () => {
    expect(checkRequest("GET", "/simulate/42/api/persons/42?a=1&login_token=s", "", on)).toEqual({
      ok: true,
      method: "GET",
      path: "/simulate/42/api/persons/42",
      query: [["a", "1"]],
      simulatePersonId: 42,
    });
  });

  it.each([
    "/simulate",
    "/simulate/",
    "/simulate/42",
    "/simulate/42/",
    "/simulate/0/api/x",
    "/simulate/042/api/x",
    "/simulate/-1/api/x",
    "/simulate/4.2/api/x",
    "/simulate/%34%32/api/x",
    "/simulate/42/index.php",
    "/simulate/42/api",
    "/simulate/42/../api/x",
    "/simulate//42/api/x",
    "/simulate/42/api//x",
    "/simulate/99999999999999999999/api/x",
  ])("denies %s", (path) => {
    expect(checkRequest("GET", path, "", on).ok).toBe(false);
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])("denies %s on /simulate", (m) => {
    expect(checkRequest(m, "/simulate/42/api/persons/42", "func=getMasterData", on).ok).toBe(false);
  });

  it("leaves /api and the legacy POSTs unchanged with the option on", () => {
    expect(checkRequest("GET", "/api/groups/1", "", on)).toEqual(checkRequest("GET", "/api/groups/1", ""));
    expect(checkRequest("POST", "/index.php?q=churchdb/ajax", "func=getMasterData", on).ok).toBe(true);
  });
});
