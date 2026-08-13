---
title: Field definitions & security levels
sources:
  - src/commands/get.ts
  - src/api/ctClient.ts
sources_hash: 24ea82f0326ed7d5
reviewed: 2026-08-13
---

# Field definitions & security levels (#47, #48)

`ct` can **read** the structural *schema* that defines what data a person or a
group carries: the person master-data model, the security-level enumeration, and
the data-field definitions ("Datenfelder") for both persons and groups.

## Hard boundary — schema in scope, people never

| In scope (schema / DEFINITIONS)                                              | **Never** (people / records)                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| What fields a person/group *has* (field definitions, types, field groups)   | The **value** of any field on an actual person or group record        |
| The security-level model (levels + what visibility they gate)               | Which persons exist, their memberships, their master-data values      |
| The person master-data model (sexes, titles, statuses, campuses, …)         | Assigning/reading a person's status, sex, campus, etc.                |

> **Exception — person statuses are managed, not just read (#96).** The status
> *enumeration* ("0 - First", "3 - Group Active", …) is a declarable resource:
> `ct.personStatus({ key, name, shorty })`, adoptable with
> `ct adopt person-status <id>` and listable with `ct get statuses`
> (`/statuses`, full CRUD). That is what lets a config declare permission grants
> on a status (`ct.status`) and still stand up on a fresh host. Which *person*
> carries which status remains permanently out of scope, like every other
> per-record value. Campuses are likewise managed (`ct.campus`); the rest of the
> master-data model — sexes, titles, the security-level enumeration — stays
> read-only.

This mirrors the tool's permanent people boundary (README "People are never
managed"; `assertNotPeople` in `src/engine/guard.ts`). The commands below read
*definitions only*; none of them read or write a per-record field value.

## Read commands

```bash
ct get person-masterdata   # the person master-data model incl. the security-level enumeration
ct get data-fields         # all data-field definitions (person + group), one row per field
```

- `ct get person-masterdata` → `GET /person/masterdata`. A single object (not a
  paged list) — the versionable person master-data model. It carries the
  security-level enumeration (`securityLevels`), which is the model the churchdb
  permission scopes reference (`cc_securitylevel`; see [`permissions.md`](permissions.md)).
  This is where **security levels** are surfaced — ChurchTools has no dedicated
  standalone security-levels REST resource; the Persons/Groups master-data module
  is where they are defined, and `/person/masterdata` is its download.
- `ct get data-fields` → `GET /dbfields` (auto-paginated). The **unified**
  data-field definition catalog. Person master-data fields **and** group custom
  fields live in the same list, discriminated per-row by `fieldCategory`
  (`internCode` / `table`, e.g. table `cdb_gruppe` = a group field). Each row
  carries its `securityLevel`, type, sort key, options, and category.

  ```bash
  # person master-data field definitions (#47)
  ct get data-fields | jq '[.[] | select(.fieldCategory.table == "cdb_person")]'
  # group custom field definitions (#48)
  ct get data-fields | jq '[.[] | select(.fieldCategory.table == "cdb_gruppe")]'
  ```

## Writability decision — READ-ONLY (both #47 and #48)

**Field definitions are read-only in `ct`. No registry resource or DSL is added,
and no writability is faked.**

Evidence:

1. **No committed OpenAPI schema to consult.** The brief assumed a committed
   `src/api/schema.d.ts` generated from a live instance, but that file is
   **git-ignored** (`.gitignore`) and generated on demand by
   `npm run generate:client`. It is not in the repo, so the endpoint methods
   below could not be statically verified against this repo's schema. They were
   verified against ChurchTools' own public API-client libraries (5pm-HDH
   `churchtools-api` tested @ CT 3.104, bensteUEM `ChurchToolsAPI` @ CT 3.101)
   and the ChurchTools Academy docs. **Re-verify** against a freshly generated
   schema per the re-audit procedure in `docs/runbook-manual-surface.md`.
2. **The REST field-definition resource is GET-only.** Every public client
   exposes data fields solely as `GET /dbfields` (list) and `GET /dbfields/{id}`
   (by id). No REST `POST`/`PUT`/`PATCH`/`DELETE` on a field-definition path
   exists in any of them.
3. **Mutation is legacy-AJAX only.** Creating/updating/deleting a field
   definition is done through the legacy churchdb admin module
   (`CTChurchDBModule`: `db_insertfields` / `db_updatefields` /
   `db_deletefields`) — the same non-REST legacy surface as the permission
   catalog (`churchauth/ajax func=getMasterData`; see `src/permissions/README.md`).
   The tool deliberately treats that surface as read-reference only and never
   writes it.

Because a declarative `ct plan`/`ct apply` reconciler must own a clean,
idempotent REST write path (`POST` create + item `PUT/PATCH/DELETE`), and none
exists for field definitions, promoting them to a managed registry resource
would mean faking writability through the legacy admin AJAX. That is explicitly
out of bounds. If a future CT release adds REST write endpoints on `/dbfields`
(the OpenAPI spec is self-trimming, so they would appear silently), promote the
resource then — add a `src/resources/registry.ts` entry + DSL + tests — and move
the row out of the read-only section here and in the runbook.

## Endpoint reference

| Purpose                                  | Path                    | Methods (this CT)        | `ct` surface                |
| ---------------------------------------- | ----------------------- | ------------------------ | --------------------------- |
| Person master-data model + security levels | `/person/masterdata`    | GET (read-only)          | `ct get person-masterdata`  |
| Data-field definitions (person + group)  | `/dbfields`, `/dbfields/{id}` | GET (read-only)    | `ct get data-fields`        |
| Field-definition **mutation**            | legacy `churchdb` AJAX (`db_insertfields`/`db_updatefields`/`db_deletefields`) | non-REST | **not managed — manual** |

All paths verified against public CT client libraries + CT Academy docs, **not**
against this repo's (git-ignored, ungenerated) `src/api/schema.d.ts`.
