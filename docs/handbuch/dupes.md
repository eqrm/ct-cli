---
sources_hash: d5db23610eca3c22
title: Duplicate review (ct dupes)
sources:
  - src/commands/dupes.ts
  - src/dupes/detector.ts
  - src/dupes/guard.ts
  - src/dupes/store.ts
  - src/dupes/actions.ts
  - src/dupes/merge-model.ts
  - src/dupes/tui/App.tsx
  - src/dupes/tui/ListScreen.tsx
  - src/dupes/tui/PairScreen.tsx
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
| `ct dupes review`                        | Full-screen review of the scanned pairs: merge, "keine Dublette", skip.                           |
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

`ct dupes review` opens a full-screen terminal view (Ink) modelled on ChurchTools' "Dubletten
überprüfen" dialog. Ink and React load only for this command, so every other `ct` command
starts as fast as before.

### List screen

All candidates of the last scan with tier, score, match class, source, both names and state
(`open`, `merged`, `dismissed`). Names come from one `GET /persons` when the screen opens.

| Key         | Action                          |
| ----------- | ------------------------------- |
| `↑` `↓`     | move; `PgUp` / `PgDn` page      |
| `1` `2` `3` | show only tier T1 / T2 / T3     |
| `a`         | show all                        |
| `Enter`     | open the pair (open pairs only) |
| `q`         | quit                            |

### Pair screen

Two cards, **Original** (green) and **Duplikat** (red), show name, ID, created date and last
login. The Original is the older person (the lower id), as in ChurchTools' own merge UI. Below
them a table has the columns Feld, Original, Ergebnis and Duplikat. Only differing fields are
listed; `i` also shows identical ones. The chosen side is green, the other red.

| Key          | Action                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| `↑` `↓`      | move the row cursor                                                              |
| `←`          | take the Duplikat's value into Ergebnis                                          |
| `→`          | take the Original's value                                                        |
| `x`          | clear Ergebnis (field rows); include or exclude the address (email rows)         |
| `Space`, `*` | email rows: include or exclude an address; make it the default address           |
| `i`          | show or hide identical fields                                                    |
| `t`          | swap Original and Duplikat (reloads the merge preview for the new direction)     |
| `m`          | merge: a confirm dialog lists what changes; `y` or `Enter` sends it, `n` cancels |
| `n`          | "keine Dublette"                                                                 |
| `s`          | skip                                                                             |
| `Esc`        | back to the list                                                                 |

Defaults: the non-empty side wins, the Original wins a conflict. Only real person fields can
be chosen (names, nickname, birthday, address, phones, sex, campus, status, job, departments
and similar). System keys such as `guid`, `id`, `meta`, image and URL fields, security levels
and privacy fields are never offered and always come from the Original. Campus, status and sex
show their names from `/person/masterdata` (the ids when masterdata has no name; id `0` is a
valid campus or status id).

Email addresses are one row per distinct address of both persons. All are included by default
and the Original's default address stays default; exactly one included address is the default
(`*`). Each address is sent as `contactLabelId`, `email` and `isDefault`, without an `id`, as
ChurchTools' own merge UI does.

The Optigem ID is a normal row. A lone ID is preselected; with two different IDs the Original's
wins until you choose. The leading and orphaned IDs in the audit log and the finance export
follow the final choice.

An info line shows the group counts of the merge preview (the original's groups, the
duplicate's, shared ones). ChurchTools moves memberships, relations and other related records
itself, so `ct dupes` does **no** group clean-up.

On confirm the Original is re-read, your choices are applied to that fresh object and sent in
one `PATCH /persons/{original}/merge/{duplicate}`. The body has the shape ChurchTools' own merge
UI sends: only keys with a value, no read-only or derived keys (`email`, created/modified fields,
image URLs, `parents`, `kids`, `spouse`, login data and similar), and only the four `meta` keys
`createdDate`, `createdPerson`, `modifiedDate`, `modifiedPerson`. ChurchTools rejects the
complete `GET` object with HTTP 400. Afterwards the duplicate is looked up: a 404
means it is gone; if ChurchTools kept the record, the merge is still recorded with
`duplicateStillExists: true` and the record is never deleted. If the call fails, the HTTP
status and the field names ChurchTools rejected are shown (never values or messages) and the pair
stays open. `merge-error` is logged; if the duplicate is gone
nevertheless, the merge is recorded (`afterError: true`). When a pair later no longer loads and
its `merge-started` was never confirmed, it is recorded as merged (`recovered: true`). After an
action you return to the list with the cursor on the next open pair; the scan file is saved
after every decision. The audit log keeps `merge-started` (the differing fields of both
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
