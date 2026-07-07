# Phase 4 — Apply (idempotent CRUD) + `destroy` + guardrails

Design doc for GitHub issue #6. Depends on the Phase 3 declarative engine
(config → `computePlan` → ordered `Plan`). Makes the plan real, safely.

## Goal

Execute a computed plan against ChurchTools:

- `ct apply` — idempotent **create + update** in dependency order; re-running a
  clean plan is a no-op.
- `ct destroy --target …` — explicit-only deletion, with destroy-protection;
  never implicit deletions.

Plus the Phase 4 guardrails: confirmation, automatic backup, a hard "people are
never touched" boundary, rate-limit/retry on writes, and state persisted after
each successful action (crash-safe / resumable).

## Decisions (locked)

1. **`apply` never deletes.** It executes creates + updates only. A resource
   dropped from config surfaces as a notice ("run `ct destroy --target <key>`"),
   never an automatic deletion. Deletion is exclusively `destroy`'s job. This is
   the deliberate divergence from Terraform demanded by the "never implicit
   deletions" guardrail.
2. **Destroy-protection = a config `preventDestroy` lifecycle flag** plus a typed
   confirmation. A targeted destroy of a flagged resource hard-fails until the
   flag (or the whole declaration) is removed from config.
3. **Backup = a JSON snapshot** of the current *actual* ChurchTools values of all
   managed resources, written to `backups/ct-backup-<ISO-timestamp>.json` beside
   the state file, before any write. Directory overridable via `--backup-dir` /
   `CT_BACKUP_DIR`.
4. **Type scope = all writable types.** `campus`, `group`, `group-type` (already
   in the registry) plus `age-group`, `target-group`, `relationship-type`,
   `group-role`, and group **hierarchy** edges. Their managed-field sets are
   provisional and will be live-verified during implementation.

## Command surface

### `ct apply`

1. Load config + state (host guard, as `plan` does).
2. `buildPlan` — fetch actual, fold hierarchy, `computePlan` (shared with `plan`).
3. If any fetch failed → **abort** (acting on an incomplete picture is unsafe).
4. Render the plan. If there are no creates/updates → report "no changes" and
   exit 0 (deletes-only plans print the destroy notice and still exit 0).
5. Surface any `delete` items as a notice: they will **not** be applied.
6. Confirm: `Apply N changes? [y/N]` (skipped by `-y/--auto-approve`; non-TTY
   without `-y` aborts).
7. Write a backup of `actual`.
8. Execute creates + updates in dependency order, saving state after each.
9. On the first write error: stop, print what succeeded, exit 1 (state is
   already persisted up to that point; re-running resumes).

Flags: `-c/--config`, `-s/--state`, `--backup-dir`, `-y/--auto-approve`.

### `ct destroy --target <key…>`

1. Require at least one `--target` (repeatable and/or comma-separated). None ⇒
   hard error — nothing is ever deleted implicitly.
2. Load config + state. Every target must be a managed resource (in state).
3. `preventDestroy` guard: if a target is still declared in config with
   `preventDestroy: true`, hard-fail ("remove the flag in config first").
   Enforced even under `--force`.
4. Order targets in **reverse** dependency order (children before parents),
   reusing the topological sort over edges recorded in state.
5. Write a backup of the targets' actual values.
6. Typed confirmation: type the single key, or the word `destroy` for multiple
   targets. `--force` skips the typed prompt (but never the `preventDestroy`
   guard).
7. `DELETE` each, prune it from state, save after each.

Flags: `--target`, `-c/--config`, `-s/--state`, `--backup-dir`, `--force`.

## Modules

### `engine/build.ts` (new) — shared plan building

Extract the actual-fetch + hierarchy-fold + `computePlan` currently inlined in
`commands/plan.ts` into:

```
buildPlan(client, state, desired) -> { plan, actual, fetchErrors }
```

`commands/plan.ts` and `commands/apply.ts` both call it. `actual` (keyed by
logical key) is reused for the backup, so apply fetches once.

### `resources/registry.ts` (extended) — write specs

Extend `AdoptableResource`:

- `collectionPath: string` — `POST <collectionPath>` creates; `itemPath` derives
  from it (already the case).
- `updateMethod: "PUT" | "PATCH"` — `group` is `PATCH`; every other type is
  `PUT`.
- Delete is always `DELETE <itemPath(id)>`.

Add read+write entries for the new types. **Provisional** managed fields (to be
confirmed against the live API — fetch one of each with `ct get`, adjust):

| type                | collection path             | update | provisional managed fields          |
| ------------------- | --------------------------- | ------ | ----------------------------------- |
| `campus`            | `/campuses`                 | PUT    | `name`, `shortName`                 |
| `group`             | `/groups`                   | PATCH  | `name`, `groupTypeId`, `groupStatusId` |
| `group-type`        | `/group/grouptypes`         | PUT    | `name`, `nameTranslated`            |
| `age-group`         | `/group/agegroups`          | PUT    | `name`, `sortKey`                   |
| `target-group`      | `/group/targetgroups`       | PUT    | `name`, `sortKey`                   |
| `relationship-type` | `/person/relationshiptypes` | PUT    | `name`, `degreeForward`, `degreeReverse` |
| `group-role`        | `/group/roles`              | PUT    | `name`, `groupTypeId`               |

Provisional field sets are a registry-local detail; the engine is field-agnostic,
so refining them later touches only this file (+ its test).

### `engine/execute.ts` (new) — the executor

```
executePlan({ client, plan, state, statePath, save }) -> ExecuteResult
```

