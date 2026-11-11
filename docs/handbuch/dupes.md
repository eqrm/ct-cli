---
sources_hash: 3189d0ade3c80be3
title: Duplicate review (ct dupes)
sources:
  - src/commands/dupes.ts
  - src/dupes/detector.ts
  - src/dupes/guard.ts
  - src/dupes/store.ts
  - src/dupes/actions.ts
  - src/dupes/merge-model.ts
  - src/dupes/groups.ts
  - src/dupes/web/server.ts
  - src/dupes/web/page.ts
  - src/dupes/web/run.ts
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
| `ct dupes review [--tui] [--no-open]`    | Review the scanned pairs in the browser (or the terminal): merge, "keine Dublette", skip.         |
| `ct dupes export-finance [--since DATE]` | Writes `optigem-merges-<date>.csv` and `.json` for merges that orphaned an Optigem ID.            |

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

`ct dupes review` starts a small local web server and opens a page in the browser that is
modelled on ChurchTools' own duplicate page (`/persons/duplicates`) and its "Dubletten
überprüfen" dialog, with the ct dupes additions (tiers, match class, Optigem, shared groups).
The command prints the URL and keeps running until you press "Beenden" on the page or `Ctrl-C`.
"Finance-Export" in the page header downloads the finance export (below) as CSV into the browser's
download folder; it is not offered with `--redact`.
`--no-open` only prints the URL. `--tui` uses the full-screen terminal view instead (below).

### Browser view

The list shows one card per pair with tier, score, match class and source, and the two persons
as **Original** and **Duplikat** (name, ID, created date, last login). Tabs filter by state
(Überprüfen, Zusammengeführt, Keine Dublette), chips by tier, and a search box by name or ID.
`⇄` swaps Original and Duplikat for that pair.

"Vergleichen und zusammenführen" opens the dialog: the two cards on top, then a table with the
columns Original, Vorschlag für Zusammenführung and Duplikat, grouped into Sonstiges (group
counts), Adresse, Informationen, Kategorie, Bereich and Finanzen. Click the arrow next to the
Original's or the Duplikat's value (or the value itself) to take that side; the chosen arrow is
outlined, and `×` clears the field. Bereich is a list: when both persons have
different Bereiche, the result keeps both (`beide`), and an arrow takes one side only. On email rows the arrow includes the address and `×` leaves it out, and the star makes it the default address. Each email row is labelled with its
contact type from masterdata ("E-Mail (Privat)"); an address both persons have keeps the
Original's type, and the Duplikat's differing type is shown next to its value. Campus, status, sex and Bereich show
their masterdata names, and dates read as in ChurchTools (30.06.1999). "Identische Felder" also lists equal fields. The shared groups follow, one block per
group with its plan and its membership values, chosen the same way. The footer has Abbrechen,
"Keine Dublette", a pager (`→` skips to the next open pair) and Zusammenführen, which merges right
away, as in ChurchTools (the dialog itself is the review). After an action the dialog moves
on to the next open pair at the same position in the pager; the finished pair stays on screen,
dimmed, until the next one has loaded, so the dialog never blanks in between. `Esc` closes the dialog.

The server listens on `127.0.0.1` only, on a random port. The URL carries a random token in its
fragment, and every API call must send it back in a header; requests with a `Host` other than
`127.0.0.1:<port>` are refused (against DNS rebinding). The page itself contains no person data
and loads nothing from outside (strict Content-Security-Policy); values are inserted as text,
never as HTML. With `--redact` the page gets the same pseudonyms as the terminal, never raw ids.
Merges and dismissals go through the same code as the terminal view.

### Terminal view (`--tui`)

A full-screen terminal view (Ink). Ink and React load only for `--tui`, so every other `ct`
command starts as fast as before.

#### List screen

All candidates of the last scan with tier, score, match class, source, both names and state
(`open`, `merged`, `dismissed`). Names come from one `GET /persons` when the screen opens.

| Key         | Action                          |
| ----------- | ------------------------------- |
| `↑` `↓`     | move; `PgUp` / `PgDn` page      |
| `1` `2` `3` | show only tier T1 / T2 / T3     |
| `a`         | show all                        |
| `Enter`     | open the pair (open pairs only) |
| `q`         | quit                            |

#### Pair screen

Two cards, **Original** (green) and **Duplikat** (red), show name, ID, created date and last
login. The Original is the older person (the lower id), as in ChurchTools' own merge UI. Below
them a table has the columns Feld, Original, Ergebnis and Duplikat. Only differing fields are
listed; `i` also shows identical ones. The chosen side is green, the other red.

| Key          | Action                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| `↑` `↓`      | move the row cursor                                                              |
| `←`          | take the Duplikat's value into Ergebnis (also on group membership rows)          |
| `→`          | take the Original's value                                                        |
| `x`          | clear Ergebnis (field rows); include or exclude the address (email rows)         |
| `b`          | Bereich: keep the entries of both persons                                        |
| `Space`, `*` | email rows: include or exclude an address; make it the default address           |
| `i`          | show or hide identical fields                                                    |
| `t`          | swap Original and Duplikat (reloads the merge preview for the new direction)     |
| `m`          | merge: a confirm dialog lists what changes; `y` or `Enter` sends it, `n` cancels |
| `n`          | "keine Dublette"                                                                 |
| `s`          | skip                                                                             |
| `Esc`        | back to the list                                                                 |

