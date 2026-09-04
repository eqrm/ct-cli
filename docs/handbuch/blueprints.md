---
title: Blueprints
sources:
  - src/config/context.ts
  - src/engine/graph.ts
  - src/engine/hierarchy.ts
sources_hash: 3effed6bfffdc517
reviewed: 2026-08-29
---

# Blueprints (parametrized, reusable config)

A "blueprint" is not a feature the tool implements — it's a naming for a
pattern the existing config DSL already supports for free. `ct.config.ts`
default-exports a plain function that receives the injected
[`ConfigContext`](https://github.com/eqrm/ct-cli/blob/main/src/config/context.ts) (`ct.campus`, `ct.group`,
`ct.groupTypeRole`, ...) and calls it however you like: in a loop, from a
helper function, across multiple files. There is no special "blueprint"
API, decorator, or registration step — just TypeScript functions closing
over `ct` (issue #7).

See [`examples/campus-blueprint.config.ts`](https://github.com/eqrm/ct-cli/blob/main/examples/campus-blueprint.config.ts)
for a complete, runnable example; this doc walks through what it does and
why.

## A blueprint is a function over `ConfigContext`

Pull the campus-specific parts of a config out into a function that takes
`ct: ConfigContext` plus whatever varies per instantiation (a campus key, a
label, an id):

```ts
import type { ConfigContext } from "../src/config/context.js";

function kidsArea(ct: ConfigContext, campus: string): void {
  const lead = `${campus}_kids_lead`;
  ct.group({ key: lead, name: `${campus} · Kids Leitung`, groupTypeId: 2, parents: [] });
  // ...more ct.group(...) calls scoped to this campus
}
```

Calling `kidsArea(ct, "mainz")` and `kidsArea(ct, "berlin")` from the same
default export declares two independent Kids-area structures — one per
campus — using the same code. That's the whole mechanism: no templating
language, no generated files, just a function called twice.

### Assigning the blueprint's groups to their campus

Link a group to a campus **by key** — `campus: "mainz"` (or, when the campus key
is a loop variable, `campus`) — and the per-host resolver fills in the id (#20).
When the blueprint _creates_ the campus in the same apply, its id is unknown at
eval time, so the resolver marks the link **pending** and writes the
freshly-created id at apply time (tier ordering creates the campus first). `ct
plan` renders it as `campusId = <campus:mainz (created this apply)>`.

The same portability applies to the group type: `groupType: "ministry_team"`
resolves through that host's managed or explicitly external state, with no
hardcoded `groupTypeId`. If another ct project owns it, bind it once per host
with `ct use group-type <id> --key ministry_team`; plan never guesses from the
live catalog.

```ts
function kidsArea(ct: ConfigContext, campus: string): void {
  const lead = `${campus}_kids_lead`;
  // group type BY NAME, campus BY KEY — both resolved per host (#20).
  ct.group({ key: lead, name: `${campus} · Kids Leitung`, groupType: "ministry_team", campus, parents: [] });
}
```

The **numeric escape hatch** stays available: pass `campusId: <existing id>`
(CT stores it at `information.campusId`; `campusId: null` clears it) or
`groupTypeId: 2` to target one instance's id directly. `ct plan` diffs a campus
assign/move/clear as a normal field update — see
[`docs/group-field-decisions.md`](https://github.com/eqrm/ct-cli/blob/main/docs/group-field-decisions.md). Declaring both the
logical and the numeric form for one field (`campus` + `campusId`) is a conflict
and throws at eval time.

## The loop-over-campuses pattern and `${campus}_`-prefixed keys

Because every declared resource needs a config-wide-unique `key`
(`createContext`'s `define` throws on a duplicate), a blueprint that's
instantiated per campus must prefix every key it declares with the thing
that makes it unique — typically the campus key:

```ts
const CAMPUSES = ["mainz", "berlin"] as const;

export default (ct: ConfigContext): void => {
  for (const campus of CAMPUSES) {
    ct.campus({ key: campus, name: `Campus ${campus}`, shorty: campus.slice(0, 3).toUpperCase() });
    kidsArea(ct, campus); // declares mainz_kids_lead, mainz_kids_0_3, ... / berlin_kids_lead, ...
  }
};
```

`${campus}_kids_lead`, `${campus}_kids_0_3`, `${campus}_kids_checkin`, and so
on give every campus's copy of the structure its own non-colliding key
namespace, while the _shape_ (lead group + N ministry teams) stays defined
once in `kidsArea`. Add a third campus to `CAMPUSES` and the same function
produces a third, fully independent structure — no changes to `kidsArea`
itself.

## `parents` scopes hierarchy per campus

Group hierarchy (`parents`) is opt-in and references other groups **by
key** (see [`dynamic-groups.md`](dynamic-groups.md) and the DSL doc
comment in [`src/config/context.ts`](https://github.com/eqrm/ct-cli/blob/main/src/config/context.ts)). Because
each campus's group keys are prefixed, a blueprint's `parents: [lead]`
inside `kidsArea` naturally scopes hierarchy to that one campus's own
`lead` variable — `berlin_kids_0_3`'s `parents` can only ever point at
`berlin_kids_lead` (the closure captured `lead = "berlin_kids_lead"` for
that call), never at Mainz's tree:

```ts
function kidsArea(ct: ConfigContext, campus: string): void {
  const lead = `${campus}_kids_lead`;
  ct.group({ key: lead, name: `${campus} · Kids Leitung`, groupTypeId: 2, parents: [] });
  for (const [suffix, label] of [
    ["0_3", "0–3"],
    ["4_6", "4–6"],
    ["checkin", "Check-in"],
  ] as const) {
    ct.group({
      key: `${campus}_kids_${suffix}`,
      name: `${campus} · Kids ${label}`,
      groupTypeId: 2,
      parents: [lead], // always this campus's own lead group
    });
  }
}
```

No cross-campus hierarchy edges can leak in by accident — the prefixing
convention and lexical scoping do that for you.

## Composing an auto-group and a permission grant inside a blueprint

Because a blueprint is just code calling `ct.*`, it can freely mix resource
types. `kidsArea` declares a `dynamic` block (an auto-group, #14 — see
[`dynamic-groups.md`](dynamic-groups.md)) on the "all members" group
right alongside the plain groups:

```ts
ct.group({
  key: `${campus}_kids_all`,
  name: `${campus} · Kids (alle)`,
  groupTypeId: 2,
  parents: [lead],
  dynamic: {
    status: "manual",
    ruleset: {
      description: `Alle aktiven Kids-Mitarbeiter ${campus}`,
      importance: 0,
      personIdFieldName: "person.id",
      process: {},
      query: churchQuery(q.eq("person.isArchived", false)),
    },
  },
});
```

And the outer default export layers a permission grant (#13 — see
[`permissions.md`](permissions.md)) on a shared `groupTypeRole`
template, declared once and applying across every campus's groups of that
type:

```ts
export default (ct: ConfigContext): void => {
  for (const campus of CAMPUSES) {
    ct.campus({ key: campus, name: `Campus ${campus}`, shorty: campus.slice(0, 3).toUpperCase() });
    kidsArea(ct, campus);
  }
  const kidsLeads = CAMPUSES.map((c) => `${c}_kids_lead`);
  ct.groupTypeRole({
    key: "kids_lead_tpl",
    id: 2,
    grants: [
      { right: "churchgroup:view group", scope: kidsLeads },
      { right: "churchgroup:edit group memberships of group", scope: kidsLeads },
    ],
  });
};
```

There's nothing blueprint-specific about `dynamic` or `groupTypeRole` here
— they're the same DSL calls documented in
[`dynamic-groups.md`](dynamic-groups.md) and
[`permissions.md`](permissions.md), just invoked from inside a
reusable function instead of inline at the top level.

## Ordering is automatic

`ct plan` / `ct apply` order every declared resource with
[`orderKeys`](https://github.com/eqrm/ct-cli/blob/main/src/engine/graph.ts), which sorts by a fixed type tier
(`campus` / `group-type` / ... at tier 0, `group` at tier 1) and then, within
a tier, by dependency edges — honouring ties by original declaration order.
A blueprint doesn't need to worry about sequencing:

- **Campuses before groups.** `ct.campus(...)` is tier 0; `ct.group(...)` is
  tier 1, so every campus in the loop is created before any of that campus's
  groups, regardless of call order inside the loop body.
- **Parent groups before child groups.** `parents: [lead]` adds `lead` as a
  dependency edge on the child (`toDesired` folds `parents` into
  `dependsOn`), so `orderKeys` always places `${campus}_kids_lead` before
  `${campus}_kids_0_3`/`_4_6`/`_checkin`/`_all` — the topological sort
  guarantees it structurally, not by declaration order.
- **Hierarchy, member fields and auto-group state ride along with their
  group.** `parents`, `memberFields` and `dynamic` are _synthetic fields_ on
  the `group` resource itself (see `SYNTHETIC_FIELDS` in
  [`src/engine/synthetic.ts`](https://github.com/eqrm/ct-cli/blob/main/src/engine/synthetic.ts)),
  not separate resources with their own tier — they're diffed and applied as
  part of that same group's create/update, once the group (and, for
  `parents`, its referenced parent groups) already exist. Within one group
  they are written in that registered order, so a group's member fields exist
  before a ruleset that references them is installed.
- **Permissions apply after the structural plan.** `ct.groupTypeRole` /
  `ct.groupRole` declarations aren't part of `orderKeys`'s dependency graph
  at all — they go through a separate plan/apply pass
  (`buildPermissionPlan` / `applyPermissionPlan`) that `ct apply` runs only
  after the structural plan (campuses, groups, hierarchy, auto-groups) has
  been applied. So a scoped grant's `scope: ["some_group_key"]` can safely
  reference a group declared earlier in the same blueprint, even one created
  in this very run.

Net effect for a two-campus blueprint like the example: `ct plan` always
produces campuses → lead groups → ministry-team groups (in per-campus,
per-group declaration order) → permission grants, for as many campuses as
the loop instantiates, with no manual `parent:`/`dependsOn` bookkeeping
beyond the `parents: [lead]` you'd write anyway.

## Parent-reference validation

`parents` references are checked in two stages. Config evaluation
(`validateReferences` in
[`src/config/context.ts`](https://github.com/eqrm/ct-cli/blob/main/src/config/context.ts)) immediately rejects a key
that is declared as a non-group resource. A key not declared in this config is
allowed to continue because it may name an external parent recorded in this
host's state. Plan then resolves it as a group and validates a bound external's
live hard identity before any write. A key in neither managed nor external state
blocks plan with a copyable `ct use group <id> --key <key>` remedy when discovery
finds a candidate.

```
External prerequisite is not available
resource: group "berlin_kids_laed"
Consequence: Consumer plan/apply is blocked before writes.
```

The same pass validates **group member field references** (#135): a
`ref.groupMemberField("<group>", "<field>")` anywhere in a declaration — a
dynamic ruleset included — must name a group declared in this config that
declares that field, or `evaluateConfig` throws before any plan runs. Member
fields are the surface where this matters most in a blueprint, because a field
is owned by exactly one group: a blueprint instantiated twice creates two
independent `wahl` fields, and a reference must say _which group's_.

The reference's `<field>` is the portable local ct-cli key. Its declaration may
map that key to a different, exact ChurchTools `referenceName` (#158), for
example `key: "stand_bewerbung"` plus `referenceName: "stand-bewerbung"`.
Ruleset resolution follows that mapping; it never treats `-` and `_` as the
same API identity.

This staged check matters more in a blueprint than in a hand-written flat config,
because the `${campus}_`-prefixed key is itself computed
(`` `${campus}_kids_lead` ``, not a literal string) — a copy-paste slip in
one branch of a blueprint (e.g. reusing `mainz`'s lead key inside the
`berlin` iteration) is exactly the kind of mistake this guard exists to
catch before any apply write. Locally declared wrong types fail offline; unknown
keys are checked against host-bound state and ChurchTools during plan.

## Full example

See [`examples/campus-blueprint.config.ts`](https://github.com/eqrm/ct-cli/blob/main/examples/campus-blueprint.config.ts)
for the complete, runnable config this doc describes: a `kidsArea(ct,
campus)` blueprint instantiated over two campuses (`mainz`, `berlin`),
each producing a lead group, three ministry-team groups (managed hierarchy
under the lead), and a dynamic "all members" auto-group — plus one
`groupTypeRole` permission grant shared across both campuses.