For each item in plan order:

- `delete` / `no-op` → skip (deletes counted for the caller's notice).
- `create` → `POST collectionPath` with the desired fields (minus lifecycle/
  hierarchy fields); capture the new id from the response; `upsert` into state;
  save.
- `update` → apply the field changes (see hierarchy below); `PUT`/`PATCH`
  `itemPath(id)`; refresh the state snapshot; save.

Stop on the first error; return `{ created, updated, skippedDeletes, error? }`.
Every write goes through `assertNotPeople(path)` first.

### Hierarchy edges (inside execute)

A group's `parents` set-field is **not** part of the group's `PATCH` body. On an
update whose changes include `parents`:

1. Diff desired parent keys vs actual parent keys (both are logical-key sets).
2. Resolve each key → CT id via state (parents are applied earlier by dep order
   and their ids are already saved).
3. For each added key: `PUT /groups/{childId}/parents/{parentId}`.
4. For each removed key: `DELETE /groups/{childId}/parents/{parentId}`.
5. Remaining (non-`parents`) group fields go via the normal `PATCH`.

The group's state snapshot is updated to the new parents set after success.

### `engine/backup.ts` (new)

```
writeBackup(dir, host, actual) -> filePath
```

Writes `{ host, capturedAt, resources }` (resources = the `actual` map) to
`backups/ct-backup-<timestamp>.json`. Timestamp is ISO-8601 with `:` replaced by
`-` for filename safety. Directory is created if missing.

### `ui/prompt.ts` (new)

- `confirm(message, { assumeYes }): Promise<boolean>` — `[y/N]` on stderr,
  reads stdin. `assumeYes` short-circuits true. Non-TTY without `assumeYes`
  returns false (caller aborts).
- `confirmTyped(expected, { force }): Promise<boolean>` — require the user to
  type `expected`. `force` short-circuits true. Non-TTY without `force` false.

### `engine/guard.ts` (new) — hard people boundary

`assertNotPeople(path)` throws if a write path matches a denylist: `/persons`,
`/persons/…`, `/memberships`, `/groups/{id}/members`, `/groups/{id}/memberships`.
This is belt-and-suspenders atop the structural-only registry (which is the
primary allowlist — no people type is ever registered).

### `config/context.ts` + `engine/types.ts`

Add `preventDestroy?: boolean` to `ResourceInput` and `DesiredResource`. It is a
**lifecycle flag**, extracted before building `fields`, so it is never diffed,
snapshotted, or sent to the API — it only gates `destroy`.

### CLI wiring

Add `commands/apply.ts` and `commands/destroy.ts`; remove both entries from
`commands/placeholders.ts` (leaving that file empty of Phase-4 verbs).

## Guardrail → mechanism map

| Guardrail (issue #6)             | Mechanism                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| Confirmation before any change   | `confirm` (apply) / `confirmTyped` (destroy)                    |
| Automatic backup before apply    | `writeBackup(actual)` before the first write                    |
| People/memberships never touched | structural-only registry + `assertNotPeople` denylist           |
| Rate-limit + retry on writes     | existing `fetchWithRetry` (429 retried; 5xx/network not, for writes) |
| State updated after each action  | `save` after every create/update/edge/delete                   |
| Destroy-protection               | `preventDestroy` flag + explicit `--target` + typed confirm     |

Rate-limit/retry needs **no code change**: `fetchWithRetry` already retries `429`
for every method (safe — rejected before processing) and deliberately does not
retry `5xx`/network errors for non-idempotent writes.

## Crash-safety / resumability

`saveState` runs after each successful action, so a mid-apply crash leaves the
state file reflecting completed work. Re-running recomputes the plan against the
new state and continues; completed creates/updates show as no-ops.

## Failure handling

- `buildPlan` fetch errors → apply/destroy abort before any write.
- apply stops on the first write error (state already persisted); exit 1; re-run
  resumes.

## Testing (vitest, fake `CtClient`)

- **execute**: create captures id + saves state; update uses the right
  method/body; hierarchy edge diff → exact `PUT`/`DELETE` calls; deletes skipped;
  `assertNotPeople` throws; stop-on-error leaves state consistent + partial.
- **registry**: write-spec paths + methods for every type.
- **backup**: file written with the right shape; dir created.
- **prompt**: `assumeYes`/`force`, typed match vs mismatch, non-TTY.
- **destroy**: `preventDestroy` blocks; missing `--target` errors; reverse order;
  state pruned; backup produced.
- **guard**: denylist matches people paths, allows structural paths.
- **CLI**: `apply`/`destroy` registered and in `--help`.
- **integration**: adopt → modify config → apply → re-plan shows no drift
  (against the fake client).

## Definition of done (issue #6)

- Apply creates an adopted-then-modified structure end-to-end; a second `plan`
  shows no drift. → integration test + live-verify.
- Destroy-protection blocks an unintended delete in a test. → `preventDestroy`
  test + explicit-target test.
- A backup artifact is produced before apply. → backup test + apply flow.

## Out of scope (later phases)

- Symbolic cross-references resolved at create time (e.g. a brand-new group
  referencing a brand-new group-type by logical key). Phase 4 fields are literal
  values / already-existing ids; the DoD is "adopted-then-modified", where ids
  already exist. This belongs to Phase 5 (blueprints).
- `dynamic-group` ruleset apply, `permission` grants — their own later issues
  (#14, #13).
- Runtime CT version gate (`GET /info` ≥ 3.96) — not in issue #6's scope.
