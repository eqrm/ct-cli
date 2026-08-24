# Adoption contract (#141)

`ct adopt` turns something that exists in ChurchTools into portable config. The
question this document settles, once and for all resource types: **when a user
adopts one thing, what else comes with it?**

ChurchTools' API boundaries are not the boundaries users see. In the UI a group
is one thing; over REST it is `/groups/{id}`, plus `/groups/{id}/memberfields`,
plus `/groups/hierarchies`, plus `/dynamicgroups/{id}/ruleset`. Deciding the
grouping per resource type produced three different answers already (hierarchy:
not captured at all; dynamic ruleset: `--with-dynamic`; member fields: proposed
as `--with-member-fields` in [#135](https://github.com/eqrm/ct-cli/issues/135)).
This page replaces that with one resource-independent rule, so the next resource
type inherits the answer instead of re-arguing it.

Companion decisions: [`group-field-decisions.md`](group-field-decisions.md)
decides _which fields_ of a group are managed; this page decides _which records_
come along. [#143](https://github.com/eqrm/ct-cli/issues/143) decides how a
resource that this contract deliberately leaves unmanaged can still be
_resolved_ by a consumer stack.

## The five categories

Every record reachable from an adoption root falls into exactly one of five
categories. The category — not the resource type, not which endpoint it lives
behind — decides the behaviour.

| #   | Category                                                                               | Default                             | Switch                           | What lands where                                                     |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| 1   | **Root resource** — what the user selected                                             | **adopted**                         | none (it is the argument)        | config entry + state entry                                           |
| 2   | **Owned structural children** — non-person records whose lifecycle belongs to the root | **adopted**                         | `--no-<child>` to opt out        | nested in the root's config entry; identity scoped by the root's key |
| 3   | **Relationships** — edges between two managed structural objects                       | **adopted, both-ends-managed only** | `--no-<relationship>` to opt out | a synthetic set-field on the root (`parents: [...]`), by logical key |
| 4   | **Shared referenced resources** — reusable objects merely pointed at                   | **never adopted**                   | _no switch exists_               | a logical `ref` if already managed; otherwise a numeric id + `TODO`  |
| 5   | **Person-related data** — memberships, participants, registrations, attendance         | **never read, never managed**       | _no switch exists, ever_         | nothing                                                              |

Two of the five rows have no switch on purpose. Category 5 is
`CONTRIBUTING.md`'s permanent boundary, enforced by `assertNotPeople` on every
write path — a flag would imply it is a preference. Category 4 has no switch for
the reason argued in [Why category 4 has no opt-in](#why-category-4-has-no-opt-in).

### 1. Root resource

The object named on the command line, or produced by a bulk selector. It is
adopted: a state entry claims lifecycle ownership of that ChurchTools id, and a
config snippet is emitted.

A bulk selector produces **many roots, not one root plus children**.
`ct adopt group --children-of 42` walks the subtree and adopts every group in it
as a root of its own; the parent/child relation between them is category 3, not
category 2. This is already how the code behaves (`collectSubtreeIds` in
`src/commands/adopt-group.ts` returns a flat id list that the main loop treats
uniformly) and the contract keeps it: a group's lifecycle never belongs to
another group.

### 2. Owned structural children — adopted by default

A record is an **owned structural child** when all four hold:

1. it is not a person or a person's relationship to something;
2. it has no independent existence — deleting the root deletes it;
3. it is not referenceable from outside the root as a first-class object;
4. its identity is only unique within the root (its portable key must be scoped
   by the root's logical key, e.g. `ojbp_1_praktikum::wahl`).

Group member-field definitions (#135) satisfy all four:
`/groups/{groupId}/memberfields` is group-scoped in the path, two groups may
declare `wahl` independently, and nothing outside the group points at the field
definition by id.

**Decision: owned structural children are adopted by default.**

The argument is the same one that governs `plan`: an adoption that quietly omits
part of the object produces a blueprint that _looks_ complete and is not.
Replaying #135's `ojbp(ct, "26/27")` blueprint without the member-field
definitions creates groups whose dynamic ruleset writes into fields that do not
exist — and nothing in `plan` or `apply` reports it, because the config never
mentioned them. The cost of the default is extra reads per root (one collection
GET per child kind); the cost of the opt-in is a wrong blueprint that fails
months later on a different host. The tool consistently pays latency for
honesty, and adopt is a one-shot human-driven command, not a hot path.

The counter-argument — "the user asked for a group, not for twelve field
definitions" — is answered by output, not by omission: the summary names every
child adopted (see [Output](#output)), and `--no-<child>` / `--minimal` is one
flag away.

### 3. Relationships — adopted, but only when both ends are managed

A relationship is an edge between two structural objects: group→parent-group
hierarchy today, an event→resource booking later. An edge is not a resource; it
has no logical key and no state entry. It is captured as a **synthetic set-field
on the root**, which is exactly the seam `src/engine/synthetic.ts` already
provides (`parentsField`, `dynamicField`).

**Decision: relationships are captured by default, and an edge is emitted only
when both endpoints are managed** — already in state, or adopted by the same
run. An edge whose other end is unmanaged is **dropped and reported**, never
silently omitted and never a reason to adopt the other end (that would be
category 4 transitivity through the back door).

The both-ends rule is not a preference, it is forced by the engine. `plan`
already diffs `parents` only over _managed_ parents — `applyHierarchy` filters
through `managedParentKeys` in `src/engine/hierarchy.ts`. If adopt emitted an
edge to an unmanaged group, the desired side would carry a key the actual side
can never carry, and every subsequent `plan` would propose the same phantom
edge forever. Adopt must capture exactly what plan can diff, or the
adopt → plan → no-op round-trip breaks.

Note what changes: today adopt captures **no** hierarchy at all, so
`ct adopt group --children-of 42` emits a flat list of groups and loses the
shape the user pointed at. Under this contract the same command emits
`parents: ["<parent key>"]` on each child. This stays a no-op on the next
`plan` — the edges already exist live and both ends are managed by construction
in a subtree walk.

Opting out (`--no-hierarchy`) emits `parents: undefined`, i.e. hierarchy stays
unmanaged for those groups — which is the documented meaning of the field's
absence in `src/config/context.ts`, not a special adopt mode.

### 4. Shared referenced resources — never adopted

A referenced resource is one the root merely points at, and which some other
root may point at too: a campus on a group, a group id inside a dynamic
ruleset, a calendar or a bookable room on an event.

**Decision: a referenced resource is never adopted as a side effect of adopting
the thing that references it, at any depth, under any flag.** Adopting a
resource booking does not adopt the room.

What is emitted instead, in order of preference — all of it already
implemented:

- **already managed** → a portable logical reference. `ReverseResolver.sugarFields`
  rewrites `campusId` → `campus: "…"`; `portablizeRuleset` rewrites entity ids
  inside a captured ruleset into `ref` markers (default since #101).
- **not managed** → the host's numeric id plus a `TODO` in the emitted snippet
  (`configSnippet`'s `todos`), and a line in the summary marking it
  `unmanaged`. `--strict-rulesets` already turns that from a warning into a
  refusal for rulesets; the same escalation applies to any category-4 reference.

#### Why category 4 has no opt-in

A `--with-referenced` flag would look harmless and would be the single most
damaging flag in the tool. Adopting a reference means writing a state entry,
and a state entry is a **claim of lifecycle ownership**: from that point `plan`
may propose updates to it and `destroy` may delete it. Doing that to a
centrally-managed shared group because someone adopted a process that mentions
it is exactly the failure [#143](https://github.com/eqrm/ct-cli/issues/143) was
opened to prevent — and the damage is invisible until the day a second stack
claims the same resource, or a `destroy` in the wrong stack takes it out.

There are two supported remedies, and both make the ownership claim explicit:

1. `ct adopt <type> <id>` on the referenced object — a deliberate, separate,
   visible act of taking ownership;
2. once #143 lands, declaring it as an **external / read-only prerequisite** —
   resolvable in `ref` positions, never created, updated, deleted, or written.

Remedy 2 is the one this contract expects to become normal. Until it exists,
the numeric-id + `TODO` output is the honest interim: it says "this reference
is not portable yet" rather than pretending it is.

### 5. Person-related data — permanently excluded

Memberships, participants, registrations, attendance, and every other record
that ties a person to a structure are **never read and never managed**. This is
not a default, not a category with a switch, and not a gap to be filled by a
future issue. `assertNotPeople` guards every write path (`src/engine/guard.ts`),
`ct adopt grants` rejects person permission domains at argument-parse time, and
a PR adding a flag here will be declined regardless of quality.

The line is drawn at the record, not the endpoint: a group's member-**field
definitions** are schema (category 2, adopted); a group's member **rows** are
people (category 5, never touched). Same module, opposite sides of the boundary.

## Switch style

**Decision: negatable flags for what is on by default, `--with-*` for what is
off, and `--minimal` as the blanket opt-out.**

| Form                | Meaning                                                  | When to use it                             |
| ------------------- | -------------------------------------------------------- | ------------------------------------------ |
| `--no-<category>`   | drop a default-on category from this run                 | precedent: `--no-portable-rulesets` (#101) |
| `--with-<category>` | add a default-off category                               | precedent: `--with-dynamic` (#51)          |
| `--minimal`         | root resources only — every category except 1 is dropped | scripted/repeatable adoption               |

Rejected: `--with-*` for everything (it makes correctness opt-in and re-creates
the per-resource argument this document exists to end), and a single
`--depth`/`--recursive` knob (depth is not the user's mental model; "which parts
of the object" is).

`--minimal` is defined as **"root only"**, not as "everything currently off by
default". That distinction is what makes it forward-compatible: a script pinned
to `--minimal` keeps emitting exactly the root even after a future release
promotes a new category to default-on. Without that guarantee, every default
flip would be a breaking change for scripts.

Default-off categories exist only as a transition mechanism (see
[Backwards compatibility](#backwards-compatibility-promoting-an-opt-in-to-a-default)); the steady state is that
categories 2 and 3 are on and there is nothing to opt into.

## Recursion and cycles

Two different recursions get two different rules.

**Selection recursion is unbounded and cycle-guarded.** `--children-of` walks a
subtree to whatever depth it has, because the user asked for the subtree. A
cyclic hierarchy is a live-API bug, not a valid DAG; `collectSubtreeIds` already
carries a `visited` set that never re-descends into a seen id, with a test
pinning termination. Unchanged.

**Composition recursion is depth 1 and never transitive.** An owned structural
child (category 2) may not itself pull in owned children, relationships, or
references. If a real ChurchTools resource ever needs depth 2, that is a new
decision recorded here — not behaviour that emerges from a generic walker.

Cycles are therefore structurally impossible in composition (a depth-1 fan-out
cannot loop), and impossible in relationships (category 3 emits edges only
between roots the selection phase already deduplicated). The only place a cycle
can arise is selection, where it is already handled.

The tradeoff of the depth-1 rule is that a genuinely three-level composite would
need an explicit extension. That is deliberate: unbounded composition recursion
is how an adopt of one group turns into an unreviewable 400-line config and a
few hundred API calls, and how a category-4 reference sneaks in at depth 3 where
nobody is looking.

## Partial reads, permissions, unsupported endpoints

Three distinct failure meanings, three distinct behaviours. The governing
principle is `CONTRIBUTING.md`'s — a plan that under-reports a change is the
worst bug this tool can have — applied one step earlier: **a composite written
from a partial read is a wrong blueprint that looks complete.**

| Situation                                                            | HTTP shape                                           | Behaviour                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not applicable** — this root simply has no such child              | `404` on the child path for one root                 | **silently omit.** Absence is information. Already how `captureDynamic` treats a `404` from `/dynamicgroups/{id}/ruleset`: not a dynamic group, no block, no error. |
| **Unsupported endpoint** — this CT version does not have the feature | `404`/`501` on the child collection for _every_ root | **warn once per run, continue**, count as `unsupported` in the summary. A version-dependent gap must not make `adopt` unusable.                                     |
| **Denied or transient** — the data exists and could not be read      | `401`, `403`, `429`, `5xx`                           | **fail the run.** Non-zero exit, no config emitted, no state written.                                                                                               |
| **Selection failure** — a bulk selector's own walk fails             | any                                                  | **fail the run** (already the behaviour: a `/groups/{id}/children` 404 propagates rather than being treated as a leaf).                                             |

Failing on denied-or-transient is the answer to the issue's "fail, warn, or
continue-after-opt-out" question, and it is all three: the run fails, the error
names the category and the flag, and re-running with `--no-<category>` /
`--minimal` succeeds. The incompleteness then exists **because someone decided
it**, which is the whole difference between a documented boundary and a silent
data loss. The engine already draws this line on the plan side — #126's
`unreadable` seam exists precisely so a transient `429` degrades the plan
honestly instead of manufacturing a change — and adopt should not be laxer than
plan.

## Output

`adopt` reports in one fixed five-verb vocabulary, identical in normal and
`--dry-run` output (dry-run differs only in tense, and in writing nothing). The
shape follows `ct adopt grants --all-declarable`, which already refuses to let
"44 blocks" quietly mean "44 of 59".

| Verb         | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `adopted`    | now under management: config entry + state entry                        |
| `referenced` | emitted as a portable logical ref to something already managed          |
| `unmanaged`  | emitted as this host's numeric id + `TODO`; nobody manages it           |
| `skipped`    | in a default-on category, excluded by a flag or an unsupported endpoint |
| `excluded`   | person-related — never read                                             |

```text
$ ct adopt group --children-of ojbp_2026_27
4 adopted (4 group, 7 group member field) · 3 relationship(s) · 2 referenced · 1 unmanaged · 0 skipped
  unmanaged  campusId 3 — not adopted; emitted as a numeric id (see TODO in the snippet)
  dropped    ojbp_1_praktikum → parent #118 — parent is not managed; adopt it to manage this edge
  excluded   memberships, participants, registrations, attendance — never read, never managed
```

Two rules about that block:

- **`excluded` is a constant line, not a count.** Counting excluded records
  would mean reading them. It is printed unconditionally so the boundary is
  visible in every run rather than being invisible until someone reads this doc.
- **Nothing is summarised without being enumerable.** Every non-`adopted` line
  names the object and the remedy. A count with no list is how a partial result
  passes for a complete one.

## Backwards compatibility: promoting an opt-in to a default

This will happen at least twice (member fields, hierarchy), so it gets a policy
rather than a per-case judgement. The precedent is #101, which turned
`--portable-rulesets` from an opt-in into the default.

1. **The opt-in ships first** and is validated on a real instance before any
   flip is proposed.
2. **The old flag keeps working forever**, accepted as a no-op and marked
   deprecated in its help text — exactly as `--portable-rulesets` still is.
   Scripts do not break.
3. **The negation ships in the same release as the flip.** There is never a
   release in which a category is on by default and cannot be turned off.
4. **A flip is a `feat:`** (minor version), never a `fix:`, and never
   `BREAKING CHANGE:`.
5. **Release notes name the flip and its escape hatch.**

Point 4 needs its justification, because "it changes the default" sounds
breaking. It is not, and the reason is structural: **a default flip changes only
what `adopt` emits, never what `plan` and `apply` do to a config that already
exists.** The config file is the sole source of truth for what is managed —
`parents: undefined` means hierarchy is unmanaged, an absent `memberFields`
means member fields are unmanaged, and no adopt default can reach back and
change that. A config authored before a flip behaves identically after it. Only
the next _new_ adoption emits more, and that adoption's output says so.

The one thing a flip does change is the diff of a **re-adoption**
(`ct adopt group <id>` on an already-managed group refreshes its snapshot). That
is already a warned-about operation ("this resource was already managed — its
snapshot was refreshed") and is additive: new keys appear in the snapshot,
none are renamed. `group-field-decisions.md`'s state-migration analysis applies
unchanged — an _added_ key produces no phantom drift, because the diff is
desired-driven and drift is snapshot-driven.

## Worked example: group

`ct adopt group --children-of ojbp_2026_27`, against the #135 structure:

```text
OJBP 2026/27
├── OJBP 1. Praktikum 26/27      (member fields: wahl)
├── OJBP 2. Praktikum 26/27      (member fields: wahl)
└── OJBP 3. Praktikum 26/27      (member fields: wahl)
```

| Thing                                             | Category                                    | Outcome                                                                                                   |
| ------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| the four groups                                   | 1 root (bulk selection → four roots)        | **adopted** — four config entries, four state entries                                                     |
| `name`, `groupTypeId`, `groupStatusId`            | part of the root                            | **adopted** — `managedFields` in `src/resources/registry.ts`                                              |
| campus assignment                                 | 4 reference                                 | **referenced** as `campus: "<key>"` if the campus is managed; else numeric + `TODO`                       |
| group member-field definitions (#135)             | 2 owned child                               | **adopted**, keyed `<group key>::<field key>`, no host field ids                                          |
| parent→child hierarchy edges                      | 3 relationship                              | **adopted** as `parents: ["ojbp_2026_27"]` — both ends managed by construction                            |
| a parent _outside_ the selected subtree           | 3, one end unmanaged                        | **dropped and reported**; the outside group is _not_ adopted                                              |
| dynamic ruleset + status                          | 2 owned child                               | **adopted** (today: `--with-dynamic`; see follow-ups), ruleset portablized                                |
| group ids _inside_ that ruleset                   | 4 reference                                 | **referenced** via `ref` markers if managed; else numeric + warning, or refusal under `--strict-rulesets` |
| `visibility`, `note`, `autoAccept`, chat, sortKey | out of scope per `group-field-decisions.md` | **not emitted** — deliberately unmanaged UI properties                                                    |
| memberships, member rows                          | 5                                           | **excluded** — never read                                                                                 |

The point of the table: `--children-of` currently gets rows 1, 2, 5 and 8 right
and loses rows 4 and 6 — the shape and the fields. That is the concrete gap this
contract closes.

## Worked example: event

Events are **not** an adoptable type today, and nothing here commits to making
them one — `docs/runbook-manual-surface.md` places calendars, services and
resource booking outside the tool's stated mandate. The example exists to show
the contract answers the question **before** the code is written, which is the
entire point of #141.

| Thing                                             | Category       | Outcome                                                                                                                    |
| ------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| core event properties                             | 1 root         | **adopted**                                                                                                                |
| registration-group definitions owned by the event | 2 owned child  | **adopted** — event-scoped identity, no host ids                                                                           |
| resource **bookings** attached to the event       | 3 relationship | **adopted** as a synthetic set-field, _only if the booked resource is already managed_; otherwise dropped and reported     |
| the bookable **resource** (room, beamer)          | 4 reference    | **never adopted.** A booking does not confer ownership of the room — the room is shared across every event in the instance |
| the **calendar** the event sits in                | 4 reference    | **never adopted** — same argument                                                                                          |
| the event's template / series parent              | 4 reference    | **never adopted** — an independently-existing object                                                                       |
| participants, registrations, attendance           | 5              | **excluded** — never read                                                                                                  |

Row 3 vs. row 4 is the distinction the issue asked for, and it falls straight
out of the categories: the _booking_ has no life without the event (an edge
between two structural objects, category 3), while the _room_ has a life
entirely without it (category 4). No new judgement was needed.

## Follow-up implementation work

This issue decides only. The work the contract implies, roughly in order:

1. **A shared adoption-scope module** (`src/commands/adopt-scope.ts` or
   similar) owning the flag surface (`--minimal`, `--no-*`, `--with-*`), the
   five-verb tally, and the failure classification from
   [Partial reads](#partial-reads-permissions-unsupported-endpoints). Both
   `adopt.ts` and `adopt-group.ts` consume it; neither re-implements it.
2. **A composite descriptor on `AdoptableResource`** in
   `src/resources/registry.ts` — each type declares its owned children (category 2) and its relationships (category 3) so adoption is table-driven, matching
   how `SYNTHETIC_FIELDS` already makes `parents`/`dynamic` table-driven on the
   plan side. Adding a resource type must not mean adding a branch to a command.
3. **Hierarchy capture in adopt** (category 3): emit `parents` filtered through
   the same managed-only rule as `applyHierarchy`, with the dropped-edge report.
   Needs a test pinning that `--children-of` → paste → `plan` is a no-op _with_
   the edges, the round-trip test `adopt-group-command.test.ts` already has for
   the flat case.
4. **Promote `--with-dynamic` to default-on** with `--no-dynamic`, under the
   [backwards-compatibility policy](#backwards-compatibility-promoting-an-opt-in-to-a-default).
   A dynamic group adopted without its ruleset is the same wrong blueprint as
   one adopted without its member fields.
5. **The five-verb summary** replacing today's per-command ad-hoc output, and a
   test pinning the rendered summary (the same discipline `plan` output has).
6. **External/read-only references** — [#143](https://github.com/eqrm/ct-cli/issues/143).
   Until it lands, category 4 falls back to numeric id + `TODO`; after it lands,
   the emitted form for an unmanaged reference should become an external
   declaration, which is what makes category 4's "no opt-in" rule comfortable
   rather than merely correct.

### How #135 applies this contract

#135 is in flight and this contract does not block or change it. It should ship
**exactly as specified — opt-in `--with-member-fields`** — and additionally:

- treat group member fields as a **category-2 owned structural child**: identity
  scoped as `<group key>::<field key>`, no host-specific field ids in emitted
  config, member **rows** never read (category 5);
- link to this document from the PR, and state in the flag's help text that the
  opt-in is a transitional default (contract item 2 above), so nobody reads the
  flag as a permanent statement that member fields are optional;
- **not** adopt anything a member-field definition references (option lists,
  security levels) — category 4, no transitivity;
- keep its "never delete a field merely because it disappeared from config"
  guardrail, which is orthogonal to this contract and stays.

The flip of `--with-member-fields` to default-on is a **separate follow-up
issue**, gated on item 1 (the shared flag surface exists, so `--no-member-fields`
can ship in the same release) and on the policy above. Sequencing it that way is
what lets #135 land now without deciding the project-wide default on its own —
the outcome #141's acceptance criteria asked for.
