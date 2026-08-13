# ChurchTools API Coverage — Structure-as-Code CLI (Phase 0 Spike)

Analysis of the ChurchTools OpenAPI spec (`openapi.json`, OpenAPI 3.1.0, 487 paths).

## ChurchTools version

- The spec's own `info.version` is **`0.1.0`** — that is the _API-doc_ version, **not** the CT release.
- The real CT version is exposed by the **`GET /info`** endpoint, whose response schema documents:
  - `version` = "ChurchTools Version", **example `3.123.0`**
  - `build` = "Database Build Version", example `31843`
- **`3.123.0` >> `3.96`**, so the Notion design's requirement that group-hierarchy / metadata CRUD needs **CT v3.96+** is comfortably met on this installation. (The `/info` endpoint is also live, so the CLI can assert the minimum version at runtime.)
- Note: the ChurchTools API doc is self-trimming — `info.description` states it "will always show only those endpoints you can use with your ChurchTools installation." So the presence of the write endpoints below is itself evidence they exist on this version.

## Coverage matrix

Methods marked only if they actually exist on the matched path. "Update" = PUT or PATCH (noted). Collection paths (list/create) vs item paths (`/{id}`) are separated.

| #   | Resource               | Matched path(s)                                                                                                                                                                                | GET (list / by-id)                     | POST (create)                               | PUT/PATCH (update)      | DELETE              | Verdict                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------- | ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ct_campus`            | `/campuses`, `/campuses/{id}`                                                                                                                                                                  | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 2   | `ct_group_type`        | `/group/grouptypes`, `/group/grouptypes/{groupTypeId}`                                                                                                                                         | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 3   | `ct_group`             | `/groups`, `/groups/{groupId}`                                                                                                                                                                 | list ✅ / by-id ✅                     | ✅                                          | ✅ PATCH                | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 4   | `ct_group_hierarchy`   | `/groups/hierarchies` (GET), `/groups/{groupId}/children` (GET), `/groups/{groupId}/parents` (GET), `/groups/{groupId}/parents/{parentGroupId}` (PUT/DELETE)                                   | list ✅ (hierarchies/children/parents) | — (no collection POST)                      | ✅ PUT links a parent   | ✅ unlinks a parent | **Writable** — parent/child edges created & removed via PUT/DELETE on the item path (no POST needed)                                                                                                                                                                                                                                                           |
| 5   | `ct_group_role`        | `/group/roles`, `/group/roles/{roleId}`                                                                                                                                                        | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD** (master-data roles). Per-group assignment lives separately at `/groups/{groupId}/roles` GET + `/groups/{groupId}/roles/{roleId}` PATCH.                                                                                                                                                                                                          |
| 6   | `ct_dynamic_group`     | `/dynamicgroups` (GET), `/dynamicgroups/{groupId}/ruleset` (GET/PUT/DELETE), `/dynamicgroups/{groupId}/status` (GET/PUT), `/dynamicgroups/refresh` & `/dynamicgroups/{groupId}/refresh` (POST) | list ✅ / ruleset & status by-id ✅    | ⚠️ POST only triggers _refresh_, not create | ✅ PUT ruleset & status | ✅ ruleset DELETE   | **Partial** — ruleset is fully updatable/deletable; the group entity itself is created via `/groups` (POST) then given a ruleset. No dedicated create/delete of the dynamic-group record.                                                                                                                                                                      |
| 7   | `ct_permission`        | `/permissions/global` (GET), `/permissions/{domainType}` (GET), `/permissions/{domainType}/{domainId}` (GET/PUT/DELETE); `/permissions/internal/...` (GET)                                     | list ✅ / by-id ✅                     | — (no collection POST)                      | ✅ PUT sets permission  | ✅                  | **Writable** — assign/revoke via PUT/DELETE on `/{domainType}/{domainId}`                                                                                                                                                                                                                                                                                      |
| 8   | `ct_group_status`      | none — see note                                                                                                                                                                                | ❌                                     | ❌                                          | ❌                      | ❌                  | **No REST endpoint at all → manual, permanently (#67).** `/group/memberstatus` looks like a match but is a DIFFERENT dimension — **member** statuses (`{id: "active", name: "Active"}`, STRING ids, assignable per-membership), not group statuses (`groupStatusId`, numeric, e.g. 1 = active / 4 = archived). Live-verified 2026-07-10 on eqrm prod: `/groups/statuses` parses as `/groups/{groupId}` (400), `/group/statuses` and `/groupstatuses` both 404 — no read OR write endpoint for group statuses exists. (`/statuses` + `/statuses/{id}` DO offer full CRUD, but that is the person/community **Status** master data, tag `Status`, a third, unrelated dimension — do not conflate any of the three.) `groupStatusId` stays a plain numeric field on `ct_group`, authored directly — never resolved by name. |
| 9   | `ct_age_group`         | `/group/agegroups`, `/group/agegroups/{ageGroupId}`                                                                                                                                            | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 10  | `ct_target_group`      | `/group/targetgroups`, `/group/targetgroups/{targetGroupId}`                                                                                                                                   | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 11  | `ct_meeting_point`     | — none —                                                                                                                                                                                       | ❌                                     | ❌                                          | ❌                      | ❌                  | **Not in API → fully manual.** Zero matches for `treffpunkt`/`meetingpoint`/`meeting point` anywhere in the spec. Closest neighbours are _meeting templates_ (`/group/meetingtemplates`, full CRUD) and _group meetings_ (`/groups/{groupId}/meetings`, CRUD) — different concepts; confirm with product whether "meeting point" was meant to be one of those. |
| 12  | `ct_relationship_type` | `/person/relationshiptypes`, `/person/relationshiptypes/{id}`                                                                                                                                  | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 13  | `ct_person_status`     | `/statuses`, `/statuses/{id}`                                                                                                                                                                  | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD, live-verified 2026-08-13** (eqrm prod, CT 3.135.2, read from the instance OpenAPI spec): `/statuses` → GET, POST; `/statuses/{id}` → GET, PUT, DELETE. `POST` requires `name`, `shorty`, `isMember`; `PUT` requires ALL of `name`, `shorty`, `isMember`, `isSearchable`, `sortKey`, `securityLevelId` — uniquely strict among managed types (every other managed PUT declares no required fields), and since PUT is a full replace the registry manages all six rather than a subset. The person/community **Status** master data (tag `Status`): "0 - First", "3 - Group Active", …, the domain a `ct.status` permission grant hangs off. Adoptable since #96, which is what makes a config using that domain self-sufficient across hosts. Do NOT conflate with `ct_group_status` (row 8, no endpoint at all) or `/group/memberstatus` (member statuses, string ids). Master data — never a person record; the people guard is unaffected. |
| 14  | `ct_department`        | `/departments`                                                                                                                                                                                 | list ✅ / by-id ❌                     | ❌                                          | ❌                      | ❌                  | **Read-only — a ref catalog, not a managed resource.** Live-probed 2026-08-13 (eqrm prod, CT 3.135.2): `GET /departments` returns `[{id, name, nameTranslated, sortKey, shorty}]`; no `POST`/`PUT`/`DELETE` on `/departments` exists in the spec, and there is no `/departments/{id}` path at all. Bereiche are the `cdb_bereich` permission scope dimension (`churchdb:view alldata`), so `ct` resolves them BY NAME for a `scope: [{ department: "…" }]` reference (#98) and surfaces them via `ct get departments` — but they can never be declared, adopted or created. |

> **Create-time required fields (#73).** The "POST ✅" marks above were spec-derived, not live-exercised for
> create. CT's POST validators require fields the tool does not manage for diffing: `group-type` needs
> `namePlural`/`shorty`/`color`/`permissionDepth`/`isLeaderNecessary`/`availableForNewPerson` (+ `sortKey`/`postsEnabled`),
> and `group-role` + `person-status` need `shorty`. These are supplied as deterministic create-only defaults
> (`AdoptableResource.createDefaults`, derived from the declared `name`) — merged into the POST body only, never
> recorded in state, so they stay unmanaged. `campus` (name+shorty, live-verified), `group`, `age-group`, and
> `target-group` need only `name` from their managed set and require no defaults.

## MVP recommendation

### Fully writable now (ship CRUD in the MVP) — 7 resources

Standard collection-POST + item-GET/PUT(-or-PATCH)/DELETE shape, safe to drive from the CLI:

- `ct_campus`
- `ct_group_type`
- `ct_group` (update is PATCH, not PUT)
- `ct_group_role`
- `ct_age_group`
- `ct_target_group`
- `ct_relationship_type`
- `ct_person_status`

### Writable via non-standard verbs (support, but special-case the client) — 2 resources

No collection POST; state is set/removed through PUT/DELETE on the item path. Model these as "declare desired edge/assignment, reconcile via PUT/DELETE":

- `ct_group_hierarchy` — manage parent links via `PUT`/`DELETE /groups/{groupId}/parents/{parentGroupId}`
- `ct_permission` — assign/revoke via `PUT`/`DELETE /permissions/{domainType}/{domainId}`

### Partial — 1 resource

- `ct_dynamic_group` — ruleset & status are updatable (`PUT`) and ruleset deletable (`DELETE`), but the group record is created through `/groups`. Treat as: create shell group via `ct_group`, then manage its ruleset. No first-class create/delete of the dynamic-group entity.

### Read-only / not in API → keep manual for now — 2 resources

- `ct_group_status` — **no REST endpoint at all, read or write** (#67; corrected 2026-07-10 — a prior version of this table wrongly matched `GET /group/memberstatus`, which is actually **member** statuses, a different dimension with string ids). `groupStatusId` remains a plain numeric field. (Do not substitute `/statuses` either — that's person-status master data, a third dimension.)
- `ct_meeting_point` — **no endpoint at all**; cannot be automated until CT ships one (or until "meeting point" is redefined onto meeting-templates/meetings, both of which are full CRUD).

### Version gate

The installation reports **CT `3.123.0`** via `/info`, so every write endpoint above is available and the v3.96+ hierarchy/metadata requirement is satisfied. Recommend the CLI call `GET /info` on startup and hard-fail below `3.96.0`.

## Addendum — field definitions & security levels (#47, #48)

Not part of the Phase 0 structural matrix above; audited separately for the
field-definition schema surface. **Caveat:** unlike the Phase 0 matrix (audited
against a live `openapi.json`), these were verified against ChurchTools' public
API-client libraries (5pm-HDH `churchtools-api` @ CT 3.104, bensteUEM
`ChurchToolsAPI` @ CT 3.101) and CT Academy docs, because this repo's generated
`src/api/schema.d.ts` is git-ignored and was not available offline. Re-verify per
the runbook's re-audit procedure once the schema is regenerated.

| Resource                          | Matched path(s)                | GET               | POST/PUT/PATCH/DELETE | Verdict                                                                                                                                                        |
| --------------------------------- | ------------------------------ | ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person master-data model          | `/person/masterdata`           | ✅ (single object) | ❌                    | **Read-only.** Versionable master-data model incl. the `securityLevels` enumeration. No write endpoint (edited in the CT master-data admin UI).                |
| Data-field definitions (Datenfelder) | `/dbfields`, `/dbfields/{id}` | list ✅ / by-id ✅ | ❌                    | **Read-only.** Unified person + group field definitions, discriminated by `fieldCategory`. Mutation only via legacy churchdb AJAX (`db_insert/update/deletefields`), not REST. |

See [`docs/handbuch/field-definitions.md`](handbuch/field-definitions.md) for the full writability
decision, evidence, and the schema/values boundary.
