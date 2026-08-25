---
title: Permissions
sources:
  - src/permissions/**
  - src/reports/permissions/**
  - src/commands/report.ts
  - src/resolve/resolver.ts
  - src/resolve/refs.ts
  - src/config/context.ts
sources_hash: eaea3f87de51a46f
reviewed: 2026-08-25
---

# Permissions (`ct.groupRole` / `ct.groupTypeRole` / `ct.status`)

## Vollständiger Rechte-Report

Der Permission-Report dokumentiert den vollständigen Live-Rechtebestand der
ChurchTools-Instanz. Er ist ein reines Reporting-Werkzeug und steht deshalb
unabhängig von deklarierbaren Grants und `ct adopt grants`.

```bash
ct report permissions --by-subject reports/permissions-by-subject.md
ct report permissions --by-object reports/permissions-by-object.md

# Beide Reports aus demselben Live-Datensatz:
ct report permissions \
  --by-subject reports/permissions-by-subject.md \
  --by-object reports/permissions-by-object.md

# Ohne Dateinamen entstehen permissions-by-subject.md und permissions-by-object.md:
ct report permissions --by-subject --by-object

# Ein Basispfad erzeugt zwei Dateien mit passenden Suffixen:
ct report permissions --by-both reports/permission-report.md
# → reports/permission-report_by-subject.md
# → reports/permission-report_by-object.md
```

`subject` beantwortet „Was darf dieses Subjekt?“ und gruppiert Subjekte mit
identischem vollständigem Rechte-Set unter einem stabilen Hash. Der Hash ist
kein Subjekt-Identifier. Seine Identität besteht aus `authId`, Objektdimension,
Objekt-ID, den zugehörigen Rechte-/Objektnamen und Grant/Revoke. Gleich benannte
Objekte mit verschiedenen IDs bleiben dadurch verschieden; ebenso erzeugt eine
Umbenennung bewusst einen neuen Report-Hash. Bekannte Status (`ST`) und
Gruppentyp-Rollen (`GTRL`) erscheinen auch ohne eigene Zuweisung unter „Keine
Berechtigungen“. So werden erwartete Status oder Rollen ohne direkte Rechte als
Berechtigungslücke sichtbar, statt stillschweigend aus dem Report zu
verschwinden. Eine leere Rechte-Menge erhält bewusst keinen Fingerprint.
Personen (`PRS`) und konkrete Gruppenrollen (`GRRL`) werden dagegen nur
aufgeführt, wenn mindestens eine direkte Permission existiert: Alle leeren
Personen und Rollenpaarungen aufzulisten würde die relevanten Lücken zwischen
tausenden bedeutungslosen Zeilen verstecken. Über Status oder Rollen geerbte
effektive Personenrechte werden nicht zu einem synthetischen
Personen-Rechte-Set verrechnet. Innerhalb einer Hash-Gruppe werden die Rechte
nach `authId`, Rechtename, Grant/Revoke und Objekt sortiert und exakte
Dubletten fallen weg. Der Report ist damit unabhängig von der Zeilenreihenfolge
der API und zwischen zwei Läufen diff-stabil. `object` beantwortet „Wer darf
auf dieses Objekt was?“ und sortiert vorhandene Subjekttypen fest nach Status,
Gruppentyp, Gruppe und Person.

Objektbezeichnungen werden verlustfrei übernommen und insbesondere nicht
getrimmt. Das ist fachlich relevant, weil ChurchTools zwei Objekte mit
unterschiedlichen IDs führen kann, deren Namen sich nur durch unsichtbaren
Whitespace unterscheiden. Der Report soll diesen Live-Zustand zeigen und nicht
stillschweigend bereinigen.

Der Report liest auch direkte Personenrechte sowie Rechte auf Dimensionen, die
`ct adopt grants --all-declarable` bewusst nicht verwalten kann, zum Beispiel
Wiki-/Kalenderkategorien, Servicegruppen und OAuth-Objekte. Er verändert weder
ChurchTools noch State oder Config.

Declare ChurchTools permission grants — group-role, group-type-role and
person-status rights — as code, and reconcile them idempotently with the same
`ct plan` / `ct apply` workflow used for structural resources (issue #13).

## The three DSL functions

```ts
export default (ct) => {
  ct.groupTypeRole({
    key: "leiter_tpl", // logical key (unique across the whole config)
    groupType: "ministry_team", // domain BY NAME — resolved to the domainId per host (#20)
    grants: [
      "churchgroup:view group", // unscoped
      { right: "churchgroup:view group", scope: ["kids_area"] }, // scoped
    ],
  });

  ct.groupRole({
    key: "kids_lead_grant",
    group: "kids_area", // domain BY (group, role) — resolved to the pairing domainId per host (#25)
    role: "Leiter", // (or keep the numeric escape hatch: `id: 2882`)
    // "edit group memberships of group" is a scoped right, so it takes a `scope: [...]`.
    grants: [{ right: "churchgroup:edit group memberships of group", scope: ["kids_area"] }],
  });

  ct.status({
    key: "core_external_login",
    personStatus: "5 - Core", // domain BY PERSON-STATUS NAME — resolved against /statuses (#90)
    // -1 is ChurchTools' "all values of this dimension" sentinel (here: every external system).
    grants: [{ right: "churchcore:login to external system", scope: [-1] }],
  });
};
```

All three take `{ key, <domain>, grants }`, where `<domain>` is either a logical
reference or a numeric `id`:

- **`key`** — the logical key, unique across the whole config (shared
  namespace with every other resource type).
- **domain** — the permission domain object. Declare it **by reference** (the
  portable form, #20) or **by numeric `id`** (the escape hatch):
  - `ct.groupTypeRole` — `groupType: "<name>"` resolves against the live
    group-type catalog per host, or `id: <domainId>` targets one directly.
  - `ct.groupRole` — `group: "<key>", role: "<name>"` resolves the (group,
    role) pair to its pairing domainId per host (#25), or `id: <domainId>`
    targets one directly. The group must be **managed** (declared via `ct.group`
    or adopted into state); it need not exist on the host yet — a group declared
    in the same config plans as a pending domain and is granted later in that same
    `ct apply`, once it exists (#106). Declaring both a logical form and a numeric
    `id` is a conflict and throws.
    See "domainId semantics" for how the pairing id is resolved.
  - `ct.status` — `personStatus: "<name>"` resolves against the live
    `/statuses` catalog per host, or `id: <statusId>` targets one directly.
    **Person** statuses ("0 - First", "3 - Group Active", …), not group statuses
    — see "domainId semantics".
- **`grants`** — an array of `Grant`s, each either:
  - a bare string, `"module:right"` — an **unscoped** grant, or
  - an object `{ right: "module:right", scope: [...] }` — a **scoped** grant,
    where each `scope` entry is a logical key of a managed group, a typed
    logical reference such as `{ campus: "koblenz" }` (#98), or a raw numeric
    `dataId` (the escape hatch, #49). See "Scope resolution" below.

## Discovering right names — `ct get permissions-catalog`

Right names are validated against a static, offline catalog (`module:right` →
`authId`), because the name↔authId mapping is not exposed by the ChurchTools
REST API (see `src/permissions/README.md` for how it was captured). List it:

```bash
ct get permissions-catalog
# churchgroup:view group -> 1104 (scoped)
# churchcore:administer settings -> 1 (unscoped)
# ...
```

Each line shows the name, its numeric `authId`, and whether it's `scoped`
(accepts a `scope: [...]` — i.e. the catalog entry has a non-null
`scopeField`) or `unscoped`. An unknown name throws a clear error at
**plan/apply time** — inside `desiredTuples` (`src/permissions/plan.ts`),
when grants are resolved to tuples against the catalog, after the authed
fetch — with a "did you mean" hint drawn from same-module names. (Config
evaluation only checks a grant's _shape_: `module:right` string or
`{ right, scope }`; it does not resolve the name against the catalog.)

## Catalog lifecycle & staleness (#25)

The catalog (`src/permissions/catalog.json`) is a snapshot of one instance's
permission master data, captured at a specific ChurchTools version. Two things
keep it honest:

**Refresh it for YOUR instance — `ct permissions catalog --refresh` (#105).**
This is the one to reach for from a consumer repo. It captures the catalog from
the instance you are targeting and writes it beside your config:

```bash
ct permissions catalog --refresh --env prod   # → .ct/permission-catalog.<host>.json
ct permissions catalog --env prod             # show which catalog is active, and where it came from
```

**Commit that file.** Every subsequent command that needs to know what a right
_is_ — `ct plan`, `ct apply`, `ct coverage`, `ct adopt grants` — loads it in
preference to the catalog bundled with the `ct` release, and says so in its
header (`permission catalog: .ct/permission-catalog.<host>.json`). They all load
it, and all load it before evaluating your config, so no two of them can disagree
about the same right on the same host. A repo that never runs the refresh is
unaffected — the bundled catalog stays the fallback.

This exists because the bundled catalog is a snapshot of **one** instance's
ChurchTools version, and the staleness warning below used to tell you to run a
script that only exists in the ct-cli repo. A consumer repo could not act on its
own warning short of opening a PR upstream and waiting for a release.

**Regenerating the BUNDLED catalog (ct-cli maintainers).** Inside this repo, to
move the shipped default forward:

```bash
CT_HOST=https://your.church.tools CT_LOGINTOKEN=<token> npm run regenerate:permission-catalog
```

Both paths read the same source: the legacy `POST /index.php?q=churchauth/ajax`
`func=getMasterData` endpoint, the only place the name↔authId map is exposed
(see `src/permissions/README.md`). Both perform a single **read**; neither
writes to the instance. Review the `git diff` before committing either file.

**Staleness & unknown rights — `ct plan` warns (never fails).** `$meta.ctVersion`
records the version the catalog was captured from. On every `plan`/`apply`:

- If the live instance's CT version differs from `$meta.ctVersion`, `ct plan`
  prints a warning — right names/authIds/scopeFields may have drifted; capture
  one for this instance to be sure. A per-instance capture is authoritative for
  its host **at capture time, not forever**: the instance gets upgraded while the
  committed file does not, so the comparison still runs against a capture, and
  the warning then asks you to _re-capture_ rather than to capture.
- If a **live grant carries an `authId` the catalog cannot name** (a stale or
  foreign right), `ct plan` names the `authId` + domain and **leaves the grant
  untouched** — it is deliberately kept _out_ of the diff so `ct apply` never
  revokes a right it cannot even describe. This is idempotent: the unknown row
  is excluded every run, so it neither churns nor silently disappears.

Both are warnings, not errors: the plan still runs and the exit code stays
success. `ct permissions catalog --refresh` is the fix for both.

## `domainId` semantics

The two DSL functions manage two different ChurchTools "domain types," and
`id` means something different for each:

- **`group_type_role`** (`ct.groupTypeRole`) — the domain is the **group type's
  own id** (the same id you'd pass as `groupTypeId` on `ct.group`). It scopes the
  grant to "every role holder of this group type." Declare it portably as
  `groupType: "<name>"` (resolved per host, #20) or directly as `id: <domainId>`.
- **`group_role`** (`ct.groupRole`) — the domain is the **internal
  (group, role) pairing's own id** — a ChurchTools-internal id for one
  specific group's specific role, _not_ the group's id and _not_ the role's
  id. Declare it portably as `group: "<key>", role: "<name>"` (resolved per
  host, #25) or directly as `id: <domainId>`.
- **`status`** (`ct.status`) — the domain is a **person status's own id**
  (`GET /statuses`: `0 Unbekannt`, `1 0 - First`, …). A grant here applies to
  **every person carrying that status**, which makes it the only instance-wide
  lever CT offers short of granting per person — and people domains are
  permanently out of scope (`src/engine/guard.ts`). Declare it portably as
  `personStatus: "<name>"` (#90) or directly as `id: <statusId>`. Note `id: 0`
  is a real, declarable domain ("Unbekannt"), so the numeric guard is a type
  check, not a truthiness one.

  > **Person status ≠ group status.** `groupStatusId` (`ct.group`) is a
  > different dimension with **no** REST catalog at all (#67) and must always be
  > written as a number. Person statuses do have one (`GET /statuses`, flat
  > array of `{id, name}` — live-verified 2026-08-10 on eqrm prod), so they
  > resolve by name like campuses and group types.

  Since #96 the status itself is also **declarable**, via `ct.personStatus`:

  ```ts
  ct.personStatus({ key: "3_group_active", name: "3 - Group Active", shorty: "GA" });
  ct.status({ key: "3_group_active_login", personStatus: "3_group_active", grants: [...] });
  ```

  **Key it as `slug(name)`.** A `personStatus:` reference resolves against
  managed state first and the live `/statuses` catalog second, and the catalog
  matches by `slug(name)` — so a key that does not slug from the name (`"core"`
  for `"5 - Core"`) can only ever match the declaration. On a host that already
  has that status but has not adopted it, the plan then **creates a second,
  identically-named status** and grants on the new one, leaving the real one
  untouched. `ct adopt person-status <id>` emits `slug(name)` for this reason;
  match it.

  > **Teardown caveat.** A person status is the one managed type whose deletion
  > reaches person _records_: dropping the declaration and running `ct destroy`
  > deletes the status, and ChurchTools re-stamps every person carrying it.
  > `assertNotPeople` cannot catch this (`/statuses/{id}` is not a people path),
  > so `ct destroy` warns explicitly for this type and `--force` does **not**
  > skip its confirmation. Set `preventDestroy: true` on the declaration if the
  > status is load-bearing.

  That is what makes a config using the `status` domain self-sufficient across
  hosts. Before it, `personStatus: "…"` could only resolve against statuses that
  already existed on the target instance, so a config that planned to a clean
  no-op on prod died on dev with _"no managed resource and no live person-status
  at /statuses matches key …"_ — whose own advice ("Declare/adopt it") was not
  actually possible. A status declared in the same config resolves to a pending
  domain and converges in one `ct apply`, exactly like a same-run group type.

  > **VERIFIED LIVE (2026-08-13, CT 3.135.2).** The reference form resolves by
  > reading the group's own role list (`GET /groups/{groupId}/roles`) and taking
  > the matched role row's `id` as the pairing domainId. Confirmed against two
  > anchors on **different group types**, each chosen so the per-group `id` and
  > the type-level `groupTypeRoleId` necessarily differ:
  >
  > - both role rows' `id`s appear in `GET /permissions/group_role` as live
  >   `domainId`s carrying that role's authored grants;
  > - neither row's `groupTypeRoleId` appears anywhere in the domainId set —
  >   decisive, since a type-scoped key would have to;
  > - roles with no authored rights have no domain at all, exactly as a
  >   per-(group, role) pairing predicts.
  >
  > The numeric `id:` escape hatch remains fully supported: find the id via the
  > ChurchTools permission editor or a `GET /permissions/group_role` response and
  > hardcode it like any other domainId.

Resolution runs in `buildPermissionPlan` (`src/permissions/plan.ts`): a numeric
`id` passes straight through; a `groupType` reference resolves against the live
catalog, and a `group` + `role` pair against the group's role list. After
resolution, two declarations that resolve to the **same** `(domainType,
domainId)` are rejected (they would otherwise diff against each other's grants
forever) — even if one used a name and the other a raw id.

### Domains created in the same run (fresh-instance rehearsal, #69)

When a `groupType` reference names a group type that is **created in this same
run** (empty/partial state — the type is part of the create-set), the domain is
handled as a **pending domain** rather than aborting the plan:

- `ct plan` renders the grant block with a
  `<group-type:<key> (created this apply)>` marker (consistent with resource
  pending refs, #20/#46) and counts its grants in `--json`
  (`domainId: null` + a `pendingDomain` reference) and toward exit code `2`.
- `ct apply` runs permission reconciliation **after** the resources are
  created, re-resolving the domain id from the fresh group type and granting in
  the same run — so a single `ct apply` converges fully. This reuses the same
  re-resolution machinery as resource pending refs.
- The hard error (`references a resource created in the same run` → now only a
  genuine unresolvable) is reserved for references that resolve to **nothing**:
  a key absent from the config, state, and the live catalog (a typo).

**`group_role` behaves the same way since #106.** A `group_role` domain id is
the (group, role) **pairing** id, which only exists on
`GET /groups/{groupId}/roles` — so completing it needs a _live fetch_ after the
group exists, not just a post-execute state lookup. `ct apply` does exactly
that: `executePlan` creates the group, then permission reconciliation reads the
new group's own role list, matches the declared `role` name, and grants on the
resulting pairing id — one run, no second merge.

- `ct plan` renders the domain as
  `<group-role(group=<key>, role=<name>) (created this apply)>`, the same
  pending marker every other deferred reference uses.
- A `role` name that is nowhere to be found — not on the group, and not
  declared as a `roleDefinition` in this config — is still a **hard error**,
  listing the roles the group does have.
- Nothing changes on a host where the group already exists and already has the
  role: the domain resolves to a concrete pairing id at plan time, as before.

**The ROLE half goes pending too, since #120.** #106 covered the case where the
_group_ is missing; the mirror case is a `ct.groupRole` naming a role that this
host does not have yet but the config **declares as a `ct.roleDefinition`**.
That used to hard-error even though the role was declared a few lines above,
with a message ("Fix the role name, or pass a numeric id") whose two remedies
are both wrong for a shared config: the name is right, and a numeric id is
host-specific, which is the very thing the logical form exists to avoid.

Now the domain resolves as pending and completes in the same run. Role
definitions are **tier 3**, which executes before permission reconciliation, so
by the time the pending domain is finished the role is already on the group's
role list and the grant lands on its fresh pairing id.

The declaration has to be for **this group's group type**, not merely for a role
of the same name. Role names repeat across group types — live prod carries three
`Leiter`, six `Organisator` and six `Mitglied`, each on a different type — so a
name match alone would read a genuine mistake (a `ct.groupRole` on a group whose
type has no such role, next to a `roleDefinition` for some other type) as
"pending", and defer the failure past `executePlan` to the post-apply fetch. It
fails there with the same message, but only after resources have been written;
matching the group's own `groupTypeId` keeps it a **plan-time** error.

Where the answer is not knowable offline the pending path is kept: a
`roleDefinition` that states no group type, or a group whose state entry does
not record `groupTypeId` (adopted before it was managed). The check only ever
turns a would-be pending back into the hard error it used to be, and only on
positive evidence.

Creating a role definition also needs fields CT validates but the tool does not
otherwise diff (#121). `ct` supplies them at **create only**, so they are never
diffed or reverted afterwards:

| Field       | Sent as                  | Notes                                          |
| ----------- | ------------------------ | ---------------------------------------------- |
| `shorty`    | the declared `name`, ≤10 | required, 1–10 chars                           |
| `type`      | `"participant"`          | **declarable** — `"leader"` or `"participant"` |
| `isDefault` | `false`                  | create default                                 |
| `isHidden`  | `false`                  | create default                                 |
| `sortKey`   | `0`                      | create default; every stock role uses `0`      |

All four non-`shorty` fields are genuinely required: verified live on eqrm-dev
(CT 3.135.2), where a POST without them is rejected with one validation error
each. `isLeader` is deliberately **not** sent — ChurchTools derives it from
`type`, and a role created with `type: "leader"` reads back `isLeader: true` on
its own.

`type` is the one that is a real semantic choice — does holding this role make
you a _leader_ of the group? — so it is declarable and defaults to the
conservative half:

```js
ct.roleDefinition({
  key: "appmodule_admin",
  name: "Admin",
  nameTranslated: "Admin",
  groupType: "appmodule",
  type: "leader", // optional; defaults to "participant"
});
```

An invalid value is rejected when the config loads, not as an HTTP 400 halfway
through an unattended apply.

This matters because role definitions are **per group type**, and that is
exactly the master data that drifts between two hosts of one instance — one
host has `Read`/`Admin`/`Write` on a type where the other only ever had CT's
stock roles. Bringing the second host into line is precisely when a `groupRole`
first names a role the host lacks.

Until #106 this was a hard error, and that made a config **non-portable by
construction**: declaring a group and a grant on its own role planned clean on
prod (where the group existed) and exited 1 on dev (where it did not), so one
logical change had to be split across two merges.

## Scope resolution

A scoped grant's `scope: [...]` is a list where each entry is one of three
forms (`src/permissions/scope.ts`):

| Form                                         | Example                          | Dimension                         |
| -------------------------------------------- | -------------------------------- | --------------------------------- |
| **Logical group key** (string)               | `scope: ["kids_area"]`           | groups (`cdb_gruppe`) only        |
| **Typed logical reference** (#98)            | `scope: [{ campus: "koblenz" }]` | campuses, group types — see below |
| **Raw numeric `dataId`** (escape hatch, #49) | `scope: [1, 2, 3]`               | any dimension                     |

String entries are resolved against **desired ∪ state**:

- A key already in state resolves to that group's `dataId`.
- A key **declared in this config but not yet created** resolves to a _pending_
  target: the plan renders it as `scope=[<key> (created this apply)]`, and its
  real `dataId` is filled in at apply time — so a config can declare a group AND
  a grant scoped to it and still plan/apply in one run (no bootstrap deadlock).
- A key that is neither in state nor declared throws:

  ```
  Scope key "kids_area" does not resolve to a managed group. Declare/adopt it,
  use a group already under management, or pass a raw numeric dataId if this
  right's scope is not a group (see the catalog's scopeField).
  ```

The requirement that scope targets be tool-visible is deliberate: so `ct plan`
can show what a grant resolves to, and so renaming/re-keying a group doesn't
silently orphan a grant's scope.

**Re-resolution at apply time.** Every scoped tuple resolved from a logical
group key retains its symbolic scope key. Immediately before grants are
written (after the resource tier has run), each key is re-resolved against the
post-execute state. This means a group _created_ or _recreated_ in the same
apply always gets its grant written with its fresh `dataId`, never a pending
placeholder or a stale, dangling id.

### Typed logical scope references (#98)

Not every scoped right scopes **by group**, and some of the other dimensions are
resources this tool _can_ name portably. Those take a typed reference:

```ts
ct.groupRole({
  key: "campus_lead_grants",
  group: "campus_lead",
  role: "Leiter",
  grants: [
    { right: "churchdb:view station", scope: [{ campus: "koblenz" }] },
    { right: "churchgroup:view groups of grouptype", scope: [{ groupType: "struktur" }] },
  ],
});
```

`{ campus: "koblenz" }` is sugar for `ref.campus("koblenz")` — the same `Ref`
the rest of the DSL uses — so both spellings are interchangeable.

| `scopeField`         | Reference form                            | Resolved against                                                  |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `cdb_gruppe`         | `{ group: "<key>" }` (or the bare string) | managed groups                                                    |
| `cdb_station`        | `{ campus: "<key>" }`                     | managed campuses, then `GET /campuses`                            |
| `cdb_gruppentyp`     | `{ groupType: "<key>" }`                  | managed group types, then `GET /group/grouptypes`                 |
| `cdb_bereich`        | `{ department: "<name-slug>" }`           | managed Bereiche, then `GET /departments` (#108)                  |
| `cc_securitylevel`   | `{ securityLevel: "<name-slug>" }`        | managed security levels, then `GET /securitylevels` (#110)        |
| `cdb_comment_viewer` | `{ commentViewer: "<name-slug>" }`        | managed comment viewers, then `GET /person/commentviewers` (#151) |

Two `Ref` kinds are deliberately **not** in that table because no permission
dimension scopes by them: `group-type-role` (a `groupTypeRoleId`, addressed by
its `(group type, role name)` pair — #76) and `group-member-field` (a
group-scoped member-field definition, addressed by its portable
`(group key, local field key)` pair — #135). They share this file's resolver and
its "managed state first, then live lookup, else a hard error at plan time"
rules, but they are referenced from **dynamic-group rulesets**, not from grant
scopes. See [Group member fields](group-member-fields.md).

**Why this matters:** campus ids are host-specific — Mainz is `0` on eqrm prod
and `6` on eqrm dev. A campus-scoped grant written as a numeric literal is
therefore a cross-environment misgrant, and because declaring a domain makes
`ct` _own_ it, the wrong-scope grant also revokes whatever is really there on
the other host. The typed reference makes one config plan clean on both.

Resolution mirrors the domain-reference rules: managed state first, the live
master-data catalog second, and a target **declared in this same config**
resolves to a _pending_ scope re-resolved at apply time. A reference resolved
through the catalog (not under management) carries an already-final id and is
not re-resolved. Catalogs are read **paginated** — ChurchTools returns only a
first page (10 rows) for a plain list read, so an instance with more campuses,
group types or departments than that would otherwise report a perfectly real
name as unresolvable.

Three things are hard errors at **plan** time, never a guessed `dataId`:

- a reference whose dimension does not match the right's `scopeField` —
  e.g. `{ groupType: … }` on `churchdb:view station` (a `cdb_station` right);
- a reference on a dimension that has **no** logical form yet
  (`ccm_data_category`, `oauth_client`, `cc_calcategory`, … — mostly dimensions
  of modules outside this tool's mandate) — the message points at the numeric
  escape hatch;
- a **bare string** on a non-group dimension. A string always means "managed
  group", so on e.g. a `cdb_station` right it would either fail confusingly or —
  worse — match an unrelated group that happens to carry that key.

### Comment viewers: the last catalog-only dimension (#151)

`cdb_comment_viewer` (Kommentare-Viewer) had a reference form since #102 but no
declaration behind it, and that combination turned out to be the worst of both
worlds. Every other option was worse still:

- a **raw `dataId`** is host-specific. Read on two hosts of the same deployment
  on 2026-08-24, three of the six viewer ids on one host did not exist on the
  other at all, and the two ids present on both named _different_ categories on
  each. An apply duly wrote a grant pointing at nothing, and nothing caught it —
  `ct plan` compares the declared id against the live id, and they match; the id
  is simply meaningless on the target host.
- a **name reference** did not rescue it, because the second host was missing the
  NAMES as well. The reference hard-errored instead of resolving wrongly — safer,
  but still not a config that applies to both hosts.
- **creating the viewers by hand** on each host is unmanaged master data, which
  is the thing this tool exists not to need.

So comment viewers are a managed resource now:

```ts
ct.commentViewer({ key: "dienstbereich", name: "Dienstbereich", sortKey: 40 });
...
{ right: "churchdb:view comments", scope: [{ commentViewer: "dienstbereich" }] }
```

Declaring the viewer is what makes the NAME exist on both hosts, which is what
makes the reference portable — a name reference is only worth anything once
something guarantees the row is there.

- **`ct adopt comment-viewer <id>`** puts an existing viewer under management and
  emits the declaration; `ct get comment-viewers` lists the names.
- **`/person/commentviewers` is conventional REST** (`[{id, name, sortKey}]` plus
  POST/PUT/DELETE), so this type needs none of the special machinery the other
  two awkward master-data types did: ChurchTools mints the id (unlike a security
  level) and the writes are REST (unlike a Bereich).
- **Resolution is managed-state first, live catalog second.** An existing
  reference to a viewer your config does not own keeps resolving exactly as it
  did in #102, and a name that matches nothing anywhere is still a hard error
  rather than a create:

```
Cannot resolve comment-viewer:nope referenced at … : no managed resource and
no live comment-viewer at /person/commentviewers matches key "nope".
Declare/adopt it, fix the key/name, or use a numeric id.
```

- **`ct apply` never deletes**, as everywhere else. `ct destroy` can, and warns:
  deleting a viewer reaches every person comment restricted to it and every grant
  scoped to it.

With this, every scope dimension `ct` can name is also one it can declare —
Bereiche left the catalog-only list in #108, security levels in #110, and comment
viewers here. What remains numeric-only (`ccm_data_category`, `oauth_client`,
`cc_calcategory`, …) belongs to modules outside this tool's mandate.

### Bereiche: managed, but written through a non-REST endpoint (#108)

Bereiche have **no REST write verb** — live-probed against the instance's own
OpenAPI spec (eqrm prod CT 3.135.2, 2026-08-13; re-probed on eqrm-dev
2026-08-14): `GET /departments` exists, nothing else on that path does. The CT
admin UI creates them through the legacy master-data endpoint
(`POST /index.php?q=churchdb/ajax`, `func=saveMasterData`), which appears in no
OpenAPI spec — which is exactly why an OpenAPI-only audit concluded for months
that a Bereich "can never be created" (#111).

`ct` drives that endpoint now, for this one table:

```ts
ct.department({ key: "equippers_koblenz", name: "Equippers Koblenz", shorty: "EQKO" });
```

- **Reads stay REST.** `GET /departments` remains the only read path — cleaner,
  paginated, already wired. Only writes take the legacy route.
- **Columns are validated against the instance's own schema.** The registry
  describes each table's columns, and a declared field the instance does not
  report is a hard error. This matters because the legacy endpoint does not 400
  on an unknown column — it ignores it, so an unvalidated write would look like a
  success and silently drop the field.
- **`ct apply` never deletes**, as everywhere else. `ct destroy` can, and warns:
  a Bereich delete reaches every person assigned to it and every grant scoped to
  it.

This is the only table `ct` writes through the legacy endpoint. A live
classification of all 24 tables in the registry (eqrm-dev, 2026-08-14) found 15
with a REST write path — REST stays authoritative for every one of them — and of
the 9 without, 8 are person master data or field option lists outside this tool's
mandate. Bereiche were the only table both in-mandate and REST-less.

### Security levels: a managed resource with a declared id (#110)

Security levels were treated as _numeric-universal_ for a long time:
`scope: [1, 2, 3]` was considered portable because the ids "mean the same thing
on every instance". They do — **by convention**. `cc_securitylevel` is an
admin-editable table with an auto-increment id and a `sortkey`, and reordering is
not even an edge case: `PATCH /securitylevels/{id}` takes `newid` +
`forcereorder`, i.e. CT ships renumbering as a supported operation. So someone
adding or reordering a level on one host silently changes what a hard-coded
`[1, 2, 3]` grants there, with a green plan.

Two things address that, and you can use either:

**1. Reference a level by name.** `{ securityLevel: "stufe_3_hoch" }` resolves
against managed levels first, then `GET /securitylevels`. The trade-off: names
are localised German strings (`"Stufe 3 (Hoch)"` → `stufe_3_hoch`), so a
**rename** breaks a reference where a number would have survived.

**2. Declare the levels themselves**, which makes the numeric form portable too,
because the config now owns the ids:

```ts
ct.securityLevel({ key: "stufe_3_hoch", id: 3, name: "Stufe 3 (Hoch)" });
```

`id` is **required** here — a declaration without one, or with a string `"3"`
instead of the number `3`, is rejected when the config is evaluated, before any
request goes out — and it is the only declaration where you choose the id.
ChurchTools creates a level with `POST /securitylevels/{id}` — the client picks
the id, CT 409s if it is taken — precisely so a level is reproducible rather than
whatever a fresh instance auto-increments to. Live-probed on eqrm-dev 2026-08-14:
creating id 99 next to levels 1–4 left 1–4 untouched and set `sortkey` to the id,
so an insert does **not** implicitly renumber.

Two guard rails:

- **Changing a declared `id` is refused at plan time.** That is a renumber, not a
  field update, and it rewrites what every numeric `cc_securitylevel` scope on the
  instance grants. `ct` does not drive `newid`/`forcereorder`; do it in the admin
  UI deliberately and update the config to match.
- **`ct destroy` warns.** Deleting a level reaches every person field
  (`securityLevelId`) and every grant scoped to it. Same treatment as person
  statuses.

### Numeric scope escape hatch (#49)

Not every scoped right's `scope` dimension is a **group**. The catalog's
`scopeField` names the actual ChurchTools data-field a scoped right applies
to (`src/permissions/catalog.json`) — for most scoped rights that field is
`"cdb_gruppe"` (a group), but some rights scope by something else entirely,
e.g.:

- `churchdb:view comments` → `scopeField: "cdb_comment_viewer"`
- `churchdb:security level view own data` / `edit own data` → `scopeField:
"cc_securitylevel"`

For these, a `dataId` like `1`, `2`, `3` names a security level or a
comment-viewer bucket — **not** a group — so `GET /groups/{1,2,3}` 404s. A
`scope` array entry may therefore be a plain number instead of a string:

(Both of those dimensions gained a name-based form and are declarable resources
now — comment viewers in [#151](#comment-viewers-the-last-catalog-only-dimension-151),
security levels in [#110](#security-levels-a-managed-resource-with-a-declared-id-110).
Numerics keep working for both; calendar categories, OAuth clients and the other
module dimensions still have nothing but numerics.)

```ts
{ right: "churchdb:security level view own data", scope: [1, 2, 3, 5] },
```

A numeric entry must be an integer `>= 0`, or the special value `-1` —
ChurchTools' **"all values of this dimension" sentinel**. CT stores and reads
`-1` back verbatim (it is expanded only in the derived `/permissions/global`
view), so a declared `-1` diffs against a live `-1` and stays a clean no-op:

```ts
// every external system, present and future
{ right: "churchcore:login to external system", scope: [-1] },
```

Note `0` is a legitimate dataId on several dimensions (campus "Mainz" is id 0 on
eqrm prod), so it is accepted like any other — only values below `-1` and
non-integers are rejected.

Numeric entries pass straight through with no state lookup, no pending
resolution, and no re-resolution at apply time (their `dataId` is already
final). They can be freely mixed with logical group keys in the same `scope`
array. `ct adopt grants` emits this form automatically for any scoped right
whose `scopeField` has no logical form (see below) — never a `ct adopt group
<id>` hint for a dataId that was never a group. For `cdb_station` /
`cdb_gruppentyp` it emits a typed reference instead when the dataId names a
managed campus / group type, and otherwise leaves the number with a `NOTE`
naming the one `ct adopt …` command that makes it portable.

## Adopting existing grants — `ct adopt grants <domainType> <domainId>`

To bring an instance's existing rights under management without hand-transcribing
them, read the live rows and emit a paste-ready config block:

```bash
ct adopt grants group_type_role 42   # or: group_role / status, and the hyphenated group-type-role
```

### Bulk adoption (#104)

Adopting a whole instance one domain at a time meant dozens of invocations and
dozens of pastes, each needing its `key` renamed and its emitted numeric `id:`
swapped for the portable `group` + `role` pair — the two edits a human forgets
on the 30th paste. So:

```bash
ct adopt grants --group kids                  # every role instance of one group
ct adopt grants --all-declarable              # every declarable role instance on the host
ct adopt grants --all-declarable --write config/grants.ts   # append instead of printing
```

In bulk mode:

- the **portable domain form** is emitted whenever the group is managed —
  `group: "kids"` + `role: "Leiter"` instead of the host-specific pairing
  `id:` — and the key is derived as `<group key>_<role slug>` (`kids_leiter`).
  An unmanaged group falls back to `id:` with a comment saying why;
- a block that would **revoke live grants** is never emitted. In bulk the
  per-block `WARNING` header stops being a safeguard and becomes something the
  reader scrolls past, so such domains are skipped and listed instead;
- a role instance blocked by an undeclarable scope dimension is skipped and
  named, with the dimension to pass to [`preserveUnknown`](#partial-ownership-preserveunknown-opt-in-102).
  The single-domain form still emits it, deliberately, one domain at a time;
- both of those decisions are made over the **effective** rows — the same set the
  block will emit (#114/#119), not just the ones `ct` owns. That matters in both
  directions: a domain carrying its rights only as _inherited_ rows is still
  emitted (judging owned rows would call it empty, skip it, and leave those
  rights for the other host's plan to revoke), and an inherited grant on a
  dimension with no logical form still blocks the domain (judging owned rows
  would hide it from the gate and emit a host-specific numeric `dataId` into a
  bulk paste). Ownership itself is unchanged — that is still decided by
  `normalizeActual` at plan time, never by what adoption prints;
- nothing is capped silently — the run prints how many blocks it emitted **and**
  how many it skipped, with the reason for each.

### The single-domain form

It fetches `GET /permissions/<domainType>/<domainId>`, runs the rows through the
**same** normalization the planner reconciles against (`normalizeEffective`), and
prints a `ct.groupRole` / `ct.groupTypeRole` block whose every emitted grant is
guaranteed to be accepted by `ct plan` (the round trip is locked by tests):

- **Everything the host grants is emitted** — direct, inherited and
  system-baseline rows alike (#114/#119). See [Provenance and
  portability](#provenance-and-portability-114119) for why this is broader than
  what `ct` owns.
- **Revoke/deny rows are preserved, not emitted.** The reconciler never deletes a
  deny it did not author; if any exist, the block ends with a `NOTE` comment
  saying so (authoring denies as config is a separate, unshipped feature).
- **`authId` → `module:right` via the catalog** (reverse lookup). An `authId`
  with no catalog entry becomes a `WARNING` comment (regenerate the catalog or add
  the right by hand) rather than failing the whole adoption.
- **Scoped rights** are resolved by the right's actual `scopeField`
  (#49) — only rights scoped by the **group** dimension
  (`scopeField: "cdb_gruppe"`) are round-tripped as logical group refs; every
  other scope dimension is emitted as the [numeric escape
  hatch](#numeric-scope-escape-hatch-49) instead:
  - **Group-scoped** (`cdb_gruppe`): if the `dataId` matches a group
    **managed in your state file**, the scope is emitted as that group's
    logical key (`scope: ["kids"]`). If it is unmanaged, you get a
    clearly-marked placeholder comment telling you to `ct adopt group <id>`
    first — scope keys must be state keys (see [Scope
    resolution](#scope-resolution)).
  - **Another dimension with a logical form** (`cdb_station`, `cdb_gruppentyp`,
    `cdb_bereich`, `cc_securitylevel`, `cdb_comment_viewer`): a `dataId` that
    matches a resource **managed in your state file** is emitted as the portable
    reference (`scope: [{ commentViewer: "dienstbereich" }]`). An unmanaged one
    keeps its number and earns a `NOTE` naming the one command that fixes it —
    `ct adopt comment-viewer <id>`, then re-adopt the grants. The emitter is pure
    (no client, no fetch), so it cannot turn an unmanaged id into a name itself.
  - **Any other scope dimension** (`cc_calcategory`, `oauth_client`,
    …): there is no group to adopt, so the `dataId`(s) are emitted directly
    as a numeric `scope: [1, 2, 3]` — always an active line, with a comment
    naming the right's actual scope dimension. `ct adopt group <id>` is never
    suggested for these.
  - A scoped right granted **globally** in CT (row with no `dataId`) is a
    `WARNING` comment either way — the DSL deliberately cannot declare a
    global grant of a scoped right.
- **The `-1` "alle" sentinel is not an id** (#115). A grant scoped to "alle"
  comes back as `dataId: -1`, meaning _every_ value of the dimension on whatever
  host reads it. It is therefore already portable, and it is emitted with a
  one-line comment saying what it is — never with an adoption hint, because
  `ct adopt department -1` names a resource that cannot exist.
- **Admin-authored member rights are emitted as active grants** — **including**
  the writable `authId >= 10000` `churchdb:+…` member rights CT lets you set on
  `group_type_role`. There is no authId cutoff (#65).
- **Only `group_role` / `group_type_role` / `status`** are valid; people domains
  are refused (the same hard boundary as everywhere else). A `status` block is
  emitted with a numeric `id:` — rename it to the portable
  `personStatus: "<name>"` form when you paste it in.

> **Warning — comment-only grants are pending revocations.** Reconciliation is
> set-based: a live grant absent from the pasted declaration lands in
> `toDelete`. So any grant the adopter could only express as a `WARNING`/`NOTE`
> comment is still **live on the instance but missing from your config** —
> applying the block as-is will **revoke** it. The block prints a header saying
> exactly how many such grants exist; resolve every one (adopt the group,
> regenerate the catalog, …) before `ct apply`. `ct plan` is only a no-op once
> no comment-only grants remain.

Grants are **not** a state-tracked resource, so this prints config **only** — it
never writes the state file (unlike `ct adopt <type> <id>`). Pick a real logical
`key` (the emitted one is a rename-to-taste placeholder), paste into your config,
and `ct plan`.

## Domain rules (validated, throw on violation)

- **No authId cutoff.** Admin-authored member rights (`authId >= 10000`, the
  `churchdb:+…` family) ARE writable on `group_type_role` and can be declared
  under `ct.groupTypeRole` — verified live (eqrm prod `group_type_role/9` carries
  24 such admin-set rows). What ct never _writes_ is decided by the live row's
  flags, not its authId: `normalizeActual` drops the system baseline
  (`modifiedPid === -1`) and every `isInherited` row, so those are never authored
  and never revoked (#65). They are still **emitted by adoption and honoured as
  satisfying a declaration** — see [Provenance and
  portability](#provenance-and-portability-114119). Earlier versions blocked
  `authId >= 10000` outright — that was too broad and is removed.
- **Revocation is a later extension, not exposed yet.** `GrantTuple.type` is
  typed as `"grant" | "revoke"`, but the DSL and `desiredTuples` currently
  only ever _emit_ `"grant"` tuples — there is no config-level way to declare
  an explicit `type: "revoke"` grant today (`type: "revoke"` is reserved for
  a future `group_role`-only extension). Removing a grant's entry from the
  config still works as expected: the reconciler's set-diff (see below)
  computes it as a tuple to **delete**, and `ct apply` issues a `DELETE`
  against ChurchTools for it — you just don't author `"revoke"` yourself.

## The baseline-tolerance model

`ct plan` and `ct apply` **write** only the grants you author on a domainId —
never the platform's own bookkeeping. Two kinds of row are never authored and
never revoked (`normalizeActual` in `src/permissions/grants.ts`):

- **System baseline rows** — any row with `meta.modifiedPid === -1`. These
  are ChurchTools' own self-re-adding defaults.
- **Inherited rows** — any row with `isInherited: true`. These come from
  hierarchy/role inheritance, not this domainId's own grant table.

### Provenance and portability (#114/#119)

Those two rules decide what `ct` **owns**. They do _not_ decide whether a
declared grant is already **satisfied** — that is judged against the
**effective** set: every right the host grants, by any route
(`normalizeEffective`).

The distinction matters because provenance is not stable across hosts of the
same instance, even when the effective permissions are identical:

|                                                        | one host                        | the other host              |
| ------------------------------------------------------ | ------------------------------- | --------------------------- |
| **#114** — same right, same role                       | `meta.modifiedPid: -1` (system) | `modifiedPid: 1` (a person) |
| **#119** — 15 group-member rights the TYPE also grants | `isInherited: true`             | `isInherited: false`        |

Neither divergence is hand-made: the second host is a copy, and the copy
stamped a person id onto rows that are system rows upstream. Measured across
two hosts on CT 3.135.2: 18 of 63 `group_role` domains carried inherited rows
on one, and **zero anywhere** on the other.

Deciding satisfaction from ownership made such a config impossible to write.
Omit the right (as adoption used to emit it) and the other host **revokes** it;
declare it and this host plans `+1 grant` forever. So the domain had to be left
out of adoption entirely, even though nothing about it is genuinely
undeclarable.

Reconciling on the effective set removes the dilemma, because the two hosts
agree on effective permissions even when they disagree on provenance:

- A declared right the host already grants by any route needs **no PUT**.
- A revoke is still computed from the **owned** set only, so `ct` never revokes
  a baseline or inherited row.
- `ct adopt grants` emits the effective set, and names in a footer how many of
  the emitted grants are inherited or baseline on this host.

The "never fight the platform" property is unchanged. The only thing that
changed is that `ct` stopped proposing to re-author what the platform already
grants.

Combined with the **managed-guard** (`buildPermissionPlan` only ever surfaces
the `domainId`s you've declared — a bulk `GET /permissions/{domainType}`
response is filtered down to just those before diffing), this means:
unmanaged domains, system defaults, and inherited grants are all completely
invisible to `ct plan`/`ct apply` — only the grant set you explicitly declare
for a domainId you explicitly declare is ever read, diffed, or written.

## Set reconciliation

A grant's identity for diffing purposes is `(authId, sorted dataId[], type)`
(`tupleKey` in `src/permissions/grants.ts`). `ct plan` computes
`toPut`/`toDelete` as a straightforward set difference between desired and
(filtered) actual tuples; `ct apply` issues one `PUT` per `toPut` tuple and
one `DELETE` per `toDelete` tuple against
`/permissions/{domainType}/{domainId}`. Re-running `ct apply` against an
unchanged instance diffs to empty and issues no requests — the reconciliation
is idempotent.

## Partial ownership — `preserveUnknown` (opt-in, #102)

A declaration **owns its whole domain**: any live grant absent from `grants` is
revoked. That is the right default, and it does not move. But it also means one
unmanageable grant makes an entire role instance undeclarable — and on a real
instance the blocker is almost always module data (an HTML template, a calendar
category, a wiki category) sitting next to perfectly expressible structural
grants. On eqrm prod that cost 403 of 590 authored grants, several of them
blocked by a _single_ `cc_html_template` row on a 41-grant role.

`preserveUnknown` is the deliberate way out:

```ts
ct.groupRole({
  key: "team_office_leiter",
  group: "team_office",
  role: "Leiter",
  // Own the structural grants; leave anything on these dimensions alone. This role also carries
  // cc_html_template grants that this scaffold has no business owning.
  preserveUnknown: ["cc_html_template"],
  grants: [/* the 40 structural ones */],
});
```

- **Opt-in per declaration.** There is no global switch, and no default change.
- **`true` preserves everything undeclared**; a **list of scope dimensions** is
  the form to prefer — it keeps the escape hatch's blast radius to the
  dimensions you consciously excluded, so a genuinely unexpected new grant on a
  dimension you _do_ manage still shows up as drift rather than being swallowed.
- A dimension list never widens to **unscoped** rights: you named dimensions to
  leave alone, and "no dimension" is not one of them.
- A dimension no right in the catalog scopes by is an **eval-time error**, not a
  silent no-op — a typo that preserves nothing would otherwise read exactly like
  "there was nothing to preserve", right up until an apply revokes 41 grants.
- **Never invisible.** The plan renders every preserved grant and counts them
  separately from the change totals, so "I forgot one" and "I deliberately left
  the module grants alone" cannot look alike:

```
  group_role #44675 (team_office_leiter): +0 grant(s), -0 remove(s), ~2 preserved
      ~ authId=17 scope=[3] (grant) (preserved, not managed — preserveUnknown)

