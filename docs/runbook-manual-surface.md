# Runbook: manual ChurchTools surface

What `ct` **cannot** (yet, or ever) manage, so instance bootstrap (#23) can
apply "selective adoption" deliberately instead of guessing. If reproducing an
instance from code means "rebuild the scaffold with `ct apply`, then do
_these_ specific clicks by hand," this is the list of those clicks.

Every item below falls into exactly one of three buckets:

- **API gap** — ChurchTools does not expose a write endpoint (or any
  endpoint) for this. Nothing in `ct` can close this until CT ships one.
- **Not yet implemented** — the ChurchTools API supports it, but `ct` doesn't
  drive it yet. Tracked by an open issue; closing the issue removes the item
  from this runbook.
- **Out of tool scope** — deliberately, permanently unmanaged. Not a gap to
  close; a boundary the tool is designed to respect.

## API gap — CT does not expose a write endpoint

| Item                           | What it is                                                                                           | Why manual                                                                                                                                                                                 | Where in the CT admin UI                                                   | How to verify                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group member-statuses          | The set of "member status" values a group can assign to its members (e.g. active/candidate) — NOT the same dimension as a group's own `groupStatusId`, which IS fully managed (`ct.group({ groupStatusId })`, [`docs/group-field-decisions.md`](group-field-decisions.md)); do not conflate the two (#67) | Only `GET /group/memberstatus` exists; no create/update/delete endpoint ([`docs/api-coverage.md`](api-coverage.md) #8)                                                                     | Group settings → member status admin (org-wide master data, not per-group) | `ct get raw /group/memberstatus` (no dedicated `ct get member-statuses` subcommand yet — the generic `raw` path covers it) and diff by eye against the expected list below                                                                                                                      |
| Meeting points (Treffpunkte)   | A group's meeting-location master data                                                               | No endpoint at all — zero matches for `treffpunkt`/`meetingpoint` anywhere in the OpenAPI spec ([`docs/api-coverage.md`](api-coverage.md) #11)                                             | Group admin → meeting point field on a group                               | No API verification possible; visually confirm in the UI. (Do not confuse with _meeting templates_ `/group/meetingtemplates` or _group meetings_ `/groups/{id}/meetings`, both full CRUD but different concepts — confirm with product if "meeting point" was meant to be one of those instead) |
| Bereiche (departments) — creating/renaming one | The Bereich master data (`/departments`) — the `cdb_bereich` permission scope dimension | `GET /departments` exists but no write verb does — no `POST`/`PUT`/`DELETE`, and no `/departments/{id}` path at all (live-probed against the instance OpenAPI spec, eqrm prod CT 3.135.2, 2026-08-13; [`docs/api-coverage.md`](api-coverage.md) #14) | Master data admin → Bereiche | `ct get departments` lists them. **Grants scoped to one ARE declarable** — `scope: [{ department: "<name-slug>" }]` resolves by name per host (#98) — so only CREATING or RENAMING a Bereich is manual. Renaming one in CT breaks every config reference to its old name, by design: the reference then hard-errors instead of silently regranting elsewhere |
| Permission name↔authId catalog | The mapping from human-readable `module:right` names to the numeric `authId` the API actually writes | Not exposed by the REST API at all; only servable via the legacy `POST /index.php?q=churchauth/ajax&func=getMasterData` call ([`src/permissions/README.md`](../src/permissions/README.md)) | Permission editor (any role's right-picker enumerates the live set)        | Regeneration procedure below (**Permission catalog lifecycle**)                                                                                                                                                                                                                                 |

**Expected values for a given instance:** left blank here deliberately — this
runbook is generic (part of `ct-cli`, the tool repo). The per-instance
expected/desired values (which member statuses, which meeting points) belong
in that instance's own config repo, in a runbook following this doc's structure.

## Not yet implemented — API supports it, `ct` doesn't drive it yet

| Item                                  | What it is                                                                                                                                                                                                    | Tracking issue                                                          | Manual workaround today                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group/group-type field decision table | Fields deliberately left unmanaged (decided out of scope): visibility, note, `autoAccept`/open-for-members, chat status, sort key. The triage **shipped** as a committed decision table ([`docs/group-field-decisions.md`](group-field-decisions.md))          | [#21](https://github.com/eqrm/ct-cli/issues/21) (decided)               | Set by hand; these fields are intentionally not diffed — `ct` will neither preserve nor revert them. Promote one later only with its own registry entry + tests                                                           |
| Portable/logical references           | **Shipped (#20, #25).** Configs reference master data by name/key — `campus`/`groupType` on a group, `ref.campus(...)` in ruleset `var` values, `groupType: "<name>"` for a `group_type_role` domain, and now `group: "<key>", role: "<name>"` for a `group_role` domain (#25) — and the per-host resolver maps each to that instance's id at plan time (managed resources ∪ live catalogs). A same-run campus resolves at apply time. Numeric ids still work as an escape hatch. **`status` (group status) is NOT part of this** (#67) — group statuses have no REST catalog, so `status:` fails fast at eval time; declare the numeric `groupStatusId` directly | [#20](https://github.com/eqrm/ct-cli/issues/20) (done), [#25](https://github.com/eqrm/ct-cli/issues/25) (done)                  | None needed for the shipped surface. Write logical names; run `ct plan`. The `group_role` pairing-id resolution is verified live (row below)                                                                                    |
| Environments (dev → prod promotion)   | Named `(host, token, state file)` profiles and a `--env` flag; today one config + one state file = one host                                                                                                   | [#22](https://github.com/eqrm/ct-cli/issues/22)                         | Point `CT_HOST`/state file manually at each target and re-run; keep dev and prod state files apart yourself, and be careful — nothing stops you from applying a dev-shaped config against prod today                      |
| Permission `group_role` domain by reference **(shipped, verified live)** | `ct.groupRole({ group, role })` now resolves the (group, role) pair to its pairing domainId at plan time (#25). **Confirmed live 2026-08-13 (CT 3.135.2):** it reads the group's role list (`GET /groups/{groupId}/roles`) and takes the matched role row's `id` as the pairing domainId. Two anchors on different group types: each row's `id` is a live `group_role` domainId carrying that role's grants, while its type-level `groupTypeRoleId` appears nowhere in the domainId set | [#25](https://github.com/eqrm/ct-cli/issues/25) (done, verified)     | None needed. Works by reference for managed, already-created groups; numeric `id:` remains a supported escape hatch ([`docs/handbuch/permissions.md`](handbuch/permissions.md) "domainId semantics") |
| ~~Grant adoption~~ **(shipped)**      | ~~existing rights structures must be hand-transcribed~~ — **`ct adopt grants <domainType> <domainId>` ships this** (#25): it reads the live rows, applies the planner's normalization, and prints a paste-ready `ct.groupRole` / `ct.groupTypeRole` block (baseline/inherited excluded, denies noted-and-preserved, scope dataIds mapped back to managed-group keys). See [`docs/handbuch/permissions.md`](handbuch/permissions.md) "Adopting existing grants" | [#25](https://github.com/eqrm/ct-cli/issues/25) (done)                  | No workaround needed — run `ct adopt grants group_role <id>` (or `group_type_role`), review the `WARNING`/`NOTE` comments, paste into config                                                                              |
| ~~Permission catalog lifecycle~~ **(shipped)** | ~~`catalog.json` is a one-off HAR-trace snapshot with no staleness detection~~ — **shipped (#25):** `npm run regenerate:permission-catalog` rewrites it from a live instance (records the CT version in `$meta`), and `ct plan` now warns on a version mismatch or an unknown-authId live grant (which it leaves untouched, never revoking a right it cannot name). See [`docs/handbuch/permissions.md`](handbuch/permissions.md) "Catalog lifecycle & staleness" | [#25](https://github.com/eqrm/ct-cli/issues/25) (done)                  | No workaround needed — run the command; heed the `ct plan` warnings                                                                                                                                                       |
| Field definitions & security levels (person + group custom fields) **(read-only, shipped #47/#48)** | The person master-data model, the security-level enumeration, and the data-field DEFINITIONS ("Datenfelder") for persons and groups — structural schema, not per-record values | [#47](https://github.com/eqrm/ct-cli/issues/47), [#48](https://github.com/eqrm/ct-cli/issues/48) (read shipped; write is an API gap — see note) | Read with `ct get person-masterdata` (model + security levels) and `ct get data-fields` (all field definitions, person + group, discriminated by `fieldCategory`). **Mutation stays manual:** field definitions have no REST write endpoint — only the legacy churchdb admin AJAX (`db_insertfields`/`db_updatefields`/`db_deletefields`) — so create/edit/delete them by hand in the master-data admin UI. Decision + evidence: [`docs/handbuch/field-definitions.md`](handbuch/field-definitions.md) |
| API re-audit for new CT releases      | CT's OpenAPI spec is self-trimming (only shows endpoints your version has), so a new write endpoint (e.g. a member-status write, or — separately — a first-ever group-status list/write endpoint, #67) appears silently between CT upgrades                                          | tracked by this issue ([#26](https://github.com/eqrm/ct-cli/issues/26)) | Procedure below (**Re-audit procedure for new CT releases**)                                                                                                                                                              |

## Out of tool scope — deliberate, not a gap

| Item                                                                                                                                | Why it's out of scope                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| People, memberships, group member lists                                                                                             | Hard boundary enforced in code (`assertNotPeople`, `src/engine/guard.ts`) — the tool manages rights-bearing _structure_ only, never who's in it. This is permanent by design, not a roadmap item; see README's "People are never managed"                                                                                                 |
| Other CT modules — calendars, services (`churchservice`), resource booking (`churchresource`), forms, check-in, wiki, finance, sync | Never in the tool's stated mandate ("campuses, structural groups, hierarchies, group types/roles, permission & auto-groups" — README). Phase 0's coverage matrix (`docs/api-coverage.md`) only analyzed the 12 resource types relevant to that structural mandate; nothing else was assessed for CRUD support and nothing else is planned |
| Module-level settings, i18n                                                                                          | Out of tool scope by design — global instance configuration, not per-resource declarative structure                                                                                                                                                                                                                                       |
| Custom field / master-data field **VALUES on individual person/group records**                                                      | People/record data is the permanent people boundary (`assertNotPeople`). Note: the field **DEFINITIONS** (schema) are **no longer out of scope** — they moved to read-only supported above (#47/#48, [`docs/handbuch/field-definitions.md`](handbuch/field-definitions.md)); only the per-record *values* stay out of scope. |

## Permission catalog lifecycle (regeneration procedure)

**Scripted (#25) — the normal path.** Regenerate `src/permissions/catalog.json`
from a live instance with one command:

```bash
CT_HOST=https://your.church.tools CT_LOGINTOKEN=<token> npm run regenerate:permission-catalog
```

It reads `POST /index.php?q=churchauth/ajax` `func=getMasterData`, flattens
`data.auth_table[module][right]` to
`"module:right" → { authId: id, scopeField: datenfeld, revocable: !!isRevocable, desc: bezeichnung }`,
stamps the instance's CT version into `$meta`, and rewrites the file (read-only
against the instance). Review the `git diff` and commit.

**Staleness signals.** `ct plan`/`ct apply` throw a clear "did you mean" error
for an unknown right *name* in a config; they now also **warn** (not fail) when
the live instance's CT version differs from `$meta.ctVersion`, and when a live
grant carries an `authId` the catalog cannot name (left untouched, never
revoked). Both are fixed by regenerating.

**Manual fallback (HAR).** If you cannot run the script (no login token to
hand), capture it by hand:

1. Open the ChurchTools permission editor in a browser with devtools
   recording (Network tab).
2. Trigger the request: `POST /index.php?q=churchauth/ajax` with body
   `func=getMasterData`.
3. Export the HAR and extract `log.entries[].response` for that request.
4. Flatten `data.auth_table[module][right]` as above.
5. Overwrite `src/permissions/catalog.json` (keep the `$meta` block, updating
   its `ctVersion`/`capturedAt`).

## Re-audit procedure for new CT releases

CT's OpenAPI spec (`GET $CT_HOST/system/runtime/swagger/openapi.json`, pulled
by `npm run generate:client`) is **self-trimming**: `info.description` states
it "will always show only those endpoints you can use with your ChurchTools
installation." That means a version bump can silently add a write endpoint
this runbook still lists as an API gap (most plausibly: a `group/memberstatus`
write endpoint, or a meeting-point endpoint).

Until a scripted diff exists, re-audit manually after any CT upgrade:

1. Re-fetch the spec: `npm run generate:client` (writes
   `src/api/schema.d.ts`) or fetch `openapi.json` directly and open it.
2. For each item in the **API gap** table above, re-check whether its path
   now has additional methods (grep the spec for `/group/memberstatus`,
   `treffpunkt`/`meetingpoint`, etc.).
3. If a write method appeared: promote the item — add it to
   `src/resources/registry.ts` (or the relevant synthetic field), extend
   the DSL, add tests, and delete its row from this runbook's API-gap table.
4. Re-run `GET /info` to confirm the CT `version`/`build` this audit was
   performed against, and note it in the commit that updates this file.

This mirrors (and should eventually replace by scripting) the Phase 0 spike
that produced `docs/api-coverage.md` — see that doc for the full method.

## Checklist for a new instance

Order matches `ct apply`'s own dependency tiers (campuses/master-data before
groups before hierarchy/dynamic/permissions), with the manual items slotted
in where they'd otherwise be silently skipped:

1. `ct apply` the structural config (campuses, group types, age/target
   groups, groups, hierarchy, dynamic groups, permission grants).
2. **Group ↔ campus assignment** — declare `campus: "<key>"` (or numeric
   `campusId: <id>`) on the group in config; `ct` diffs and applies it like any
   field (#21). Same-run campuses now resolve automatically — the resolver marks
   the link pending at plan time and fills in the freshly-created id at apply
   time (#20), so no second pass is needed.
3. **Member statuses** — confirm the expected set exists via
   `ct get raw /group/memberstatus`; create any missing ones by hand in the
   CT admin UI.
4. **Meeting points** — set by hand per group where applicable; no API
   verification.
5. **Permission catalog** — confirm `src/permissions/catalog.json` was
   captured against a CT version ≥ this instance's `GET /info` version; if
   it's stale, regenerate first (**Permission catalog lifecycle** above)
   before trusting `ct plan`'s permission diff.
6. **Grants not yet expressed as config** — for any domain object with
   hand-set rights not covered by a `ct.groupRole`/`ct.groupTypeRole`
   declaration, adopt them now with `ct adopt grants <domainType> <domainId>`
   (paste the emitted block into config) so they don't silently diverge from
   what `ct plan` believes is desired.
7. **Field definitions & security levels** — read the current schema with
   `ct get person-masterdata` and `ct get data-fields` to confirm the expected
   fields, field groups, and security levels exist; create/edit any missing
   *definitions* by hand in the master-data admin UI (no REST write endpoint —
   see the field-definitions row above and [`docs/handbuch/field-definitions.md`](handbuch/field-definitions.md)).
8. **Anything from the "out of tool scope" table** — persons, memberships,
   per-record field values, calendars, services, resource booking, forms,
   check-in, wiki, finance, sync, module-level settings, i18n — configure per
   your organization's own (non-`ct`) process; this tool will never surface or
   touch these.
9. Run `ct plan` once more: it should be a clean no-op. Anything it still
   proposes is a real drift, not a manual-surface item.

## Open uncertainty

- The exact expected/desired **values** (which member statuses, which
  meeting points, which campus-per-group assignments) are instance-specific
  and deliberately not enumerated here — they belong in the instance's own
  private config repo. This runbook only tracks _what category_ of
  manual step exists and _how to verify_ it, not the target values for any
  particular ChurchTools instance.
- "Meeting point" (Treffpunkt) has no confirmed CT concept mapping — `docs/api-coverage.md`
  flags that it might actually mean _meeting templates_ or _group meetings_
  (both full CRUD, i.e. not actually manual at all). Confirm with product
  before treating it as a permanent API gap.
