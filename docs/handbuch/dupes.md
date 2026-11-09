---
sources_hash: 4d866bf0bcecebbc
title: Duplicate review (ct dupes)
sources:
  - src/commands/dupes.ts
  - src/dupes/detector.ts
  - src/dupes/guard.ts
  - src/dupes/store.ts
  - src/dupes/review.ts
  - src/dupes/finance.ts
  - src/dupes/memberships.ts
  - src/dupes/redact.ts
reviewed: 2026-11-09
---

# Duplicate review (`ct dupes`)

`ct dupes` helps an operator find and merge duplicate person records. It is the one part
of ct-cli that reads and writes person data, which is why it is **interactive only** and
sits behind a personal-data guard. The structure commands (`plan`, `apply`, `destroy`)
never touch people.

Version 1 does **not** call ChurchTools' merge API. It prepares the merge, then opens
ChurchTools' own merge page in the browser and waits for you to confirm.

## Commands

| Command                                  | What it does                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ct dupes scan [--env]`                  | Loads non-archived persons and ChurchTools' own duplicate suggestions, scores pairs, stores them. |
| `ct dupes review [--limit N]`            | One pair at a time: merge, "keine Dublette", skip or quit.                                        |
| `ct dupes export-finance [--since DATE]` | Writes `optigem-merges-<date>.csv` and `.json` for merges where both persons had an Optigem ID.   |

Common options: `-e, --env`, `--redact`, `--optigem-field <key>` (or
`CT_DUPES_OPTIGEM_FIELD`, default `optigemId`). `review` also takes `--merge-url <template>`
with `{host}`, `{original}` and `{duplicate}` placeholders.

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

Both persons are shown side by side, with shared groups marked **dynamic** or **static** and
both Optigem IDs. On "merge" you pick the surviving person, then:

1. The loser is removed from shared **dynamic** groups automatically and this is logged.
2. For shared **static** groups, only member fields where both sides hold different values
   are shown; you choose per field. Empty-versus-filled fields resolve automatically. The
   result is written to the survivor's membership, then the loser's membership is removed.
3. ChurchTools' merge page opens in your browser. Complete the merge there and confirm in
   the terminal.

"Keine Dublette" writes the relationship back to ChurchTools so the pair is never proposed
again. The default merge-page URL is a template that may need adjusting with `--merge-url`
for your ChurchTools version.

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
