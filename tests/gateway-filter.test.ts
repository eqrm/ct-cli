import { describe, it, expect } from "vitest";
import { checkRequest } from "../src/gateway/filter.js";

describe("gateway request filter", () => {
  it("allows a GET under /api and keeps the query", () => {
    expect(checkRequest("GET", "/api/groups/864?page=2", "")).toEqual({
      ok: true,
      method: "GET",
      path: "/api/groups/864",
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
