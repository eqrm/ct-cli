import { describe, it, expect } from "vitest";
import { q, churchQuery } from "../src/config/query.js";
import { normalizeRuleset, stripCosmeticLabels } from "../src/engine/dynamic.js";

describe("typed query builder", () => {
  it("builds a JSONLogic tree", () => {
    const tree = q.and(q.eq("ctgroup.campusId", 1), q.eq("person.isArchived", false));
    expect(tree).toEqual({
      and: [{ "==": [{ var: "ctgroup.campusId" }, 1] }, { "==": [{ var: "person.isArchived" }, false] }],
    });
  });

  it("oneof and isnull", () => {
    expect(q.oneof("ctgroup.groupTypeId", [1, 2])).toEqual({
      oneof: [{ var: "ctgroup.groupTypeId" }, [1, 2]],
    });
    expect(q.isnull("person.isArchived")).toEqual({ isnull: [{ var: "person.isArchived" }] });
  });

  it("q.not array-wraps the operand, matching the real ruleset's `!` shape", () => {
    const operand = q.isnull("person.dateOfDeath");
    expect(q.not(operand)).toEqual({ "!": [{ isnull: [{ var: "person.dateOfDeath" }] }] });
  });

  it("q.memberOf wraps in the groupmembership stereotype, which normalization keeps", () => {
    const node = q.memberOf(q.oneof("ctgroup.id", [7]));
    expect(node).toEqual({
      dterm: [{ stereotype: ["groupmembership"] }, { oneof: [{ var: "ctgroup.id" }, [7]] }],
    });
    expect(stripCosmeticLabels(node)).toEqual(node);
  });

  it("q.or", () => {
    const a = q.eq("ctgroup.campusId", 1);
    const b = q.eq("person.isArchived", false);
    expect(q.or(a, b)).toEqual({ or: [a, b] });
  });

  it("churchQuery wraps the filter in the real ChurchQuery envelope shape", () => {
    const cq = churchQuery(q.eq("ctgroup.campusId", 1));
    expect(cq).toEqual({
      method: "ChurchQuery",
      params: {
        groupBy: ["person.id"],
        filter: { "==": [{ var: "ctgroup.campusId" }, 1] },
        primaryEntityAlias: "person",
        responseFields: ["person.id", "person.firstName", "person.lastName"],
      },
    });
  });

  it("churchQuery allows overriding envelope defaults", () => {
    const cq = churchQuery(q.isnull("person.dateOfDeath"), {
      groupBy: ["person.id", "ctgroup.id"],
      primaryEntityAlias: "ctgroup",
      responseFields: ["ctgroup.id"],
    });
    expect(cq).toEqual({
      method: "ChurchQuery",
      params: {
        groupBy: ["person.id", "ctgroup.id"],
        filter: { isnull: [{ var: "person.dateOfDeath" }] },
        primaryEntityAlias: "ctgroup",
        responseFields: ["ctgroup.id"],
      },
    });
  });

  it("a built ruleset normalizes stably (matches read-back normalization)", () => {
    const ruleset = {
      description: "x",
      importance: 0,
      personIdFieldName: "id",
      process: {},
      query: churchQuery(q.eq("ctgroup.campusId", 1)),
    };
    expect(normalizeRuleset(normalizeRuleset(ruleset))).toEqual(normalizeRuleset(ruleset));
  });

  it("matches the shape of a real production ruleset's query envelope keys", () => {
    const cq = churchQuery(q.eq("ctgroup.campusId", 1));
    expect(Object.keys(cq).sort()).toEqual(["method", "params"]);
    expect(Object.keys(cq.params as Record<string, unknown>).sort()).toEqual([
      "filter",
      "groupBy",
      "primaryEntityAlias",
      "responseFields",
    ]);
  });
});