### Choices and merge

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
itself, but it refuses the merge (HTTP 403) while both persons are in a common group. So
`ct dupes` cleans up the shared groups first:

- **dynamic (Auto) groups:** the Duplikat is removed; the group's ruleset decides about the
  Original.
- **other groups:** the Original's membership is kept. Its role, status, join and end date,
  comment and group member fields are listed below the person fields, one row per differing
  value, with `←` / `→` like a person field. By default the earlier join date wins, empty values
  are filled from the Duplikat and the Original wins a conflict. Values taken from the Duplikat
  are written to the Original's membership (`PATCH /groups/{g}/members/{original}`), then the
  Duplikat is removed from the group.

The dialog shows the plan per group (the terminal view's confirm dialog too). The merge preview reports shared groups under
`both` as group ids; titles come from its `old` and `new` lists. If a group step fails, the merge
is not sent, the pair stays open and `merge-error` (stage `groups`, with the steps already done)
is logged; successful steps are logged as `groups-prepared`.

On merge the Original is re-read, your choices are applied to that fresh object and sent in
one `PATCH /persons/{original}/merge/{duplicate}`. The body has the shape ChurchTools' own merge
UI sends: a fixed list of system keys (`id`, `guid`, `meta` with its four created/modified keys,
campus, status, departments, security levels, privacy agreement and similar) plus the person
fields, each only with a value. Anything else from the `GET` is left out: the complete object is
rejected with HTTP 400, and nested objects such as `invitationStatus` make the endpoint fail with
a 500 (verified on a dev instance).

Verified on a dev instance: the duplicate is deleted, its group memberships move to the Original,
an address that is not included disappears, and a cleared field is sent as `""` and stays empty.
The group clean-up was run end to end there with one static group (join date, comment and a
member field taken from the Duplikat) and one dynamic group.

If the call fails, the HTTP
status, the field names ChurchTools rejected and its `messageKey` are shown (never values or
messages) and the pair
stays open. ChurchTools refuses to merge a person with permissions of their own
(`error.forbidden.merge-authorized-person`, HTTP 403); the page says so in plain words. `merge-error` is logged; if the duplicate is gone
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

The agent check is best-effort detection, not a guarantee. It looks for the environment
markers and command lines of known coding-agent tools, so an unknown or deliberately
disguised agent can slip through. If the process ancestry cannot be read (for example
`ps` is missing), the command refuses rather than guessing. Treat the guard as a safety
net and keep personal data off sessions you do not control.

## Local store

Scan results, the audit log and exports live outside any repository, in directories with
mode `0700` and files with mode `0600`:

- macOS: `~/Library/Application Support/ct-cli/dupes/<host-slug>/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/ct-cli/dupes/<host-slug>/`
- override with `CT_DUPES_DIR`; the store refuses a path inside a git work tree.
- `export-finance --out <dir>` follows the same rules: it refuses a git work tree, creates
  a new directory with `0700`, writes files `0600`, and warns if an existing directory is
  readable by group or others.

Files: `candidates.json`, `audit.jsonl` (one JSON line per action), `redact.key`, `exports/`.

`--redact` replaces names and ids on screen with stable pseudonyms derived from a local
secret. Error messages never include person data.

## Finance export

Schema `ct-cli.dupes.optigem-merges/1` (additive changes only within version 1). Rows are
taken from confirmed merges where both persons carried an Optigem ID.

Each row names both persons as they were before the merge (id, name, Optigem ID), the person
that survives in ChurchTools and the Optigem ID it now carries (`leading`; the other one is
`orphaned`). Finance decides which ID stays in Optigem and updates its records. Names and
per-person IDs are empty for merges logged before they were recorded.

CSV header: `surviving_person_id,surviving_person_name,surviving_person_optigem_id,merged_person_id,merged_person_name,merged_person_optigem_id,leading_optigem_id,orphaned_optigem_id,identical_ids,merged_at,merged_by`.
The JSON file wraps the same rows as camelCase objects in `{ schema, generatedAt, host, since, merges }`.
Cells starting with a formula character are prefixed with `'`.

The export files are derived from the audit log and can be deleted at any time: a new export
writes them again. A downloaded CSV starts with a UTF-8 byte order mark so spreadsheet tools
read names correctly. It contains names, so delete it once finance has it.

## Testing against a dev instance

`scripts/seed-dupes-dev.ts` creates fictitious pairs (`Zzd-` prefix) covering every match
class, a shared dynamic group and a shared static group with conflicting member fields.
`--cleanup` removes them. It refuses to run unless `CT_LIVE_WRITE_HOST` equals the
authenticated host.
