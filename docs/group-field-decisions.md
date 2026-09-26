# Group field decisions (#21)

`ct-cli` manages the rights-bearing _structure_ of a group, not everything the
ChurchTools group object carries. This table records the deliberate decision for
each field seen on the live group / group `PATCH` body: **managed** (diffed and
applied like `name`), **opt-in synthetic** (its own DSL block + endpoint, not the
plain field bag), or **out of scope** (left to the CT admin UI, never touched).

Adding a _managed_ field is a real commitment — it needs a registry entry, a diff
test, an adopt round-trip, and a note on state-snapshot migration. So this issue
promotes exactly one new field (`campusId`) and triages the rest rather than
silently widening `managedFields`.

## Where the fields live

CT nests a group's structural ids under an `information` object on the live GET
body (`information.groupTypeId`, `information.groupStatusId`,
`information.campusId`), but accepts them as **top-level** keys on `PATCH`. The
registry mirrors this: it reads via `fromInformation(...)` (nested, with a
top-level fallback) and writes the field-agnostic way the executor writes every
field — a plain top-level key. `campusId` is wired the same deliberate way as
`groupTypeId`.

## Decision table

| Field                                                | Decision                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                               | **managed**                | Core identity; already managed.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `groupTypeId`                                        | **managed**                | Determines the group's kind and role template; already managed. **Changing it on an existing group is not a normal update:** ChurchTools rejects `groupTypeId` on the regular group update (`HTTP 400 groupTypeId: validation.always.invalid`) and requires `POST /groups/{id}/grouptype` with a role mapping. ct still plans it as a normal update, so the apply fails (#171). Until that is fixed, change a group's type in the ChurchTools UI and adopt the drift.       |
| `groupStatusId`                                      | **managed**                | Lifecycle status; already managed.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **`campusId`**                                       | **managed (new, #21)**     | The campus link is the tool's core "instantiate this area per campus" requirement. Numeric escape hatch only — an existing CT campus id (or `null` to clear). A _logical_ `campus: "key"` reference (resolving a same-run campus by key) is **deferred to [#20](https://github.com/eqrm/ct-cli/issues/20)**; the DSL rejects a `campus` field with a pointer to #20 so it can't slip through as an un-diffable phantom.                                                     |
| `parents` (hierarchy)                                | **opt-in synthetic**       | Group→group hierarchy is reconciled through its own endpoint, not the group body — see `src/engine/synthetic.ts`. Opt-in via `parents: [...]`.                                                                                                                                                                                                                                                                                                                              |
| `dynamic` (auto-group ruleset)                       | **opt-in synthetic**       | Ruleset + status live behind a dedicated endpoint (#14); opt-in via the `dynamic` block. See `docs/handbuch/dynamic-groups.md`.                                                                                                                                                                                                                                                                                                                                             |
| `allowDuplicateName` (CT's `force` create flag, #75) | **create-only, unmanaged** | Not a field on the live group at all — it's a request-only escape hatch for `POST /groups`' same-name guard (`forbidden.duplicate.group`). Opt-in per declaration; sent as `force: true` on CREATE only. Deliberately NOT a registry `managedFields` entry: it has no live value to diff against, so it is destructured out of the DSL input before the field bag (never triggers the unknown-field warning, never lands in state, never adopted, never touched on update). |
| `visibility`                                         | **out of scope**           | Not rights-bearing structure; instance-/policy-specific and easily changed in the UI. No demand in #21 to manage it. Promote later only with its own registry entry + tests.                                                                                                                                                                                                                                                                                                |
| `note`                                               | **out of scope**           | Free-text annotation, not structure. Managing it would fight human edits in the UI for no structural benefit.                                                                                                                                                                                                                                                                                                                                                               |
| `autoAccept` / open-for-members settings             | **out of scope**           | Membership-request policy — adjacent to _who is in a group_, which the tool never manages (`assertNotPeople`, `src/engine/guard.ts`). Left to the UI.                                                                                                                                                                                                                                                                                                                       |
| chat status                                          | **out of scope**           | Chat/messaging toggle, outside the structural mandate (README: "campuses, structural groups, hierarchies, group types/roles, permission & auto-groups").                                                                                                                                                                                                                                                                                                                    |
| sort key                                             | **out of scope**           | Presentation ordering, not structure. (Note: `sortKey` _is_ managed on the master-data types `age-group`/`target-group`, where ordering is the resource's point; on a group it is cosmetic.)                                                                                                                                                                                                                                                                                |

## State-snapshot migration

`campusId` is an **additive** managed field, so a group adopted before this issue
has a state snapshot that simply lacks the key. That produces **no phantom drift
and needs no migration**, because:

- the diff is **desired-driven** — `diffFields` only walks the config's fields, so
  a config that doesn't declare `campusId` never invents a change for it;
- drift is **snapshot-driven** — `driftFields` only walks the _old_ snapshot's
  keys, so a key absent there is never surfaced;
- the write body comes from the **fetched actual** ([#27](https://github.com/eqrm/ct-cli/issues/27)),
  so an unrelated field update never omits or reverts `campusId`, and the
  post-write snapshot self-heals to include it.

Contrast the `shortName → shorty` case (#17): a _renamed_ key lingers in the old
snapshot and drifts forever, so it needs an explicit `migrateState` rename. An
_added_ key cannot. See the comment on `migrateState` in `src/state/state.ts`.

**Re-adopt guidance:** to capture the campus of an already-managed group into
state immediately (rather than waiting for the next apply to self-heal the
snapshot), re-run `ct adopt group <id>` — `upsert` refreshes the snapshot in
place. This is optional; it does not change plan output.

## Assigning a group to a same-run campus

With numeric ids only, a group can be assigned to an **existing** campus by its
id today. Assigning a group to a campus **created in the same `ct apply`** is not
possible yet: the new campus's id is unknowable at config-eval time. That link
(`campus: "mainz_key"`) is the logical-reference resolver's job and lands with
[#20](https://github.com/eqrm/ct-cli/issues/20).
