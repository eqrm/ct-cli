import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startReviewServer, type ReviewServer } from "../src/dupes/web/server.js";
import { cleanDirs, patches, raw, setup } from "./dupes-fixtures.js";

const servers: ReviewServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.close();
    await s.closed;
  }
  cleanDirs();
});

async function start(t: ReturnType<typeof setup>) {
  const names = new Map([
    [1, { first: "Erika", last: "Muster", created: "2015-02-14T10:00:00Z", login: "" }],
    [2, { first: "Erika", last: "Beispiel", created: "2026-10-09T10:00:00Z", login: "" }],
  ]);
  const srv = await startReviewServer(t.deps, t.scan, names);
  servers.push(srv);
  const [base, token] = srv.url.split("/#") as [string, string];
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-Ct-Dupes-Token": token, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in assertions
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> };
  };
  return { srv, base, token, call };
}

describe("ct dupes review in the browser", () => {
  it("listens on 127.0.0.1 and serves the page without data", async () => {
    const { srv, base } = await start(setup());
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[\w-]{32}$/);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("Dubletten überprüfen");
    expect(html).not.toContain("Muster");
  });

  it("refuses API calls without the token", async () => {
    const { call } = await start(setup());
    expect((await call("/api/list", undefined, { "X-Ct-Dupes-Token": "nope" })).status).toBe(403);
    expect((await call("/api/list", undefined, { "X-Ct-Dupes-Token": "" })).status).toBe(403);
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const { base, token } = await start(setup());
    const url = new URL(`${base}/api/list`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: url.port,
          path: "/api/list",
          headers: { Host: "evil.example", "X-Ct-Dupes-Token": token },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("lists the pairs with the older person as Original and no raw ids when redacted", async () => {
    const { call } = await start(setup());
    const { json } = await call("/api/list");
    expect(json.candidates[0]).toMatchObject({
      index: 0,
      tier: "T1",
      state: "open",
      original: { id: "1", name: "Erika Muster", created: "2015-02-14" },
      duplicate: { id: "2", name: "Erika Beispiel" },
    });
    const red = await start(setup({}, true));
    const r = (await red.call("/api/list")).json;
    expect(JSON.stringify(r)).not.toMatch(/Muster|Beispiel/);
    expect(r.candidates[0].original.id).toMatch(/^P-/);
  });

  it("loads a pair, applies the page's choices and merges", async () => {
    const t = setup();
    const { call } = await start(t);
    const loaded = (await call("/api/pair", { index: 0 })).json;
    expect(loaded.pair.original.id).toBe("1");
    const last = loaded.pair.fields.find((f: { key: string }) => f.key === "lastName");
    expect(last).toMatchObject({ choice: "original", differs: true, section: "Adresse" });
    const res = await call("/api/merge", {
      index: 0,
      choices: { fields: { lastName: "duplicate", bogus: "x" } },
    });
    expect(res.json).toMatchObject({ ok: true, messages: ["Zusammengeführt."] });
    expect(patches(t.calls)[0]).toMatchObject({ path: "/persons/1/merge/2", body: { lastName: "Beispiel" } });
    expect(t.scan.candidates[0]!.state).toBe("merged");
    expect((await call("/api/merge", { index: 0, choices: {} })).status).toBe(409);
  });

  it("merges in the swapped direction", async () => {
    const t = setup();
    const { call } = await start(t);
    await call("/api/pair", { index: 0, swapped: true });
    await call("/api/merge", { index: 0, swapped: true, choices: {} });
    expect(patches(t.calls)[0]!.path).toBe("/persons/2/merge/1");
  });

  it("will not merge a pair that was not loaded in that direction", async () => {
    const t = setup();
    const { call } = await start(t);
    await call("/api/pair", { index: 0 });
    expect((await call("/api/merge", { index: 0, swapped: true, choices: {} })).status).toBe(409);
    expect(patches(t.calls)).toEqual([]);
  });

  it("cleans up shared groups with the chosen membership values", async () => {
    const t = setup({
      both: [{ id: 13, title: "Hauskreis" }],
      memberships: {
        "13:1": { memberStartDate: "2020-01-01", comment: null, fields: [] },
        "13:2": { memberStartDate: "2015-03-01", comment: "seit Beginn", fields: [] },
      },
    });
    const { call } = await start(t);
    const { pair } = (await call("/api/pair", { index: 0 })).json;
    expect(pair.groups[0].items.map((i: { key: string; choice: string }) => [i.key, i.choice])).toEqual([
      ["memberStartDate", "duplicate"],
      ["comment", "duplicate"],
    ]);
    await call("/api/merge", { index: 0, choices: { groups: { "13": { memberStartDate: "original" } } } });
    const groupPatch = t.calls.find((c) => c.method === "PATCH" && c.path === "/groups/13/members/1");
    expect(groupPatch!.body).toEqual({ comment: "seit Beginn" });
    expect(t.calls.some((c) => c.method === "DELETE" && c.path === "/groups/13/members/2")).toBe(true);
  });

  it("marks a pair as not a duplicate", async () => {
    const t = setup();
    const { call } = await start(t);
    const res = await call("/api/dismiss", { index: 1 });
    expect(res.json.ok).toBe(true);
    expect(t.scan.candidates[1]!.state).toBe("dismissed");
    expect((await call("/api/dismiss", { index: 99 })).status).toBe(404);
  });

  it("hands the finance export to the page as CSV after a merge with two Optigem IDs", async () => {
    const t = setup({ persons: { 1: raw(1, { optigemId: "10001" }), 2: raw(2, { optigemId: "10002" }) } });
    const { call } = await start(t);
    expect((await call("/api/finance-export", {})).json.count).toBe(0);
    await call("/api/pair", { index: 0 });
    expect((await call("/api/merge", { index: 0, choices: {} })).json.ok).toBe(true);
    const { json } = await call("/api/finance-export", {});
    expect(json.count).toBe(1);
    expect(json.filename).toMatch(/^optigem-merges-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(json.csv.split("\n")[1]).toMatch(/^1,[^,]*,10001,2,[^,]*,10002,10001,10002,false,/);
  });

  it("stops when the page says it is done", async () => {
    const { srv, call } = await start(setup());
    await call("/api/quit", {});
    await srv.closed;
  });
});