Permission plan: 0 to grant, 0 to remove, 2 preserved (not managed).
```

`ct coverage` (below) names the exact dimensions blocking each role instance —
those are the strings to pass here.

## What is declarable — `ct coverage` (#103)

To ask an instance "what exists here that I am not managing, and could I manage
it?":

```bash
ct coverage --env prod                 # totals, per-type table, declarability verdict
ct coverage --env prod --blocked       # only the role instances something blocks, and what
ct coverage --env prod --json          # for a CI gate
```

It joins `/groups?include[]=roles`, `/dynamicgroups` and
`/permissions/group_role` against your state file. Two details it gets right
that a hand-rolled audit easily does not: `?include[]=roles` turns one role
lookup per group into a handful of paged calls, and **inherited rows are
excluded** from the authored counts (forgetting that inflated one real audit
from 590 to 714 grants and made several role instances look unmanageable that
were not).

Declarability is reported per **(group, role)**, not per group — one group
routinely has two declarable roles and one blocked one, and group granularity
would hide exactly that. A role instance is declarable when every authored grant
is either unscoped, uses the `-1` ALL sentinel, scopes by a dimension with a
[logical reference form](#scope-resolution) (`cdb_gruppe`, `cdb_station`,
`cdb_gruppentyp`, `cdb_bereich`, `cc_securitylevel`, `cdb_comment_viewer`).
Anything else scopes by a dimension `ct` cannot yet name portably — in practice
the modules outside its mandate — and is named as the blocker.

## Example

See [`examples/permissions.config.ts`](https://github.com/eqrm/ct-cli/blob/main/examples/permissions.config.ts) for
a runnable `ct.groupTypeRole` declaration with one global grant and one
scoped grant.
