import { describe, expect, it } from "vitest";
import { detect, pairKey, type DupePerson } from "../src/dupes/detector.js";
import { cleanName, normalizePhone } from "../src/dupes/normalize.js";

let nextId = 1;
function p(first: string, last: string, extra: Partial<DupePerson> = {}): DupePerson {
  return { id: nextId++, firstName: first, lastName: last, birthday: "1990-05-05", ...extra };
}

/** Detect over exactly two persons and return the single candidate (or undefined). */
function pairResult(a: DupePerson, b: DupePerson) {
  return detect([a, b])[0];
}

describe("normalisation", () => {
  it("expands umlauts, strips accents, keeps digits", () => {
    expect(cleanName("Jürgen Müßig 2")).toBe("juergen muessig 2");
    expect(cleanName("Kids1")).toBe("kids1");
    expect(cleanName("José (Pepe)")).toBe("jose pepe");
  });
  it("normalises phone numbers across country prefixes", () => {
    expect(normalizePhone("+49 151 2345678")).toBe(normalizePhone("0151/2345678"));
    expect(normalizePhone("123")).toBeNull();
  });
});

describe("match classes", () => {
  it.each([
    ["exact", p("Erika", "Muster"), p("Erika", "Muster")],
    ["middlename", p("Anna Marie", "Muster"), p("Anna", "Muster")],
    ["fuzzy", p("Naomi", "Muster"), p("Nomi", "Muster")],
    ["shortform", p("Christine", "Muster"), p("Tine", "Muster")],
    ["shortform", p("Christoph", "Muster Beispiel"), p("Chris", "Beispiel")],
    ["shortform", p("Seung Hun (Isaak)", "Muster"), p("Seunghun", "Muster")],
    ["nameswap", p("Erika", "Muster"), p("Muster", "Erika")],
    ["diminutive", p("Ursula", "Muster"), p("Ursi", "Muster")],
    ["diminutive", p("Gabriele", "Muster"), p("Gabi", "Muster")],
    ["diminutive", p("Peny", "Muster"), p("Penial", "Muster")],
    ["firsttoken", p("Maria Luise", "Muster"), p("Maria Anna", "Muster")],
  ])("classifies %s", (cls, a, b) => {
    const c = pairResult(a, b);
    expect(c?.matchClass).toBe(cls);
    expect(c?.source).toBe("detector");
  });

  it("treats a nickname equal to the other first name as exact evidence", () => {
    const c = pairResult(p("Katharina", "Muster", { nickname: "Kathi" }), p("Kathi", "Muster"));
    expect(c?.matchClass).toBe("exact");
    expect(c?.signals).toContain("name:nickname");
  });

  it("does not match different digits in names (Kids1 vs Kids2 style)", () => {
    expect(pairResult(p("Gruppe1", "Muster"), p("Gruppe2", "Muster"))).toBeUndefined();
  });

  it("scores unique email and phone above name-only evidence", () => {
    const a = p("Erika", "Muster", { email: "e@example.invalid", mobile: "0151 2345678" });
    const b = p("Erika", "Muster", { email: "e@example.invalid", mobile: "+49 151 2345678" });
    const c = pairResult(a, b)!;
    expect(c.tier).toBe("T1");
    expect(c.signals).toEqual(expect.arrayContaining(["email-unique", "phone-unique"]));
  });
});

describe("vetoes", () => {
  it("rejects a sex conflict, which also stops Andreas / Andrea", () => {
    const a = p("Andreas", "Muster", { sexId: 1 });
    const b = p("Andrea", "Muster", { sexId: 2 });
    expect(pairResult(a, b)).toBeUndefined();
  });

  it("does not treat an unset sex id (0 or null) as a value", () => {
    const a = p("Erika", "Muster", { sexId: 0 });
    const b = p("Erika", "Muster", { sexId: 2 });
    expect(pairResult(a, b)).toBeDefined();
  });

  it("rejects conflicting birthdays", () => {
    expect(
      pairResult(p("Erika", "Muster"), p("Erika", "Muster", { birthday: "1991-05-05" })),
    ).toBeUndefined();
  });

  it("rejects placeholder names and clusters of identical names", () => {
    expect(pairResult(p("Gast", "Muster"), p("Gast", "Muster"))).toBeUndefined();
    const cluster = Array.from({ length: 4 }, () => p("Testgruppe", "Ort 1"));
    expect(detect(cluster)).toEqual([]);
  });

  it("rejects pairs with a suppressing relationship", () => {
    const a = p("Erika", "Muster");
    const b = p("Erika", "Muster");
    expect(detect([a, b], { suppressed: new Set([pairKey(a.id, b.id)]) })).toEqual([]);
    expect(detect([a, b])).toHaveLength(1);
  });
});

describe("blocking and tiers", () => {
  it("finds pairs through a shared surname block only when scored >= 35", () => {
    const weak = pairResult(
      p("Erika", "Muster", { birthday: null }),
      p("Hans", "Muster", { birthday: null }),
    );
    expect(weak).toBeUndefined();
  });

  it("sorts best first and puts the smaller id in `a`", () => {
    const list = detect([
      p("Erika", "Muster"),
      p("Erika", "Muster"),
      p("Anna Marie", "Beispiel"),
      p("Anna", "Beispiel"),
    ]);
    expect(list[0]!.score).toBeGreaterThanOrEqual(list[1]!.score);
    for (const c of list) expect(c.a).toBeLessThan(c.b);
  });
});
