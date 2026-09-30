import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  normalizeRuleset,
  stripCosmeticLabels,
  coerceScalars,
  normalizeDynamic,
  putRulesetBody,
} from "../src/engine/dynamic.js";

describe("stripCosmeticLabels", () => {
  it("unwraps a dterm with a string label to its expr, recursively", () => {
    const input = { and: [{ dterm: ["Campus", { "==": [{ var: "ctgroup.campusId" }, 1] }] }] };
    expect(stripCosmeticLabels(input)).toEqual({ and: [{ "==": [{ var: "ctgroup.campusId" }, 1] }] });
  });
  it("unwraps a dterm with a title-only object label (i18n key)", () => {
    const input = {
      dterm: [{ title: "group.x.title" }, { isnull: [{ var: "person.dateOfDeath" }] }],
    };
    expect(stripCosmeticLabels(input)).toEqual({ isnull: [{ var: "person.dateOfDeath" }] });
  });
  it("keeps a groupmembership stereotype wrapper: it changes what a negated group condition selects", () => {
    // MHfsH (eqrm/ct-structure): `!(member of Entabonniert)` excluded no one once apply had
    // written it without this wrapper — the label is part of the query, not decoration.
    const label = { stereotype: ["groupmembership"], title: "Mitgliedschaft in einer Gruppe" };
    const input = {
      "!": [{ dterm: [label, { and: [{ dterm: ["Merkmal", { oneof: [{ var: "ctgroup.id" }, ["2224"]] }] }] }] }],
    };
    const out = stripCosmeticLabels(input);
    expect(out).toEqual({ "!": [{ dterm: [label, { and: [{ oneof: [{ var: "ctgroup.id" }, ["2224"]] }] }] }] });
    expect(stripCosmeticLabels(out)).toEqual(out); // idempotent
  });
});

describe("coerceScalars", () => {
  it("coerces numeric strings to numbers so int/string drift is not spurious", () => {
    expect(coerceScalars({ "==": [{ var: "ctgroup.campusId" }, "1"] })).toEqual({
      "==": [{ var: "ctgroup.campusId" }, 1],
    });
  });
  it("coerces numeric strings inside oneof arrays but leaves non-numeric strings", () => {
    expect(coerceScalars({ oneof: [{ var: "ctgroup.id" }, ["112", "8"]] })).toEqual({
      oneof: [{ var: "ctgroup.id" }, [112, 8]],
    });
    expect(coerceScalars({ "==": [{ var: "groupmember.groupMemberStatus" }, "active"] })).toEqual({
      "==": [{ var: "groupmember.groupMemberStatus" }, "active"],
    });
  });
  it("leaves leading-zero and >2^53 numeric strings as strings (no corruption, no precision loss)", () => {
    // A leading-zero zip code is a semantic string; parseInt would drop the zero and break the compare.
    expect(coerceScalars({ "==": [{ var: "person.zip" }, "01067"] })).toEqual({
      "==": [{ var: "person.zip" }, "01067"],
    });
    // A digit string beyond MAX_SAFE_INTEGER can't be represented exactly — must stay a string.
    const big = "90071992547409910"; // > 2^53
    expect(coerceScalars({ "==": [{ var: "x.id" }, big] })).toEqual({ "==": [{ var: "x.id" }, big] });
    // Canonical ints still coerce, so a 5 vs "5" int/string pair keeps diffing equal.
    expect(coerceScalars({ "==": [{ var: "x.n" }, "5"] })).toEqual({ "==": [{ var: "x.n" }, 5] });
    expect(coerceScalars({ "==": [{ var: "x.n" }, "0"] })).toEqual({ "==": [{ var: "x.n" }, 0] });
  });
});

