/**
 * Typed query builder for dynamic-group rulesets (Phase 2). Emits a JSONLogic
 * tree that lives inside the ChurchQuery `params.filter`. `var` values are raw
 * ChurchTools ids — resolve keys → ids at config-build time and pass the number.
 *
 * `churchQuery` wraps a filter in the same envelope shape ChurchTools itself
 * returns (see tests/fixtures/dynamic/ruleset-683.get.json, ruleset-2022.get.json,
 * ruleset-1092.get.json): `{ method: "ChurchQuery", params: {
 * groupBy, filter, primaryEntityAlias, responseFields } }` — no `description`
 * here; that field lives on the ruleset object, not inside `query`. Defaults
 * are the observed common case (grouping/returning by `person.id`); override
 * via `opts` for a query keyed on a different primary entity.
 */
// Re-exported so a ruleset built with this DSL can drop a logical reference straight into a `var`
// value: `q.eq("ctgroup.campusId", ref.campus("mainz"))`. The Ref is an inert sentinel the per-host
// resolver turns into a numeric id at plan time (#20) — the numeric escape hatch still works too.
export { ref } from "../resolve/refs.js";

export interface QueryNode {
  [op: string]: unknown;
}

export const q = {
  and: (...n: QueryNode[]): QueryNode => ({ and: n }),
  or: (...n: QueryNode[]): QueryNode => ({ or: n }),
  not: (n: QueryNode): QueryNode => ({ "!": [n] }),
  var: (name: string): QueryNode => ({ var: name }),
  eq: (varName: string, value: unknown): QueryNode => ({ "==": [{ var: varName }, value] }),
  oneof: (varName: string, values: unknown[]): QueryNode => ({ oneof: [{ var: varName }, values] }),
  isnull: (varName: string): QueryNode => ({ isnull: [{ var: varName }] }),
  /** Evaluate a group condition per person ("is a member of …"), not per membership row — wrap
   *  every `ctgroup.*` condition you negate: `q.not(q.oneof("ctgroup.id", …))` alone excludes no
   *  one who has any other membership. Same `groupmembership` stereotype the CT editor writes. */
  memberOf: (n: QueryNode): QueryNode => ({ dterm: [{ stereotype: ["groupmembership"] }, n] }),
};

/** Wrap a JSONLogic filter in the ChurchQuery envelope the ruleset `query` field expects.
 *  Shape matches real production rulesets exactly: { method, params } — no `description` here
 *  (`description` is a sibling field on the ruleset object, not inside `query`). */
export function churchQuery(
  filter: QueryNode,
  opts: { primaryEntityAlias?: string; responseFields?: string[]; groupBy?: string[] } = {},
): Record<string, unknown> {
  return {
    method: "ChurchQuery",
    params: {
      groupBy: opts.groupBy ?? ["person.id"],
      filter,
      primaryEntityAlias: opts.primaryEntityAlias ?? "person",
      responseFields: opts.responseFields ?? ["person.id", "person.firstName", "person.lastName"],
    },
  };
}
