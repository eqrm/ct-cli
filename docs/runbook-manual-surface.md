# Runbook: manual ChurchTools surface

What `ct` **cannot** (yet, or ever) manage, so instance bootstrap (#23) can
apply "selective adoption" deliberately instead of guessing. If reproducing an
instance from code means "rebuild the scaffold with `ct apply`, then do
_these_ specific clicks by hand," this is the list of those clicks.

Every item below falls into exactly one of three buckets. Keeping them apart
matters, because they say very different things and only one of them is about
ChurchTools' capabilities at all (#111 — the three were routinely conflated,
and "no REST endpoint" kept getting written down as "impossible"):

- **No write API `ct` can drive** — a _capability fact about the interfaces this
  tool speaks_, dated and sourced. It says: neither the REST/OpenAPI surface nor
  the legacy master-data registry offers a write path we can use today. It does
  **not** say ChurchTools cannot do it — CT's admin UI writes plenty that no API
  we audit exposes.
- **Not yet implemented** — the API supports it, but `ct` doesn't drive it yet.
  Tracked by an open issue; closing the issue removes the item from this runbook.
- **Out of tool scope** — a _product decision_, not an API limit. Deliberately
  unmanaged; not a gap to close, a boundary the tool is designed to respect.

Absolutes ("never", "permanently", "no API at all") belong only on items where
**both** probes in [the re-audit procedure](#re-audit-procedure-for-new-ct-releases)
were actually run and recorded, with dates — or on out-of-scope items, where the
absolute is about our own intent rather than about CT.

## No write API `ct` can drive

| Item                           | What it is                                                                                                                                                                                                                                                                                                | Why manual                                                                                                                                                                                 | Where in the CT admin UI                                                   | How to verify                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group member-statuses          | The set of "member status" values a group can assign to its members (e.g. active/candidate) — NOT the same dimension as a group's own `groupStatusId`, which IS fully managed (`ct.group({ groupStatusId })`, [`docs/group-field-decisions.md`](group-field-decisions.md)); do not conflate the two (#67) | Only `GET /group/memberstatus` exists; no create/update/delete endpoint ([`docs/api-coverage.md`](api-coverage.md) #8)                                                                     | Group settings → member status admin (org-wide master data, not per-group) | `ct get raw /group/memberstatus` (no dedicated `ct get member-statuses` subcommand yet — the generic `raw` path covers it) and diff by eye against the expected list below                                                                                                                      |
| Meeting points (Treffpunkte)   | A group's meeting-location master data                                                                                                                                                                                                                                                                    | No endpoint at all — zero matches for `treffpunkt`/`meetingpoint` anywhere in the OpenAPI spec ([`docs/api-coverage.md`](api-coverage.md) #11)                                             | Group admin → meeting point field on a group                               | No API verification possible; visually confirm in the UI. (Do not confuse with _meeting templates_ `/group/meetingtemplates` or _group meetings_ `/groups/{id}/meetings`, both full CRUD but different concepts — confirm with product if "meeting point" was meant to be one of those instead) |
| Permission name↔authId catalog | The mapping from human-readable `module:right` names to the numeric `authId` the API actually writes                                                                                                                                                                                                      | Not exposed by the REST API at all; only servable via the legacy `POST /index.php?q=churchauth/ajax&func=getMasterData` call ([`src/permissions/README.md`](../src/permissions/README.md)) | Permission editor (any role's right-picker enumerates the live set)        | Regeneration procedure below (**Permission catalog lifecycle**)                                                                                                                                                                                                                                 |

**Expected values for a given instance:** left blank here deliberately — this
runbook is generic (part of `ct-cli`, the tool repo). The per-instance
expected/desired values (which member statuses, which meeting points) belong
in that instance's own config repo, in a runbook following this doc's structure.

## Not yet implemented — API supports it, `ct` doesn't drive it yet

| Item                                                                                                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Tracking issue                                                                                                                                      | Manual workaround today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Group/group-type field decision table                                                               | Fields deliberately left unmanaged (decided out of scope): visibility, note, `autoAccept`/open-for-members, chat status, sort key. The triage **shipped** as a committed decision table ([`docs/group-field-decisions.md`](group-field-decisions.md))                                                                                                                                                                                                                                   | [#21](https://github.com/eqrm/ct-cli/issues/21) (decided)                                                                                           | Set by hand; these fields are intentionally not diffed — `ct` will neither preserve nor revert them. Promote one later only with its own registry entry + tests                                                                                                                                                                                                                                                                                                                                        |
| Portable/logical references                                                                         | **Shipped (#20, #25, #157).** Configs reference master data by name/key, including `campus`/`groupType`/`status` on a group and `ref.*` in rulesets. Group lifecycle statuses resolve through `/person/masterdata.groupStatuses`; numeric `groupStatusId` remains an escape hatch. This is distinct from `/group/memberstatus` and person `/statuses`.                                                                                                                                  | [#20](https://github.com/eqrm/ct-cli/issues/20), [#25](https://github.com/eqrm/ct-cli/issues/25), [#157](https://github.com/eqrm/ct-cli/issues/157) | Write logical names; run `ct plan`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Environments (dev → prod promotion)                                                                 | Named `(host, token, state file)` profiles and a `--env` flag; today one config + one state file = one host                                                                                                                                                                                                                                                                                                                                                                             | [#22](https://github.com/eqrm/ct-cli/issues/22)                                                                                                     | Point `CT_HOST`/state file manually at each target and re-run; keep dev and prod state files apart yourself, and be careful — nothing stops you from applying a dev-shaped config against prod today                                                                                                                                                                                                                                                                                                   |
| Permission `group_role` domain by reference **(shipped, verified live)**                            | `ct.groupRole({ group, role })` now resolves the (group, role) pair to its pairing domainId at plan time (#25). **Confirmed live 2026-08-13 (CT 3.135.2):** it reads the group's role list (`GET /groups/{groupId}/roles`) and takes the matched role row's `id` as the pairing domainId. Two anchors on different group types: each row's `id` is a live `group_role` domainId carrying that role's grants, while its type-level `groupTypeRoleId` appears nowhere in the domainId set | [#25](https://github.com/eqrm/ct-cli/issues/25) (done, verified)                                                                                    | None needed. Works by reference for managed, already-created groups; numeric `id:` remains a supported escape hatch ([`docs/handbuch/permissions.md`](handbuch/permissions.md) "domainId semantics")                                                                                                                                                                                                                                                                                                   |
| ~~Grant adoption~~ **(shipped)**                                                                    | ~~existing rights structures must be hand-transcribed~~ — **`ct adopt grants <domainType> <domainId>` ships this** (#25): it reads the live rows, applies the planner's normalization, and prints a paste-ready `ct.groupRole` / `ct.groupTypeRole` block (baseline/inherited excluded, denies noted-and-preserved, scope dataIds mapped back to managed-group keys). See [`docs/handbuch/permissions.md`](handbuch/permissions.md) "Adopting existing grants"                          | [#25](https://github.com/eqrm/ct-cli/issues/25) (done)                                                                                              | No workaround needed — run `ct adopt grants group_role <id>` (or `group_type_role`), review the `WARNING`/`NOTE` comments, paste into config                                                                                                                                                                                                                                                                                                                                                           |
| ~~Permission catalog lifecycle~~ **(shipped)**                                                      | ~~`catalog.json` is a one-off HAR-trace snapshot with no staleness detection~~ — **shipped (#25):** `npm run regenerate:permission-catalog` rewrites it from a live instance (records the CT version in `$meta`), and `ct plan` now warns on a version mismatch or an unknown-authId live grant (which it leaves untouched, never revoking a right it cannot name). See [`docs/handbuch/permissions.md`](handbuch/permissions.md) "Catalog lifecycle & staleness"                       | [#25](https://github.com/eqrm/ct-cli/issues/25) (done)                                                                                              | No workaround needed — run the command; heed the `ct plan` warnings                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Field definitions & security levels (person + group custom fields) **(read-only, shipped #47/#48)** | The person master-data model, the security-level enumeration, and the data-field DEFINITIONS ("Datenfelder") for persons and groups — structural schema, not per-record values                                                                                                                                                                                                                                                                                                          | [#47](https://github.com/eqrm/ct-cli/issues/47), [#48](https://github.com/eqrm/ct-cli/issues/48) (read shipped; write is an API gap — see note)     | Read with `ct get person-masterdata` (model + security levels) and `ct get data-fields` (all field definitions, person + group, discriminated by `fieldCategory`). **Mutation stays manual:** field definitions have no REST write endpoint — only the legacy churchdb admin AJAX (`db_insertfields`/`db_updatefields`/`db_deletefields`) — so create/edit/delete them by hand in the master-data admin UI. Decision + evidence: [`docs/handbuch/field-definitions.md`](handbuch/field-definitions.md) |
| API re-audit for new CT releases                                                                    | CT's OpenAPI spec is self-trimming (only shows endpoints your version has), so a new write endpoint (e.g. a member-status or group-status write endpoint) or a dedicated group-status collection replacing the nested `/person/masterdata.groupStatuses` catalog (#157) appears silently between CT upgrades                                                                                                                                                                            | tracked by this issue ([#26](https://github.com/eqrm/ct-cli/issues/26))                                                                             | Procedure below (**Re-audit procedure for new CT releases**)                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Out of tool scope — deliberate, not a gap

| Item                                                                                                                                | Why it's out of scope                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| People, memberships, group member lists                                                                                             | Hard boundary enforced in code (`assertNotPeople`, `src/engine/guard.ts`) — the tool manages rights-bearing _structure_ only, never who's in it. This is permanent by design, not a roadmap item; see README's "People are never managed"                                                                                                 |
| Other CT modules — calendars, services (`churchservice`), resource booking (`churchresource`), forms, check-in, wiki, finance, sync | Never in the tool's stated mandate ("campuses, structural groups, hierarchies, group types/roles, permission & auto-groups" — README). Phase 0's coverage matrix (`docs/api-coverage.md`) only analyzed the 12 resource types relevant to that structural mandate; nothing else was assessed for CRUD support and nothing else is planned |
| Module-level settings, i18n                                                                                                         | Out of tool scope by design — global instance configuration, not per-resource declarative structure                                                                                                                                                                                                                                       |
| Custom field / master-data field **VALUES on individual person/group records**                                                      | People/record data is the permanent people boundary (`assertNotPeople`). Note: the field **DEFINITIONS** (schema) are **no longer out of scope** — they moved to read-only supported above (#47/#48, [`docs/handbuch/field-definitions.md`](handbuch/field-definitions.md)); only the per-record _values_ stay out of scope.              |

## Forcing ChurchTools to evaluate auto-groups now

**Supported path — `ct refresh` (#105).** `ct apply` writes the ruleset and flips
the status; ChurchTools materializes membership on its **own schedule**, so a
freshly created auto-group is legitimately empty right after a green apply.

```bash
ct refresh --env prod --group <key>   # POST /dynamicgroups/{id}/refresh for one managed group
ct refresh --env prod --all           # …for every managed dynamic group
```

**Manual escape hatch — the legacy scheduler ping. `ct` deliberately never fires
this.** ChurchTools' admin cron page hits:

```bash
curl -s -o /dev/null "https://<host>/?q=cron&standby=true"   # returns a 1×1 image
```

That runs **every due scheduled job on the instance**, not just auto-group
evaluation — calendar syncs, mailings, whatever else is due. Its blast radius is
the whole instance, which is exactly why it stayed out of the tool: `ct refresh`
targets one auto-group at a time and only ever touches groups the config manages.
Reach for the curl only when you need CT's scheduler itself to tick, and know
what else is due when you do.

## Permission catalog lifecycle (regeneration procedure)

**From a consumer repo (#105) — the normal path.** Capture the catalog for the
instance you actually target, and commit it:

```bash
ct permissions catalog --refresh --env prod   # → .ct/permission-catalog.<host>.json
ct permissions catalog --env prod             # which catalog is active, and where it came from
```

Every `ct plan`/`ct apply` against that host then uses it in preference to the
catalog bundled with the `ct` release (and the version-skew warning goes quiet,
since a capture from the target host is authoritative for it). Before this, the
warning told you to run a script that only exists in the ct-cli repo — so it was
unactionable exactly where it was printed, and printed on every single plan.

**In the ct-cli repo (#25) — moving the shipped default forward.** Regenerate
`src/permissions/catalog.json` from a live instance with one command:

```bash
CT_HOST=https://your.church.tools CT_LOGINTOKEN=<token> npm run regenerate:permission-catalog
```

It reads `POST /index.php?q=churchauth/ajax` `func=getMasterData`, flattens
`data.auth_table[module][right]` to
`"module:right" → { authId: id, scopeField: datenfeld, revocable: !!isRevocable, desc: bezeichnung }`,
stamps the instance's CT version into `$meta`, and rewrites the file (read-only
against the instance). Review the `git diff` and commit.

**Staleness signals.** `ct plan`/`ct apply` throw a clear "did you mean" error
for an unknown right _name_ in a config; they now also **warn** (not fail) when
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
this runbook still lists as unavailable.

**The spec is not the whole surface.** This is the defect #111 was filed about:
this procedure used to say "grep the OpenAPI spec", which can only ever discover
REST endpoints — so it was structurally incapable of finding the legacy
`POST /index.php?q=…/ajax` interface the admin UI writes a large amount of master
data through, and yet it concluded "permanent" / "never" on that basis. Bereiche
(#108), person statuses (#96) and security levels (#110) were all recorded as
impossible on evidence that only ruled out REST. `ct` has depended on that same
legacy surface the whole time — the permission catalog is generated from
`POST /index.php?q=churchauth/ajax` `func=getMasterData`
([`src/permissions/README.md`](../src/permissions/README.md)).

So a "no write API" verdict now requires **both** probes, and the third where
neither settles it:

1. **REST probe.** Re-fetch the spec: `npm run generate:client` (writes
   `src/api/schema.d.ts`) or fetch `openapi.json` directly. For each item in the
   no-write-API table, re-check whether its path now has additional methods (grep
   for `/group/memberstatus`, `treffpunkt`/`meetingpoint`, etc.).
2. **Master-data registry probe.** `POST /index.php?q=churchdb/ajax` with body
   `func=getMasterData` returns `data.masterDataTables`: every editable table with
   its label, shortname, physical table name and a full `DESCRIBE`-style column
   list. If the thing you are auditing has a table there (`cdb_bereich`,
   `cdb_status`, `cc_securitylevel`, `cdb_comment_viewer`, …), it **is** writable —
   `func=saveMasterData&table=<t>&id=&col0=…&value0=…` (empty `id` creates) — and
   the item belongs under _Not yet implemented_, not here.
3. **UI capture**, where neither probe settles it: perform the action in the CT
   admin UI with devtools recording, and read what it actually posted. Save the
   request line/body into the item's row.
4. **Record the probe.** Note the date, the CT `version`/`build` from `GET /info`,
   and _which_ probes were run, in the row and in the commit — the way the
   permission-catalog note already does. A reader must be able to tell a verified
   negative from an inherited assumption.
5. If a write path appeared: promote the item — add it to
   `src/resources/registry.ts` (or the relevant synthetic field), extend the DSL,
   add tests, and move its row out of this table.

**Wording rule.** Write what was probed, not what you assume. "No REST write
endpoint (probed 2026-08-13, CT 3.135.2)" is a fact. "Cannot be created",
"permanently", "not a resource at all" are claims that need step 2 (and usually
step 3) behind them — and if the item is unmanaged because we _chose_ that, it
belongs in **Out of tool scope**, phrased as a decision.

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
7. **Field definitions** — read the current schema with
   `ct get person-masterdata` and `ct get data-fields` to confirm the expected
   fields and field groups exist; create/edit any missing _definitions_ by hand in
   the master-data admin UI (no REST write endpoint — see the field-definitions row
   above and [`docs/handbuch/field-definitions.md`](handbuch/field-definitions.md)).
   **Security levels are no longer manual** (#110): declare them
   (`ct.securityLevel({ key, id, name })`) and step 1's `ct apply` creates them at
   the declared ids.
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
  before treating it as unavailable.
- The two remaining rows in the no-write-API table (**group member-statuses**,
  **meeting points**) carry a REST probe but **no master-data-registry probe**
  yet — step 2 of the procedure above postdates them. Until someone runs it,
  read them as "no REST write endpoint", not as "impossible".
