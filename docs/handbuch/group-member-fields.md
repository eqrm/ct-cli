---
sources_hash: 777badbcc7fbbd7f
title: Group member fields
sources:
  - src/engine/member-fields.ts
  - src/engine/synthetic.ts
  - src/config/context.ts
  - src/commands/adopt-group.ts
  - src/commands/destroy.ts
reviewed: 2026-08-26
---

# Group member fields (#135)

A ChurchTools group can ask its members for extra information — "Wahl",
"Praktikumsplatz", a free-text note. Those are **group member fields**: field
_definitions_ that belong to one group.

`ct` manages them as **group-scoped owned resources**: they are declared inside
the group that owns them, adopted with the group, created after it, and never
deleted implicitly.

> Definitions only, never people. A member field says _what a group asks_. The
> value a specific person answered is a per-record value and is permanently out
> of scope, like every other person field (see
> [Field definitions](field-definitions.md)). `assertNotPeople` still guards
> every write.

This is a **different surface** from the group custom fields of #48/#60, which
live on `/dbfields` (`fieldCategory.table == "cdb_gruppe"`) and describe the
group _record_ rather than what its members are asked.

## Why the identity is `<group>::<field>`

A member field has a ChurchTools id, but it belongs to exactly one group and is
**not globally reusable**. Two groups declaring a field called `wahl` are two
independent resources with two different ids.

So the portable identity is the **managed group key plus the local field key**:

```text
ojbp_2026_27_praktikum_1::wahl
```

That is what makes the blueprint use case work. Running the same function for
25/26 and for 26/27 creates new groups and new fields; no 25/26 field id takes
part in resolving 26/27.

**A ChurchTools field id never appears in authored config or in an adopted
blueprint.** Declaring `id`, `groupMemberFieldId` or `groupId` on a member field
is a config error, not a warning — a host-specific id in a config that is meant
to stand up any host is the one defect the whole tool exists to prevent.

## Declaring them

```ts
ct.group({
  key: "ojbp_2026_27_praktikum_1",
  name: "OJBP 1. Praktikum 26/27",
  groupTypeId: 5,
  memberFields: [
    {
      key: "wahl",
      name: "Wahl",
      fieldTypeCode: "text",
      requiredInRegistrationForm: true,
    },
  ],
});
```

`memberFields` is **opt-in**, exactly like `parents` and `dynamic`:

| Declaration           | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| omitted               | the group's member fields are not managed at all                 |
| `memberFields: []`    | managed, none declared — still never deletes an existing field   |
| `memberFields: [ … ]` | these fields are created/updated; anything else is left in place |

`key` is the group-local key and is unique within the group. Everything else is
a ChurchTools member-field property.

### Managed properties

`name`, `fieldTypeCode`, `defaultValue`, `options`, `nameInSignupForm`, `note`,
`noteInSignupForm`, `requiredInRegistrationForm`, `useInRegistrationForm`,
`securityLevel`, `sortKey`.

Two readable/writable properties are deliberately **not** managed:

- **`id`** — host-specific; see above.
- **`referenceName`** — this _is_ the local identity, not a diffable property.
  It is what a create sends and, when no state-bound id exists, what a later run
  matches on. Managing it would let a rename silently re-key the resource and
  re-create the field instead of updating it. (A field created in the
  ChurchTools UI, where CT may mint its own `referenceName`, is matched by its
  slugged `name` as a fallback.)

A property outside the managed list still passes through to ChurchTools
unchanged — it only earns a warning, and it is never diffed.

## Adoption is opt-in — `--with-member-fields`

```bash
ct adopt group 4711 --with-member-fields
ct adopt group --children-of ojbp_2025_26 --with-member-fields
```

The emitted snippet carries a `memberFields:` block with every group-scoped
field and **no ChurchTools ids** — paste it, re-key it for the next year, and
`ct plan` proposes fresh groups and fresh fields.

Rows the group's member form shows but that are not group-scoped (person master
data, group-type defaults) are not emitted: only `/memberfields/group` rows can
be created or updated.

