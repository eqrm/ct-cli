---
title: Permissions
sources:
  - src/permissions/**
  - src/resolve/resolver.ts
  - src/resolve/refs.ts
  - src/config/context.ts
sources_hash: 03c3ae24524afcc9
reviewed: 2026-08-13
---

# Permissions (`ct.groupRole` / `ct.groupTypeRole` / `ct.status`)

Declare ChurchTools permission grants — group-role, group-type-role and
person-status rights — as code, and reconcile them idempotently with the same
`ct plan` / `ct apply` workflow used for structural resources (issue #13).

## The three DSL functions

```ts
export default (ct) => {
  ct.groupTypeRole({
    key: "leiter_tpl",             // logical key (unique across the whole config)
    groupType: "ministry_team",    // domain BY NAME — resolved to the domainId per host (#20)
    grants: [
      "churchgroup:view group",                                    // unscoped
      { right: "churchgroup:view group", scope: ["kids_area"] },   // scoped
    ],
  });

  ct.groupRole({
    key: "kids_lead_grant",
    group: "kids_area",      // domain BY (group, role) — resolved to the pairing domainId per host (#25)
    role: "Leiter",          // (or keep the numeric escape hatch: `id: 2882`)
    // "edit group memberships of group" is a scoped right, so it takes a `scope: [...]`.
    grants: [{ right: "churchgroup:edit group memberships of group", scope: ["kids_area"] }],
  });

  ct.status({
    key: "core_external_login",
    personStatus: "5 - Core",  // domain BY PERSON-STATUS NAME — resolved against /statuses (#90)
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
    or adopted into state) and already created — a same-run group is rejected
    (its pairing id is only known once it exists; pass a numeric `id` there).
    Declaring both a logical form and a numeric `id` is a conflict and throws.
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
evaluation only checks a grant's *shape*: `module:right` string or
`{ right, scope }`; it does not resolve the name against the catalog.)

## Catalog lifecycle & staleness (#25)

The catalog (`src/permissions/catalog.json`) is a snapshot of one instance's
permission master data, captured at a specific ChurchTools version. Two things
keep it honest:

**Regeneration — one command.** Point it at a live instance and it rewrites
`catalog.json` (rights + a fresh `$meta` provenance stamp):

```bash
CT_HOST=https://your.church.tools CT_LOGINTOKEN=<token> npm run regenerate:permission-catalog
```

It logs in, calls the legacy `POST /index.php?q=churchauth/ajax` `func=getMasterData`
endpoint (the only source of the name↔authId map — see
`src/permissions/README.md`), records the instance's CT version, and writes the
file. It performs a single **read**; it never writes to the instance. Review
the `git diff` before committing.

**Staleness & unknown rights — `ct plan` warns (never fails).** `$meta.ctVersion`
records the version the catalog was captured from. On every `plan`/`apply`:

- If the live instance's CT version differs from `$meta.ctVersion`, `ct plan`
  prints a warning — right names/authIds/scopeFields may have drifted;
  regenerate to be sure.
- If a **live grant carries an `authId` the catalog cannot name** (a stale or
  foreign right), `ct plan` names the `authId` + domain and **leaves the grant
  untouched** — it is deliberately kept *out* of the diff so `ct apply` never
  revokes a right it cannot even describe. This is idempotent: the unknown row
  is excluded every run, so it neither churns nor silently disappears.

Both are warnings, not errors: the plan still runs and the exit code stays
success. Regenerating the catalog (above) is the fix for both.

## `domainId` semantics

The two DSL functions manage two different ChurchTools "domain types," and
`id` means something different for each:

- **`group_type_role`** (`ct.groupTypeRole`) — the domain is the **group type's
  own id** (the same id you'd pass as `groupTypeId` on `ct.group`). It scopes the
  grant to "every role holder of this group type." Declare it portably as
  `groupType: "<name>"` (resolved per host, #20) or directly as `id: <domainId>`.
- **`group_role`** (`ct.groupRole`) — the domain is the **internal
  (group, role) pairing's own id** — a ChurchTools-internal id for one
  specific group's specific role, *not* the group's id and *not* the role's
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
  > reaches person *records*: dropping the declaration and running `ct destroy`
  > deletes the status, and ChurchTools re-stamps every person carrying it.
  > `assertNotPeople` cannot catch this (`/statuses/{id}` is not a people path),
  > so `ct destroy` warns explicitly for this type and `--force` does **not**
  > skip its confirmation. Set `preventDestroy: true` on the declaration if the
  > status is load-bearing.

  That is what makes a config using the `status` domain self-sufficient across
  hosts. Before it, `personStatus: "…"` could only resolve against statuses that
  already existed on the target instance, so a config that planned to a clean
  no-op on prod died on dev with *"no managed resource and no live person-status
  at /statuses matches key …"* — whose own advice ("Declare/adopt it") was not
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

**`group_role` is deliberately NOT symmetric here.** A `group_role` domain id is
the (group, role) **pairing** id, which only exists on
`GET /groups/{groupId}/roles` — re-resolving it needs a *live fetch* after the
group exists, not just a post-execute state lookup. So a `group_role` domain
referencing a same-run-created **group** still fails fast with its own
actionable message ("apply the group first, or pass a numeric id"). Its harder
deferral is out of scope for #69 (which targets the #23 `group_type_role`
scenario).

## Scope resolution

A scoped grant's `scope: [...]` is a list where each entry is one of three
forms (`src/permissions/scope.ts`):

| Form | Example | Dimension |
| --- | --- | --- |
| **Logical group key** (string) | `scope: ["kids_area"]` | groups (`cdb_gruppe`) only |
| **Typed logical reference** (#98) | `scope: [{ campus: "koblenz" }]` | campuses, group types — see below |
| **Raw numeric `dataId`** (escape hatch, #49) | `scope: [1, 2, 3]` | any dimension |

String entries are resolved against **desired ∪ state**:

- A key already in state resolves to that group's `dataId`.
- A key **declared in this config but not yet created** resolves to a *pending*
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
post-execute state. This means a group *created* or *recreated* in the same
apply always gets its grant written with its fresh `dataId`, never a pending
placeholder or a stale, dangling id.

### Typed logical scope references (#98)

Not every scoped right scopes **by group**, and some of the other dimensions are
resources this tool *can* name portably. Those take a typed reference:

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

| `scopeField` | Reference form | Resolved against |
| --- | --- | --- |
| `cdb_gruppe` | `{ group: "<key>" }` (or the bare string) | managed groups |
| `cdb_station` | `{ campus: "<key>" }` | managed campuses, then `GET /campuses` |
| `cdb_gruppentyp` | `{ groupType: "<key>" }` | managed group types, then `GET /group/grouptypes` |
| `cdb_bereich` | `{ department: "<name-slug>" }` | `GET /departments` **only** — read-only, see below |

**Why this matters:** campus ids are host-specific — Mainz is `0` on eqrm prod
and `6` on eqrm dev. A campus-scoped grant written as a numeric literal is
therefore a cross-environment misgrant, and because declaring a domain makes
`ct` *own* it, the wrong-scope grant also revokes whatever is really there on
the other host. The typed reference makes one config plan clean on both.

Resolution mirrors the domain-reference rules: managed state first, the live
master-data catalog second, and a target **declared in this same config**
resolves to a *pending* scope re-resolved at apply time. A reference resolved
through the catalog (not under management) carries an already-final id and is
not re-resolved. Catalogs are read **paginated** — ChurchTools returns only a
first page (10 rows) for a plain list read, so an instance with more campuses,
group types or departments than that would otherwise report a perfectly real
name as unresolvable.

Three things are hard errors at **plan** time, never a guessed `dataId`:

- a reference whose dimension does not match the right's `scopeField` —
  e.g. `{ groupType: … }` on `churchdb:view station` (a `cdb_station` right);
- a reference on a dimension that has **no** logical form (`cc_securitylevel`,
  `ccm_data_category`, `oauth_client`, … — values that are not resources at
  all) — the message points at the numeric escape hatch;
- a **bare string** on a non-group dimension. A string always means "managed
  group", so on e.g. a `cdb_station` right it would either fail confusingly or —
  worse — match an unrelated group that happens to carry that key.

### Departments are referenceable, never declarable

`cdb_bereich` (Bereiche) is the one dimension with a **read-only** catalog.
Live-probed against the instance's own OpenAPI spec (eqrm prod, CT 3.135.2,
2026-08-13): `GET /departments` exists, and **no** `POST`/`PUT`/`DELETE` on
`/departments` does.

So a department reference resolves by name on every host — which is what makes
`churchdb:view alldata` ("Personen eines Bereiches sehen") declarable at all —
but there is no `ct.department` resource, no `ct adopt department`, and a name
that matches nothing is a **hard error** rather than a create:

```
Cannot resolve department:nope referenced at … : no live department at
/departments matches key "nope". departments are a read-only catalog in
ChurchTools — they cannot be declared or adopted, so fix the key/name
(list them with `ct get departments`) or use a numeric id.
```

Discover the names with `ct get departments`. Because the id always comes from
the live catalog, a department scope is never "pending" and is never re-resolved
at apply time — it is host-correct the moment it resolves. A managed resource
that happens to share the key does **not** shadow it (that would be exactly the
misgrant this feature exists to prevent).

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
comment-viewer bucket — **not** a group — so `GET /groups/{1,2,3}` 404s and
there is no logical/managed key to reference it by. A `scope` array entry may
therefore be a plain number instead of a string:

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

It fetches `GET /permissions/<domainType>/<domainId>`, runs the rows through the
**same** normalization the planner uses (`normalizeActual`), and prints a
`ct.groupRole` / `ct.groupTypeRole` block whose every emitted grant is guaranteed
to be accepted by `ct plan` (the round trip is locked by tests):

- **Excluded, as reconciliation excludes them:** the system baseline
  (`meta.modifiedPid === -1`) and inherited rows.
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
  - **Any other scope dimension** (`cc_securitylevel`, `cdb_comment_viewer`,
    …): there is no group to adopt, so the `dataId`(s) are emitted directly
    as a numeric `scope: [1, 2, 3]` — always an active line, with a comment
    naming the right's actual scope dimension. `ct adopt group <id>` is never
    suggested for these.
  - A scoped right granted **globally** in CT (row with no `dataId`) is a
    `WARNING` comment either way — the DSL deliberately cannot declare a
    global grant of a scoped right.
- **System-baseline and inherited rows are dropped, not emitted.** Adoption runs
  the live rows through `normalizeActual`, which excludes the self-re-adding
  system baseline (`modifiedPid === -1`) and any `isInherited` row. Admin-authored
  direct grants — **including** the writable `authId >= 10000` `churchdb:+…`
  member rights CT lets you set on `group_type_role` — are emitted as active
  grants (no authId cutoff; #65).
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
  24 such admin-set rows). What ct never reconciles is decided by the live row's
  flags, not its authId: `normalizeActual` drops the system baseline
  (`modifiedPid === -1`) and every `isInherited` row, so those are neither adopted
  nor revoked (#65). Earlier versions blocked `authId >= 10000` outright — that was
  too broad and is removed.
- **Revocation is a later extension, not exposed yet.** `GrantTuple.type` is
  typed as `"grant" | "revoke"`, but the DSL and `desiredTuples` currently
  only ever *emit* `"grant"` tuples — there is no config-level way to declare
  an explicit `type: "revoke"` grant today (`type: "revoke"` is reserved for
  a future `group_role`-only extension). Removing a grant's entry from the
  config still works as expected: the reconciler's set-diff (see below)
  computes it as a tuple to **delete**, and `ct apply` issues a `DELETE`
  against ChurchTools for it — you just don't author `"revoke"` yourself.

## The baseline-tolerance model

`ct plan` and `ct apply` reconcile only the grants **you author** on a
domainId — never the platform's own bookkeeping. `normalizeActual`
(`src/permissions/grants.ts`) filters two kinds of rows out of every actual
fetch before diffing, making both invisible to reconciliation:

- **System baseline rows** — any row with `meta.modifiedPid === -1`. These
  are ChurchTools' own self-re-adding defaults; they are never proposed for
  deletion and never conflict with a desired grant.
- **Inherited rows** — any row with `isInherited: true`. These come from
  hierarchy/role inheritance, not this domainId's own grant table; they are
  not owned here either.

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

## Example

See [`examples/permissions.config.ts`](https://github.com/eqrm/ct-cli/blob/main/examples/permissions.config.ts) for
a runnable `ct.groupTypeRole` declaration with one global grant and one
scoped grant.
