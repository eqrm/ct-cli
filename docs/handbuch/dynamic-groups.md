---
title: Dynamic groups (auto-groups)
sources:
  - src/config/query.ts
  - src/config/query-refs.ts
  - src/engine/dynamic.ts
  - src/engine/synthetic.ts
  - src/application/operations/adopt-group.ts
sources_hash: e38b8c0f6032d5cc
reviewed: 2026-08-28
---

# Auto-groups (dynamic groups)

ChurchTools "dynamic groups" (aka auto-groups) compute their membership from a
saved query ("ruleset") instead of manual add/remove. `ct-cli` manages a
group's dynamic-group configuration — the ruleset and its status — as an
opt-in extra on `ct.group(...)`, diffed and applied exactly like any other
managed field.

> People are still never touched. `ct-cli` writes the _ruleset that computes_
> membership, never a person↔group relationship directly.

## The `dynamic` block

```ts
ct.group({
  key: "all_mainz",
  name: "Alle Mainz",
  groupTypeId: 1,
  dynamic: {
    status: "manual", // "active" | "manual" | "inactive" | "none"
    ruleset: {/* RuleSet object | { ref: "./x.json" } | churchQuery(...) build */},
  },
});
```

`dynamic` is **opt-in** and only valid on `ct.group(...)` — declaring it on
any other resource type throws at config-load time. Omitting it entirely
(`undefined`) means "not a dynamic group", mirroring how `parents` works for
group hierarchy. Validation lives in `src/config/context.ts` (`toDesired`).

### `status`

- `active` — ChurchTools recomputes membership automatically.
- `manual` — the ruleset is stored, but membership is only recomputed when
  explicitly triggered (`ct apply --refresh`, or manually in the ChurchTools
  UI).
- `inactive` — the ruleset is stored but paused.
- `none` — demotes the group back to an ordinary (non-dynamic) group. Keep
  the `dynamic` block (the DSL still requires a `ruleset` object — `{}` is
  fine, since its content is irrelevant on demote) and set
  `status: "none"`. `ct apply` responds with `DELETE
/dynamicgroups/{id}/ruleset` followed by `PUT /dynamicgroups/{id}/status`
  with `{ dynamicGroupStatus: "none" }`.

Statuses are validated against exactly `["active", "inactive", "manual",
"none"]` in `src/config/context.ts`.

### Ordering: the group must exist first

A group must exist before it can carry a ruleset. You never have to sequence
this yourself: `dynamic` is a synthetic field on `group` (like `parents`),
not a separate resource with its own tier in `TYPE_TIER`
(`src/engine/graph.ts`). Its ruleset/status writes happen inline, as part of
the group's own tier-1 apply, after the group itself has been
created/updated — so `ct apply` always writes against the group's real
(possibly just-created) id.