describe("normalizeRuleset", () => {
  it("drops read-only timestamps and the PUT envelope, and is idempotent", () => {
    const withEnvelope = {
      dynamicGroupRuleSet: { description: "x", dynamicGroupUpdateStarted: "t", process: {}, query: {} },
    };
    const once = normalizeRuleset(withEnvelope);
    expect(once).not.toHaveProperty("dynamicGroupUpdateStarted");
    expect(once).not.toHaveProperty("dynamicGroupRuleSet");
    expect(normalizeRuleset(once)).toEqual(once); // idempotent: read→normalize→normalize == normalize
  });

  it("unwraps the single-element array that GET returns", () => {
    const arr = [{ description: "x", process: {}, query: {} }];
    expect(normalizeRuleset(arr)).toEqual(normalizeRuleset(arr[0]));
  });

  it("coerces filter operands but leaves numeric-looking RuleSet-level fields as strings", () => {
    const r = {
      description: "2024",
      shorty: "007",
      personIdFieldName: "person.id",
      query: { "==": [{ var: "ctgroup.id" }, "112"] },
      process: {},
    };
    const out = normalizeRuleset(r);
    expect(out.description).toBe("2024"); // stays a string, not 2024
    expect(out.shorty).toBe("007"); // stays a string, not 7
    expect(out.query).toEqual({ "==": [{ var: "ctgroup.id" }, 112] }); // filter operand coerced
  });

  it("round-trips a leading-zero query leaf byte-identical (no retype on write-back)", () => {
    const authored = {
      description: "Zip filter",
      query: { "==": [{ var: "person.zip" }, "01067"] },
      process: {},
    };
    const once = normalizeRuleset(authored);
    // The zip leaf survives normalization untouched — apply PUTs `to.ruleset`, so any retype here
    // would be written back to CT and silently break the JSONLogic string comparison.
    expect(once.query).toEqual({ "==": [{ var: "person.zip" }, "01067"] });
    expect(JSON.stringify(normalizeRuleset(once))).toBe(JSON.stringify(once)); // byte-identical + idempotent
  });

  it("read-then-normalize of every live fixture is stable and keeps only stereotype labels", () => {
    for (const name of ["ruleset-683", "ruleset-2022", "ruleset-1092"]) {
      const raw = JSON.parse(readFileSync(`tests/fixtures/dynamic/${name}.get.json`, "utf8")); // array shape
      const once = normalizeRuleset(raw);
      expect(normalizeRuleset(once)).toEqual(once); // idempotent
      const labels: unknown[] = [];
      const collect = (n: unknown): void => {
        if (Array.isArray(n)) n.forEach(collect);
        else if (n && typeof n === "object") {
          const o = n as Record<string, unknown>;
          if (Array.isArray(o.dterm)) labels.push(o.dterm[0]);
          Object.values(o).forEach(collect);
        }
      };
      collect(once);
      // cosmetic labels stripped; every surviving wrapper is a semantic stereotype
      expect(labels.every((l) => !!l && typeof l === "object" && "stereotype" in (l as object))).toBe(true);
    }
  });
});

describe("putRulesetBody (#77)", () => {
  it("wraps the ruleset as { dynamicGroupRuleSet: [ruleset] } — object root, single-element array property", () => {
    const ruleset = { description: "x", query: {}, process: {} };
    expect(putRulesetBody(ruleset)).toEqual({ dynamicGroupRuleSet: [ruleset] });
  });

  it("is NEITHER the bare object NOR the bare array — CT 3.134.1 rejects both (live-decoded, #77)", () => {
    const ruleset = { description: "x", query: {}, process: {} };
    const body = putRulesetBody(ruleset);
    expect(Array.isArray(body)).toBe(false);
    expect(Array.isArray(body.dynamicGroupRuleSet)).toBe(true);
    expect(body.dynamicGroupRuleSet).toHaveLength(1);
  });
});

describe("normalizeDynamic", () => {
  it("normalizes status + ruleset together", () => {
    const out = normalizeDynamic({ status: "manual", ruleset: { description: "x", query: {}, process: {} } });
    expect(out.status).toBe("manual");
    expect(out.ruleset).toHaveProperty("description", "x");
  });
});
