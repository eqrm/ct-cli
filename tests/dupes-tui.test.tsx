import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { loadNames } from "../src/dupes/actions.js";
import { App } from "../src/dupes/tui/App.js";
import { cleanDirs, patches, raw, setup, type FakeOpts } from "./dupes-fixtures.js";

afterEach(cleanDirs);

const KEY = {
  up: "\u001B[A",
  down: "\u001B[B",
  right: "\u001B[C",
  left: "\u001B[D",
  enter: "\r",
};
const wait = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function boot(opts: FakeOpts = {}, redact = false) {
  const t = setup(opts, redact);
  const names = await loadNames(t.deps.client);
  const ui = render(<App deps={t.deps} scan={t.scan} names={names} />);
  await wait();
  const press = async (k: string): Promise<void> => {
    ui.stdin.write(k);
    await wait();
  };
  const frame = (): string => ui.lastFrame() ?? "";
  return { ...t, ui, press, frame };
}

async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !f(); i++) await wait(20);
}

describe("list screen", () => {
  it("lists candidates, filters by tier and opens a pair", async () => {
    const t = await boot();
    expect(t.frame()).toContain("2 offen von 2");
    expect(t.frame()).toContain("T1");
    expect(t.frame()).toContain("T3");
    await t.press("3");
    expect(t.frame()).toContain("Filter: T3");
    expect(t.frame()).not.toContain(" T1 ");
    await t.press("a");
    expect(t.frame()).toContain("Filter: alle");
    await t.press(KEY.down);
    await t.press(KEY.up);
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Original"));
    expect(t.frame()).toContain("Duplikat");
    expect(t.frame()).toContain("ID: #1");
    expect(t.frame()).toContain("ID: #2");
  });

  it("hides names under --redact", async () => {
    const t = await boot({}, true);
    expect(t.frame()).not.toContain("Erika");
    expect(t.frame()).not.toContain("Muster");
  });
});

describe("pair screen", () => {
  it("shows only differing fields and toggles identical fields", async () => {
    const t = await boot();
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Feld"));
    expect(t.frame()).toContain("Nachname");
    expect(t.frame()).not.toContain("Vorname");
    expect(t.frame()).not.toContain("GUID");
    expect(t.frame()).toContain("Gruppen: 1 (Duplikat: 2), gemeinsam: 1");
    await t.press("i");
    expect(t.frame()).toContain("Hauptcampus");
    expect(t.frame()).not.toContain("GUID");
    await t.press("i");
    expect(t.frame()).not.toContain("Hauptcampus");
  });

  it("swaps original and duplicate and merges in that direction", async () => {
    const t = await boot();
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Feld"));
    await t.press("t");
    await until(
      () => t.frame().includes("ID: #2") && t.frame().indexOf("ID: #2") < t.frame().indexOf("ID: #1"),
    );
    await t.press("m");
    expect(t.frame()).toContain("Zusammenführen?");
    await t.press("y");
    await until(() => patches(t.calls).length === 1);
    expect(patches(t.calls)[0]!.path).toBe("/persons/2/merge/1");
    await until(() => t.frame().includes("Merged."));
    await t.press("x");
    await until(() => t.frame().includes("Duplikate prüfen"));
    expect(t.scan.candidates[0]!.state).toBe("merged");
    expect(t.frame()).toContain("[merged]");
  });

  it("takes the duplicate's value with left arrow and sends it in the PATCH body", async () => {
    const t = await boot();
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Feld"));
    await t.press(KEY.left);
    await t.press("m");
    expect(t.frame()).toContain("Beispiel");
    await t.press(KEY.enter);
    await until(() => patches(t.calls).length === 1);
    const p = patches(t.calls)[0]!;
    expect(p.path).toBe("/persons/1/merge/2");
    expect(p.body).toMatchObject({ lastName: "Beispiel", guid: "guid-1", mobile: "0151" });
  });

  it("right arrow restores the Original's value and x clears it", async () => {
    const t = await boot();
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Feld"));
    await t.press(KEY.left);
    await t.press(KEY.right);
    await t.press("x");
    await t.press("m");
    await t.press("y");
    await until(() => patches(t.calls).length === 1);
    expect(patches(t.calls)[0]!.body).toMatchObject({ lastName: "" });
  });

  it("toggles an email address and moves the default", async () => {
    const persons = {
      1: raw(1, { emails: [{ id: 1, email: "a@example.org", isDefault: true }] }),
      2: raw(2, { emails: [{ id: 9, email: "b@example.org", isDefault: true }] }),
    };
    const t = await boot({ persons, personDiff: [] });
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Feld"));
    expect(t.frame()).toContain("[x] a@example.org *");
    expect(t.frame()).toContain("[x] b@example.org");
    await t.press(KEY.down);
    await t.press("*");
    expect(t.frame()).toContain("[x] b@example.org *");
    await t.press(KEY.up);
    await t.press(" ");
    expect(t.frame()).toContain("[ ] a@example.org");
    await t.press("m");
    await t.press("y");
    await until(() => patches(t.calls).length === 1);
    expect((patches(t.calls)[0]!.body as { emails: unknown[] }).emails).toEqual([
      { email: "b@example.org", isDefault: true },
    ]);
  });

  it("marks 'keine Dublette', saves the state and moves to the next open pair", async () => {
    const t = await boot();
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Feld"));
    await t.press("n");
    await until(() => t.frame().includes("Marked as not a duplicate"));
    await t.press("x");
    await until(() => t.frame().includes("Duplikate prüfen"));
    expect(t.calls).toEqual([
      { method: "POST", path: "/persons/1/relationships", body: { otherPersonId: 2, relationshipTypeId: 4 } },
    ]);
    expect(t.scan.candidates[0]!.state).toBe("dismissed");
    expect(t.store.loadScan()!.candidates[0]!.state).toBe("dismissed");
    expect(t.frame()).toContain("1 offen von 2");
  });

  it("shows only the HTTP status when the merge fails and keeps the pair open", async () => {
    const t = await boot({ patchFails: true });
    await t.press(KEY.enter);
    await until(() => t.frame().includes("Feld"));
    await t.press("m");
    await t.press("y");
    await until(() => t.frame().includes("Merge failed (HTTP 500)"));
    expect(t.frame()).not.toContain("boom");
    await t.press("x");
    await until(() => t.frame().includes("Duplikate prüfen"));
    expect(t.scan.candidates[0]!.state).toBe("open");
  });
});
