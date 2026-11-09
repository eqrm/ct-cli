---
sources_hash: 6b3bd8f40f084748
title: Duplicate review (ct dupes)
sources:
  - src/commands/dupes.ts
  - src/dupes/detector.ts
  - src/dupes/guard.ts
  - src/dupes/store.ts
  - src/dupes/review.ts
  - src/dupes/finance.ts
  - src/dupes/redact.ts
reviewed: 2026-11-09
---

# Duplicate review (`ct dupes`)

`ct dupes` helps an operator find and merge duplicate person records. It is the one part
of ct-cli that reads and writes person data, which is why it is **interactive only** and
sits behind a personal-data guard. The structure commands (`plan`, `apply`, `destroy`)
never touch people.

The merge itself goes through ChurchTools' merge API (`GET` and `PATCH
/persons/{original}/merge/{duplicate}`). The endpoint is marked Beta in the OpenAPI spec, so
its behaviour may change between ChurchTools releases.

## Commands

| Command                                  | What it does                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ct dupes scan [--env]`                  | Loads non-archived persons and ChurchTools' own duplicate suggestions, scores pairs, stores them. |
| `ct dupes review [--limit N]`            | One pair at a time: merge, "keine Dublette", skip or quit.                                        |
| `ct dupes export-finance [--since DATE]` | Writes `optigem-merges-<date>.csv` and `.json` for merges where both persons had an Optigem ID.   |

Common options: `-e, --env`, `--redact`, `--optigem-field <key>` (or
`CT_DUPES_OPTIGEM_FIELD`, default `optigemId`).

## How pairs are found

Persons are blocked by shared email, phone, name and address keys (keys with more than 40
members are skipped), then scored. A pair gets a **match class** (`exact`, `nameswap`,
`middlename`, `firsttoken`, `shortform`, `diminutive`, `fuzzy`, or `ct` for pairs only
ChurchTools suggests) and a tier: T1 (score 85 and up), T2 (60 to 84), T3 (35 to 59).
Lower scores are discarded.

Pairs are dropped when:

- they are linked by any relationship other than "Dublette" (for example "keine Dublette");
- either name is a placeholder, or four or more persons share an identical name;
- the birthdays differ, or both sex values are set and differ.

## Review and merge

Both persons are shown side by side with both Optigem IDs. On "merge":

1. The view is laid out like ChurchTools' "Dubletten überprüfen" dialog: **Original** on the
   left, **Duplikat** on the right, with ID, created date and last login above the fields. The
   Original is the older person (the lower id), as in ChurchTools' own merge UI. `t` (tauschen)
   swaps the two columns and can be pressed repeatedly. On `m`, the shown Original is kept.
2. `ct dupes` loads the merge preview. Every differing person field with a key is listed;
   for each you keep the Original's (`o`) or the Duplikat's (`d`) value; the default is the non-empty side (the Original's if both are filled). The Optigem ID is not asked per field: a lone ID is always kept, and if both have
   different IDs you choose the leading one (`o` or `d`).
   The number of groups that move over and that both persons share is shown for information.
3. After the plan and `Proceed? [y/n]`, the Original's person object (with your choices
   applied) is sent in one `PATCH`. ChurchTools moves memberships, relations, bookings and
   other related records to the Original in a single transaction, so there is **no
   group clean-up** before the merge. Addresses are never replaced: `emails` becomes the Original's list plus the other
   person's addresses not present yet (without their ids); choosing the other person's email
   makes that address the default. Just before the PATCH the Original is re-read, so the body
   reflects its current state. A chosen field the other person's record does not carry is
   skipped with a warning.
4. Afterwards the duplicate is looked up: a 404 means it is gone. If ChurchTools kept the
   record, the merge is still recorded, with `duplicateStillExists: true` in the audit log;
   `ct dupes` never deletes it.

If the merge call fails, `merge-error` is logged and only the HTTP status is printed. If the
duplicate is gone nevertheless, the merge is recorded (`afterError: true`); otherwise the pair stays
open (`pending`). At the start of a later review, a pair whose `merge-started` was never confirmed
and whose duplicate is gone is recorded as merged (`recovered: true`). The audit log keeps `merge-started` (the differing fields of both
persons and the group ids of the preview) and `merge-confirmed` (what the finance export reads).

"Keine Dublette" writes the relationship back to ChurchTools so the pair is never proposed
again. A re-scan keeps earlier decisions (dismissed, merged) for pairs that still turn up, so
a dismissal whose write-back failed does not reappear. The relationship types are found by
their function keys `noduplicate` and `openduplicate`; if the instance has none, the command
stops rather than guess an id.

## Personal-data guard

Against a **protected** environment (and when no `--env` is given, or for a gateway
environment) `ct dupes` runs only if stdin and stdout are both terminals and the process
is not running inside an AI coding agent session. There is no flag to bypass this. The
refusal message is deliberately neutral and prints no person data.

## Local store

Scan results, the audit log and exports live outside any repository, in directories with
mode `0700` and files with mode `0600`:

- macOS: `~/Library/Application Support/ct-cli/dupes/<host-slug>/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/ct-cli/dupes/<host-slug>/`
- override with `CT_DUPES_DIR`; the store refuses a path inside a git work tree.

Files: `candidates.json`, `audit.jsonl` (one JSON line per action), `redact.key`, `exports/`.

`--redact` replaces names and ids on screen with stable pseudonyms derived from a local
secret. Error messages never include person data.

## Finance export

Schema `ct-cli.dupes.optigem-merges/1` (additive changes only within version 1). Rows are
taken from confirmed merges where both persons carried an Optigem ID.

CSV header: `surviving_person_id,leading_optigem_id,orphaned_optigem_id,identical_ids,merged_at,merged_by`.
The JSON file wraps the same rows as camelCase objects in `{ schema, generatedAt, host, since, merges }`.
Cells starting with a formula character are prefixed with `'`.

## Testing against a dev instance

`scripts/seed-dupes-dev.ts` creates fictitious pairs (`Zzd-` prefix) covering every match
class, a shared dynamic group and a shared static group with conflicting member fields.
`--cleanup` removes them. It refuses to run unless `CT_LIVE_WRITE_HOST` equals the
authenticated host.