That holds on the very first run too, including when the group being made
dynamic is created by that same run and is the _only_ dynamic group in the
config (fixed alongside #135): the desired `dynamic` block is folded whenever
any group declares one, not only when there is already an adopted dynamic group
to read.

The group's own synthetic fields are written **in declaration order**, and that
order is fixed by the synthetic-field registry in `src/engine/synthetic.ts`:
hierarchy `parents`, then `memberField:*`, then `dynamic`. So a group's
[member fields](group-member-fields.md) are created before the ruleset that may
reference them.

### Referencing a group member field portably (#135)

A ruleset that names one of a group's member fields must not carry that host's
numeric field id — it is not portable, and ChurchTools validates none of the ids
inside a ruleset, so the wrong id applies cleanly and silently computes the
wrong membership. Use the group-scoped reference instead:

```ts
ref.groupMemberField("ojbp_2026_27_praktikum_1", "stand_bewerbung");
```

The second argument is the portable local ct-cli key, not ChurchTools' API
identity. Its field declaration may map it explicitly to an exact
`referenceName`, for example `key: "stand_bewerbung"` and
`referenceName: "stand-bewerbung"`. The resolver uses that declaration to find
the host's numeric id from `GET /groups/{groupId}/memberfields`; the live
`referenceName` is compared byte-for-byte, so `stand-bewerbung` and
`stand_bewerbung` are not interchangeable (#158).

A field this config declares but that does not exist on the host yet resolves
to a pending marker and is completed during apply, right after the create that
minted it. A reference to a field the target group does not declare fails at
config-eval time, before any network call. Local keys are compared in their
normalised form, so `"Stand Bewerbung"` finds a declaration keyed
`stand_bewerbung`; that normalization never changes the declaration's exact API
`referenceName`. See
[Group member fields](group-member-fields.md).

## Supplying a ruleset — three ways

1. **Inline `RuleSet` object literal** — write the object by hand (e.g.
   copy-pasted from `ct get raw /dynamicgroups/{id}/ruleset` and trimmed).
2. **`{ ref: "./relative/path.json" }`** — a file reference. Resolved
   relative to the process CWD at fold time by `resolveRulesetRef`
   (`src/engine/dynamic.ts`); the referenced file's JSON contents are used
   verbatim as the ruleset. Handy for pasting an exported ruleset without
   inlining a huge JSONLogic tree into the `.ts` config. A captured file
   embeds that instance's numeric ids — see [Portable snapshot files across
   environments](#portable-snapshot-files-across-environments-76) to make it
   drive dev and prod from one file.
3. **Typed query builder** — build the JSONLogic filter with `q` and wrap it
   with `churchQuery` (`src/config/query.ts`, re-exported from
   `src/config/context.ts`).

All three ultimately produce a plain JS object with the same shape; which one
you pick is purely a matter of how you want to author/version it.

### Portable snapshot files across environments (#76)

A ruleset **captured from a live instance** — `ct adopt group --with-dynamic`, or
a hand-exported `{ ref: "./rulesets/<key>.json" }` file — is byte-faithful by
design: the query filters embed _that instance's_ numeric ids (e.g.
`ctgroup.id ∈ [148, 1228, 32]`, `role.id ∈ [16, 84]`). Those ids are
**instance-specific**. Point the same file at another environment and CT accepts
it, but the ids resolve to different or nonexistent entities there, so the
auto-group computes the wrong (usually empty) membership. This is the one place a
snapshot is _not_ portable — everything else in the config is logical-ref
portable (#20/#22).

To make a snapshot portable, replace an **entity id in a query `var` position**
with a logical reference. The resolver rewrites references anywhere inside the
ruleset to the per-host id at plan time, and the resolved form still
normalizes/diffs **byte-faithfully** against CT (so a matching instance stays a
no-op — it does not re-`PUT` on every apply). Two equivalent ways to author it:

- **Re-author with the typed builder** (preferred for readability):
  `churchQuery(q.oneof("ctgroup.id", [ref.group("jugend-mainz"), ref.group("jugend-berlin")]))`.
- **Edit the JSON file in place** — a reference serialises to a plain,
  hand-editable JSON leaf, so in a captured `rulesets/<key>.json` you can swap a
  raw id for a marker directly:

  ```jsonc
  // before (prod-specific, not portable):
  { "==": [{ "var": "ctgroup.campusId" }, 148] }
  // after (portable — resolves to each host's Mainz campus id at plan time):
  { "==": [{ "var": "ctgroup.campusId" }, { "__ctRef": true, "kind": "campus", "key": "mainz" }] }
  ```

  Simple marker `kind`s carry a single `key` (the logical key / slug):
  `campus`, `group`, `group-type`. A **role** (`role.id`) uses the compound
  `group-type-role` marker instead — `{ "__ctRef": true, "kind":
"group-type-role", "groupType": "<group-type-key>", "role": "<role-name>" }` —
  because a ruleset's `role.id` is a **groupTypeRoleId** (a role scoped to a
  group type), and role names are not globally unique (see the table note
  below). See `ref` in `src/resolve/refs.ts`.

**Escape hatch — raw numeric ids pass through untouched.** A query that
references an _operational_ group outside the managed scaffold (no logical key to
resolve against) can keep the plain number; you then own its per-environment
correctness. This mirrors the permission scope escape hatch (#49): prefer a
reference, fall back to a number where no managed key exists.

#### Auto-rewrite on capture (default since #101; was `--portable-rulesets`, #76)

Rather than hand-editing markers into a freshly captured file, adopt does it:

```sh
ct adopt group <id> --with-dynamic                          # portablized (the default)
ct adopt group <id> --with-dynamic --no-portable-rulesets   # verbatim, this host's ids
```

`--with-member-fields` is the sibling opt-in for a group's own
[member-field definitions](group-member-fields.md); combine the two to capture a
whole structure — group, fields, ruleset — in one pass.

> **A re-adopt refreshes the snapshot, not the key (#123).** Re-running this over
> a list of ids is the documented way to refresh rulesets once their scope
> targets become managed — and it is the one mode where `-k` is rejected ("only
> valid when exactly one group is resolved"). Any resource whose adopted key
> differed from the derived key therefore used to be **silently re-keyed** by a
> routine refresh, so the config's declaration matched nothing in state and the
> next plan read as "one to create, one to destroy" for a resource that was fine
> and untouched. An already-managed resource now keeps its key, and says what it
> would have become:
>
> ```text
> ! merkmal_alle_2_5_mz: key would change to "alle_2_bis_5_mz" (derived from the live name).
>   Keeping the adopted key. Pass --rekey to change it.
> ```
>
> Because the ruleset filename follows the key, this also means the refresh
> overwrites `rulesets/merkmal_alle_2_5_mz.json` — the file the config already
> points at — instead of writing a second one beside it.

`ct adopt group --with-dynamic` runs the captured (normalized)
ruleset through `portablizeRuleset` (`src/config/query-refs.ts`) before writing
`rulesets/<key>.json`: every numeric id sitting in a known ChurchQuery `var`
position that maps to a **managed** logical key is rewritten to its `{ __ctRef }`
marker; every other id is left numeric. The `var → RefKind` catalog it keys off
(`VAR_REF_KINDS`) is:

| ChurchQuery `var`     | marker `kind`     | source catalog / state                             |
| --------------------- | ----------------- | -------------------------------------------------- |
| `ctgroup.id`          | `group`           | managed state (no REST catalog)                    |
| `ctgroup.campusId`    | `campus`          | `/campuses`                                        |
| `person.campusId`     | `campus`          | `/campuses`                                        |
| `ctgroup.groupTypeId` | `group-type`      | `/group/grouptypes`                                |
| `role.id`             | `group-type-role` | `/group/roles` (by `groupTypeId` + name)           |
| `role.id`             | `role-def`        | managed state — only when the pair collides (#125) |

The same `group-type-role` rewrite also covers the **out-of-query** integer
field `process.*.handleMembership.groupTypeRoleId` (the target role a
query-result membership is granted with) — it is a groupTypeRoleId too, just not
inside the query.

`role.id` maps to **`group-type-role`**, a compound **(group-type,
role-name)** marker — _not_ `role-def` (a bare `/group/roles` name lookup) and
_not_ `group-role` (a group-instance permission domain). A ruleset's `role.id`
is a **groupTypeRoleId**: a role scoped to a group **type**. Role names are
**not globally unique** across group types — live-verified on prod
(2026-07-11, `/api/group/roles`, 46 roles): **3** roles named "Leiter", **6**
"Organisator", **6** "Mitglied", each on a different group type. So a bare name
(`role-def`) is genuinely ambiguous and the resolver throws. Only the
**(groupTypeId, name) pair is unique** (0 collisions across all 46 roles), so the
marker carries the group-type key + role name, and the resolver picks the one
`/group/roles` row whose `groupTypeId` matches this host's group type and whose
name slugs to the role. This corrects the earlier `role-def` mapping (#86),
which read the role catalog by bare name and was unresolvable on the real
instance.

##### When the pair collides too — adopt the role (#125)

"Unique in practice" is not "unique". Two rows **can** share a name on one group
type, and then the pair is a hard error:

```text
✗ Ambiguous group-type-role(groupType=community, role=leader) referenced at group "4_teamactive":
  2 roles on group type #30 match — "leader" (#87), "leader" (#207).
```

Neither obvious remedy works for a config shared across hosts. _Renaming_
means editing ChurchTools master data to work around a config limitation — and
in the observed case one of the two rows is CT's own stock `leader`. _Passing a
numeric id_ cannot work at all: the roles have **different ids per host**
(`#127` on one, `#207` on the other), and `ConfigContext` deliberately exposes
no env or host, so there is nowhere to branch.

The fix is the same "adopt the target to portablize it" move that already works
for groups, campuses and departments — **adopt the role**, under the same
logical key on every host:

```bash
ct adopt group-role 127 --env prod -k community_leader
ct adopt group-role 207 --env dev  -k community_leader
```

Capture then emits the managed form, which this host resolves from state rather
than from a name lookup:

```json
{ "__ctRef": true, "kind": "role-def", "key": "community_leader" }
```

**Only when the pair actually collides, though.** The `(groupType, role)` pair
stays the default for every role whose pair is unique — even one the config
owns. Off this host `role-def` is the **weaker** reference of the two: the
resolver falls back to `resolveFromCatalog`, which keys `/group/roles` by
`slug(name)` **alone**. On a host where the role was never adopted under the
shared key, a name matching exactly one row therefore resolves _silently_ to a
role on a different group type (only a multi-row match errors) — the same bare
name lookup that #76 reverted #86 for. The pair cannot fail that way, because it
matches on `(groupTypeId, name)`. So the safe reference is never traded away for
the weaker one; `role-def` is reserved for the ids the pair genuinely cannot
name, where there is no safe reference to lose.

#### What could not be portablized is REPORTED, never swallowed (#101)

Portablization only rewrites references to targets it can resolve. Anything
pointing at an unmanaged target keeps its raw numeric id — the escape hatch —
and that is the dangerous half, because **ChurchTools treats a ruleset as opaque
JSON and does not validate the ids inside it.** A ruleset carrying prod's
`ctgroup.id` applied to dev does not error: the auto-group simply collects the
wrong people, or nobody, and `ct plan` stays green because the ruleset
round-trips byte-identically against the host it was written for. That is
materially worse than a wrong permission scope, because an auto-group's payload
IS group membership — which is what carries grants.

So every id left numeric is named, with its reason, **both at capture and at
plan time**.

At **capture** time (`ct adopt … --with-dynamic`) the state file and the
`/group/roles` catalog are both in hand, so the reason is a checked fact:

```text
! rulesets/jugend.json keeps 5 host-specific id(s) — NOT portable to another host:
    ctgroup.id: 1246 left numeric — not under management — `ct adopt group <id>` for each (then re-adopt) makes them portable
    ctgroup.groupStatusId: 1, 2 left numeric — group statuses have no REST catalog (#67) — no logical form exists
    person.id: 5703, 4389 left numeric — person ids are NEVER portable — ct does not manage people, so this ruleset names DIFFERENT people on another host. Remove the clause or accept the divergence
```

##### `person.id` is reported, and it is not fixable (#127)

A ruleset that includes or excludes specific people by id is common — four of
five auto-groups captured in one week did it:

```json
{ "oneof": [{ "var": "person.id" }, [5703, 4389]] }
{ "!": [{ "oneof": [{ "var": "person.id" }, [12, 1]] }] }
```

Those are the source host's person ids written verbatim into the other host's
ruleset, where they name entirely different people — the same failure mode as a
raw `ctgroup.id`. `person.id 1` is the unluckiest case: it exists on every
ChurchTools instance and is almost always an administrator, so an exclusion
aimed at one person on the source host lands on someone real on the target host
rather than harmlessly matching nothing.

Unlike every other entry in the report, this one is **not fixable in config**,
and the wording says so rather than offering a command. `ct` correctly does not
manage people, so there is no person catalog to resolve against and no
`__ctRef` kind that could express it. The ask is only that the tool say so:
before #127 it was silent, and the absence of a warning actively implied there
was nothing to find.

At **plan** time the same scan runs over every declared dynamic group, but with
no state, no catalogs and no network — it can prove that an id sits in an entity
position and nothing more. So it says exactly that, rather than asserting a
reason it never checked:

```text
! dynamic group "jugend": ruleset carries 1 host-specific id(s) — not portable to another instance:
    ctgroup.id: 1246 left numeric — host-specific id(s) frozen into a cross-host ruleset — re-adopt the group with `--with-dynamic` to rewrite them into logical references (it reports what, if anything, blocks each)
```

The capture-time reasons are distinct because the fixes are: an **unmanaged**
target (adopt it), a **role unknown to `/group/roles`**, a role whose **group
type is unmanaged**, or a dimension with **no logical form at all**
(`ctgroup.groupStatusId` — group statuses have no REST catalog, #67; this one
needs no lookup, so the plan-time scan reports it too).

**`--strict-rulesets`** turns the warning into a refusal: adopt writes nothing
if the ruleset would still contain a host-specific id. Use it in a repo that has
decided every ruleset must be portable.

> **Caveat when using `--no-portable-rulesets`:** applying a raw-id prod
> snapshot to a _different_ environment is mechanically fine (CT accepts it;
> unknown ids → empty matches) but **semantically wrong** for that environment's
> memberships. Adopt says so once per file; treat it as a known, documented gap —
> not a silent one — when rehearsing prod configs against dev.

### The `RuleSet` shape

Real ChurchTools rulesets (captured from `GET /dynamicgroups/{id}/ruleset` —
see `tests/fixtures/dynamic/README.md`) look like:

```jsonc
{
  "description": "Alle aktiven Personen in Mainz", // human label — lives HERE, not inside `query`
  "shorty": "Autom. Mitgliedschaft Alle Mainz",
  "personIdFieldName": "person.id",
  "importance": 0,
  "query": { "method": "ChurchQuery", "params": { "...": "..." } },
  "process": {},
}
```

`description` and `shorty` are fields **on the ruleset object itself** — a
sibling of `query`, not an argument to `churchQuery(...)`.

### Typed query builder (`q` / `churchQuery`)

`q` (`src/config/query.ts`) emits a JSONLogic tree:

| helper                     | emits                                   |
| -------------------------- | --------------------------------------- |
| `q.and(...nodes)`          | `{ and: nodes }`                        |
| `q.or(...nodes)`           | `{ or: nodes }`                         |
| `q.not(node)`              | `{ "!": [node] }`                       |
| `q.var(name)`              | `{ var: name }`                         |
| `q.eq(varName, value)`     | `{ "==": [{ var: varName }, value] }`   |
| `q.oneof(varName, values)` | `{ oneof: [{ var: varName }, values] }` |
| `q.isnull(varName)`        | `{ isnull: [{ var: varName }] }`        |

`var` values may be **logical references** or **raw ids**. Prefer a reference so
the ruleset is portable across hosts (#20): `q.eq("ctgroup.campusId",
ref.campus("mainz"))` — the per-host resolver fills in that instance's campus id
at plan time (and, for a campus created in the same run, at apply time). `ref` is
re-exported from `src/config/context.js` alongside `q`/`churchQuery`. The numeric
escape hatch still works — pass a plain number to target one instance's id
directly. References resolve deep inside the ruleset, so any `var` value works.

`churchQuery(filter, opts?)` wraps a JSONLogic filter tree in the same
envelope shape ChurchTools itself returns:

```ts
{
  method: "ChurchQuery",
  params: {
    groupBy: opts.groupBy ?? ["person.id"],
    filter,
    primaryEntityAlias: opts.primaryEntityAlias ?? "person",
    responseFields: opts.responseFields ?? ["person.id", "person.firstName", "person.lastName"],
  },
}
```

**`churchQuery` does not take a `description` argument** — pass `description`
as a field on the ruleset object instead (see the shape above). `opts` only
covers `primaryEntityAlias` / `responseFields` / `groupBy`, for a query keyed
on something other than `person.id`.

```ts
import { q, churchQuery, ref } from "../src/config/context.js";

const ruleset = {
  description: "Alle aktiven Personen in Mainz",
  shorty: "Autom. Mitgliedschaft Alle Mainz",
  importance: 0,
  personIdFieldName: "person.id",
  process: {},
  // campus BY NAME — resolved to the per-host id at plan time (numeric ids still work too).
  query: churchQuery(q.and(q.eq("ctgroup.campusId", ref.campus("mainz")), q.eq("person.isArchived", false))),
};
```

## Drift, normalization, and no-op re-applies

ChurchTools' stored rulesets carry cosmetic noise that would otherwise show
up as permanent phantom diffs on every `ct plan`:

- **`dterm: [label, expr]` wrappers** — a cosmetic UI label around a
  subtree. Never evaluated by ChurchTools; stripped down to `expr`.
- **int/string inconsistency** — the same logical id shows up as both `1`
  and `"1"` across (and even within) a single ruleset. Numeric-looking
  strings inside the `query` subtree are coerced to numbers.
- **read-only fields** (`dynamicGroupUpdateStarted`,
  `dynamicGroupUpdateFinished`) and the transport envelopes — `GET` returns a
  single-element `[RuleSet]` array; `PUT` takes `{ dynamicGroupRuleSet: [RuleSet] }`
  (live-decoded, #77; see `putRulesetBody` in `src/engine/dynamic.ts`) — are
  unwrapped/dropped before comparison.

Both the desired side (your config) and the actual side (fetched from
ChurchTools) are run through the same `normalizeRuleset`
(`src/engine/dynamic.ts`) before diffing. That means: declare a ruleset,
`ct apply` it, then `ct plan` again — no drift, only real content changes
produce a diff. Normalization is scoped to the `query` subtree only; it's
never applied to ruleset-level string fields like `description`/`shorty`, so
a numeric-looking label (e.g. a `description` of `"2024"`) is never silently
retyped to a number and corrupted on write-back.

**Pinned assumption (#36):** the no-op-plan property above relies on every
RuleSet-level field OTHER than `query` (`description`, `shorty`, `importance`,
`personIdFieldName`, `process`) round-tripping through ChurchTools
byte-for-byte on `PUT`/`GET` — `normalizeRuleset` does not canonicalize them.
This is pinned by a live-gated test in `tests/dynamic.integration.test.ts`
(see `tests/fixtures/dynamic/README.md` for how to run it and what to do if
it fails); it is skipped by default and requires an explicit opt-in against a
dev instance.

## Managed guard: undeclared groups stay invisible

Dynamic-group state is only ever fetched for a group that is **both**: (a)
already under state management, and (b) opted in via a `dynamic` block in
the _current_ config (`dynamicField.fold` in `src/engine/synthetic.ts`). A
managed group without a `dynamic` block is never queried for its
ruleset/status — any auto-group configuration it happens to have in
ChurchTools stays completely invisible to `ct plan` / `ct apply`, exactly
like any other resource this tool doesn't manage.

## When the ruleset cannot be read (#126)

A group's ruleset and status are read as a **sub-resource**, separately from the
group's own `GET`. If that read fails for any reason other than a 404 — a 429
under rate limiting is the common one — `ct` does **not** fold the declared
ruleset into the diff on its own. Folding only the desired side would diff a
declared ruleset against an absent actual and report the group as `to update`,
manufacturing a change out of a transient failure.

Instead the group is marked `fetch-failed`: it renders as a no-op under
_"Fetch failed (could not read from ChurchTools — diff unavailable, left
untouched)"_, the summary line carries
`INCOMPLETE — N resource(s) could not be read.`, `ct plan` exits `1`, and
`ct apply` refuses to run at all. A 404 on the ruleset keeps its old meaning —
"this group is not a dynamic group" — and is not a failure.

The distinction is the point: **"I could not read the current state of X" and
"X differs from config" are different facts, and only the second belongs in a
diff.** A plan is the artefact a human approves, so a fabricated `to update` in
a PR comment is indistinguishable from a real drift and invites the same
response.

## Applying and refreshing membership

`ct apply` writes the ruleset (`PUT /dynamicgroups/{id}/ruleset`) and status
(`PUT /dynamicgroups/{id}/status`) as part of the same run as everything
else — but this does **not** recompute membership. Recomputation happens on
ChurchTools' own schedule for `active` groups, or must be explicitly
triggered.

Pass `--refresh` to `ct apply` to opt in to a post-apply refresh: it POSTs
`/dynamicgroups/{id}/refresh` for each dynamic group whose `dynamic` field
actually changed in this run.

```bash
ct apply --refresh
```

This is deliberately **per-group only** — the all-groups
`/dynamicgroups/refresh` endpoint has a huge blast radius and is never called
from here. A change to one group's ruleset never triggers a recompute of every
dynamic group in the instance.

### `ct refresh` — re-evaluate a group that did NOT change (#105)

`ct apply --refresh` only covers groups changed in that run, so it cannot
re-evaluate an existing group and does nothing at all on a no-op plan. That
leaves no lever for the most common confusion of all: **a freshly created
auto-group is legitimately empty after a green apply**, because ChurchTools
materializes membership on its own schedule. `ct apply` now says so in its
output rather than leaving you to guess whether the ruleset is wrong.

```bash
ct refresh --env prod --group jugend   # one managed dynamic group
ct refresh --env prod --all            # every managed dynamic group
```

`--all` is required to fan out — refreshing recomputes membership, so it is
never the default. `ct refresh` only ever touches **managed** groups, refuses a
group that has no ruleset on this host (rather than POSTing into a 404), and
keeps going after a per-group failure (exiting non-zero).

> **Fixed in #124.** "Which groups are dynamic on this host?" is answered by
> `GET /dynamicgroups`, which returns a flat array of **bare group ids**
> (`[159, 1698, …]`) — not objects. Both readers parsed it as
> `Number(row.id ?? row.groupId)`, i.e. `NaN` for every element, so the id set
> came out empty on every host: `ct refresh` answered "not a dynamic group" for
> every group and could not succeed at all, and `ct coverage` reported
> `dynamic: 0` on an instance with 70 auto-groups (#113 — the same bug read a
> second time). There is now one parser for that endpoint
> (`src/api/dynamicGroups.ts`) with a test pinning the scalar shape.

> **The scheduler ping is NOT fired by `ct`.** ChurchTools' admin cron page hits
> `GET https://<host>/?q=cron&standby=true`, which runs **every due scheduled
> job on the instance** — far beyond auto-groups. It is documented in
> [`docs/runbook-manual-surface.md`](https://github.com/eqrm/ct-cli/blob/main/docs/runbook-manual-surface.md) as a manual
> escape hatch; `ct` deliberately never calls it.

## Full example

See [`examples/dynamic-group.config.ts`](https://github.com/eqrm/ct-cli/blob/main/examples/dynamic-group.config.ts)
for a runnable config declaring a campus and a dynamic group built with the
typed query DSL.