!!! note "Why opt-in, and not the default — and why that is temporary"
Whether an owned child resource is adopted automatically is a project-wide
contract, not a per-feature choice. That contract now exists
([ct-cli#141](https://github.com/eqrm/ct-cli/issues/141)), and it classes
member fields as an **owned structural child** — so `--with-member-fields`
is a **transitional** opt-in, not a statement that member fields are
optional. The flip to default-on is a separate release: the flag keeps
working as a no-op, and `--no-member-fields` ships in the same release as
the flip. Nothing about an existing config changes when that happens — an
absent `memberFields:` block still means "unmanaged".

Rows that could not be read (a 403, a rate-limited 429) are reported and the
group is adopted **without** them, so one unreadable group never aborts a
bulk adoption — re-run with `--with-member-fields` once the read succeeds.

## Plan and apply

`plan` diffs **per field**, under the pseudo-field `memberField:<localKey>`:

```text
  + group.ojbp_2026_27_praktikum_1
      name: "OJBP 1. Praktikum 26/27"
      memberField:wahl: {"name":"Wahl","fieldTypeCode":"text"}

  ~ group.ojbp_2025_26_praktikum_1 (#4711)
      memberField:wahl: {"name":"Wahl"} -> {"name":"Wahl (neu)"}
```

The actual side is narrowed to exactly the properties the declaration names, so
a server default ChurchTools returns can never make the two sides differ
forever: **a clean apply re-plans as a no-op.**

`apply` creates a field only after its owning group exists (the group's own
create runs first, then its owned sub-resources), and updates an existing field
in place — matched by identity, never re-created.

If the member-field read fails with anything other than a 404, the group is
reported as `fetch-failed` and the plan says it is INCOMPLETE. It never
manufactures "create every field" out of a transient error.

## Nothing is ever deleted implicitly

Removing a field from `memberFields` does **not** delete it. The diff walks the
declared side, so a removal produces no key, no change and no write — it is
structurally impossible for the engine to propose it.

The live field is still surfaced, every plan, as a **delete candidate**:

```text
! group "ojbp_2025_26_praktikum_1": member field
  "ojbp_2025_26_praktikum_1::alt" exists in ChurchTools but is not declared —
  DELETE CANDIDATE, left untouched. ct never removes a member field because it
  vanished from config; remove it explicitly with
  `ct destroy --member-field ojbp_2025_26_praktikum_1::alt`.
```

Removing one is an explicit, separate operation:

```bash
ct destroy --member-field ojbp_2025_26_praktikum_1::alt
```

It carries the same guardrails as any other destroy: a pre-delete backup of the
field definition, a typed confirmation, and the owning group's `preventDestroy`
— protecting a group protects the fields it owns.

If a field cannot be deleted, the run stops there **and holds back any
`--target` groups in the same command**. Deleting the owning group would take
the field with it as collateral, so a run that just reported it could not delete
a field must not delete it anyway.

## Referencing a field from a dynamic ruleset

A ruleset must not freeze one host's field id into a file that is applied
elsewhere, so a member field is referenced by its portable identity:

```ts
ref.groupMemberField("ojbp_2026_27_praktikum_1", "wahl");
```

Local keys are compared in their **normalised** form throughout — `"Wahl"` and
`"wahl"` are the same field, whether they appear in a declaration, in a
reference, in `ct destroy --member-field`, or as ChurchTools' own
`referenceName` on the live row. Two declarations in one group that differ only
in case are therefore rejected as duplicates.

Three things follow:

1. **A reference to a field that is not declared for the target group fails at
   config-eval time** — offline, before any network call — naming what the group
   does declare. ChurchTools validates none of the ids inside a ruleset, so
   without this the mistake would apply cleanly and simply compute the wrong
   membership.
2. A reference into a group that is merely _adopted_ (in state, not declared) is
   checked against the live `GET /groups/{id}/memberfields` at plan time, and
   hard-errors there — still before apply writes anything.
3. **Ordering is guaranteed within an apply.** A group's member fields are
   written before that group's ruleset is installed, and a reference from
   another group adds a dependency edge onto the owning group. A field created
   in the same run resolves to the id the create just minted.

## ChurchTools endpoints

| Operation | Path                                                    |
| --------- | ------------------------------------------------------- |
| read      | `GET /groups/{groupId}/memberfields`                    |
| create    | `POST /groups/{groupId}/memberfields/group`             |
| update    | `PATCH /groups/{groupId}/memberfields/group/{fieldId}`  |
| delete    | `DELETE /groups/{groupId}/memberfields/group/{fieldId}` |

Depending on the ChurchTools version, the read response is a bare array or is
wrapped under `group`, `data`, `memberFields` or `groupMemberFields`; field ids
may be numbers or decimal strings. `ct` normalises those transport variants
before identity matching. The `group` bucket is itself the authoritative scope
marker; a row inside it may still say `type: "person"` because values live on
memberships, and is not discarded for that reason.

When state already binds a portable field identity to a ChurchTools id but a
live response does not contain that id, the plan is marked **INCOMPLETE**. `ct`
will not turn an uncertain read into a replacement `POST`, because doing so can
duplicate a field that is still present on the host.

`PATCH` is used because it is a partial update, so unmanaged sibling properties
are left alone. An instance whose endpoint implements only `PUT` answers
405/501, and the update falls back to `PUT` rather than failing an apply over a
verb.
