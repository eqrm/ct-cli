# External resource references across ct projects (#143)

**Status:** Design decisions complete; implementation not started. This
document records the agreed design for
[#143](https://github.com/eqrm/ct-cli/issues/143).

## Context

Independently managed ct projects may use the same ChurchTools resource. One
project owns its lifecycle; the others need its host-specific id in portable
references without gaining permission to create, update, or delete it.

The [adoption contract](../../adoption-contract.md) already establishes that a
shared referenced resource is never adopted transitively. This design defines
how a deliberately unmanaged resource can nevertheless be resolved.

## Terminology

A **ct project** is one lifecycle boundary consisting of a config and its
environment-specific state files. A project may be a directory in a monorepo or
its own repository. It does not need to be a separate Git repository.

Example:

```text
processes/
├── cafeplan/
│   ├── ct.config.ts
│   └── ct-state.prod.json
└── ojbp/
    ├── ct.config.ts
    └── ct-state.prod.json
```

## Glossary and terminology boundary

ct-cli spans several unrelated ChurchTools modules, APIs, and master-data
tables. ChurchTools has no single official umbrella term that exactly denotes
the set of things ct-cli can manage. In particular, neither unqualified
"resource" nor "domain object" is safe shorthand.

| Term in this design        | Meaning in ct-cli                                                                                                                                                                         | ChurchTools distinction                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **ct project**             | One config plus its environment-specific state files; one lifecycle boundary.                                                                                                             | Not a ChurchTools project or module.                                                                             |
| **ct-cli resource**        | An independently addressable top-level object represented by one entry in ct-cli's resource registry and, when managed, one state entry. Prefer the qualified form in user documentation. | ChurchTools uses "Resource" for its own product/API concepts; that term is not the umbrella category meant here. |
| **resource type**          | A ct-cli registry discriminator such as `group`, `campus`, or `group-role`.                                                                                                               | Not necessarily a ChurchTools domain, module, endpoint family, or UI object type.                                |
| **managed**                | The ct project owns lifecycle responsibility; `plan`, `apply`, and explicit `destroy` may act on the object.                                                                              | Does not mean a ChurchTools permission or UI ownership flag.                                                     |
| **external**               | The ct project may resolve and consume the object read-only but does not own its lifecycle.                                                                                               | No corresponding ChurchTools flag is implied or written.                                                         |
| **owner project**          | The one ct project whose managed state claims lifecycle responsibility for an object.                                                                                                     | Not necessarily the ChurchTools creator, administrator, or permission owner.                                     |
| **consumer project**       | A ct project whose external state binds and references an owner project's object.                                                                                                         | Does not describe ChurchTools memberships or participants.                                                       |
| **logical key**            | Portable, user-controlled identity used by `ref.*`, independent of ChurchTools ids.                                                                                                       | Not stored in ChurchTools unless a separate future design explicitly does so.                                    |
| **host binding**           | Mapping from `(resource type, logical key)` to one numeric ChurchTools id for one host.                                                                                                   | The numeric id remains ChurchTools' record id; the binding itself belongs to ct-cli state.                       |
| **identity snapshot**      | Minimal read-only live properties retained to detect that a binding's meaning changed.                                                                                                    | It is not a managed-field snapshot and never causes reconciliation.                                              |
| **owned structural child** | A non-person record whose lifecycle belongs to a top-level ct-cli resource, such as a group member-field definition.                                                                      | It may live behind a separate ChurchTools endpoint but is not an independent ct-cli resource binding.            |
| **relationship**           | An edge between top-level objects, such as group hierarchy.                                                                                                                               | It may not be a standalone ChurchTools record or ct-cli state entry.                                             |
| **coordination scope**     | The explicit directory tree inspected by `ct ownership check`.                                                                                                                            | Not a ChurchTools environment or organisational boundary.                                                        |

When prose could be read in the ChurchTools-specific sense, use the qualified
form **ct-cli resource** or name the concrete type (`group`, `campus`, and so
on). Do not introduce "domain object" as a replacement umbrella term: the
managed set crosses multiple ChurchTools domains and the phrase would suggest a
uniform ChurchTools abstraction that does not exist.

## Decisions so far

### 1. Separate portable identity, discovery, and host binding

An external resource has three distinct identities:

1. A **logical key** used by portable config references.
2. A minimal **live identity snapshot** used to validate a bound object, plus
   non-validating display properties used during candidate selection.
3. A **host binding** from that key to the concrete ChurchTools id on one host.

The logical `(resource type, key)` pair is the primary portable identity. It is
user-controlled, unique across managed and external entries within one ct
project, and never re-derived after initial creation. Live identity properties
validate the host binding; they do not replace the logical key.

When `ct use` needs to propose a key, it uses this priority:

1. If a visible owner project manages the same `(type, id)`, reuse the owner's
   key.
2. If the consumer already binds the `(type, id)`, retain that existing key.
3. Otherwise derive a one-time proposal with the registry's `slug()` function
   and let the user accept or edit it.

When the owner is visible, owner and consumers must use the same key for the
same `(type, id)`. `ct ownership check` treats differing aliases as an error and
prints a repair command. A deliberate key change is a separate explicit state
operation:

```bash
ct state rekey <type> <old-key> <new-key>
```

It works for managed and external entries, rejects collisions, and warns that
all `ref.*` uses in config must be changed consistently. Neither a live rename
nor a changed ChurchTools id ever changes the logical key automatically.

`name + groupType` may help discover a group, but it is not guaranteed to stay
unique. It must not be the only permanent identity mechanism. A user needs an
explicit way to select the intended live object when discovery is ambiguous.

No additional `ct.external.*` config DSL is introduced. `ct use` records the
external declaration and host binding in state; portable config consumes the
logical key through the existing reference DSL:

```ts
ref.group("vl_ojahr_teilnehmer_aktuell");
```

### 2. External is generic for every managed resource type

External binding is not a group-only feature. Every top-level resource type
that can receive its own entry in the managed `resources` state map must also be
bindable as external/read-only. At the time of this decision the registry
contains:

- `campus`
- `group`
- `group-type`
- `age-group`
- `target-group`
- `relationship-type`
- `person-status`
- `department`
- `security-level`
- `comment-viewer`
- `group-role` (the shared role definition)

The resource registry is the source of truth. Adding a future top-level managed
resource type must either provide the generic external contract or explicitly
explain why the type cannot be referenced externally; external support must not
grow as a second hand-maintained type list.

Each registry entry supplies or derives external behaviour for:

- collection and item reads;
- interactive search and candidate display;
- key derivation;
- identity capture and validation;
- useful disambiguating fields;
- logical reference kind and resolution.

Identity fields are type-specific. They must not blindly reuse every managed
field: a consumer should not be blocked by an unrelated mutable property merely
because the owner manages it. The registry needs an explicit external identity
adapter. Version 1 has no user-defined `match`, `assert`, or optional identity
field selection. Each registry type fixes its hard identity and its
non-validating candidate display:

| Resource type       | Hard identity snapshot | Candidate display only            |
| ------------------- | ---------------------- | --------------------------------- |
| `campus`            | name                   | short name                        |
| `group`             | name, group-type id    | campus, group status              |
| `group-type`        | name                   | translated name                   |
| `age-group`         | name                   | translated name, sort order       |
| `target-group`      | name                   | translated name, sort order       |
| `relationship-type` | name                   | labels for both directions        |
| `person-status`     | name                   | short name, member-status meaning |
| `department`        | name                   | short name                        |
| `security-level`    | name                   | numeric level/id                  |
| `comment-viewer`    | name                   | sort order                        |
| `group-role`        | name, group-type id    | leader/participant type           |

Only hard identity changes block a consumer plan. Display-only changes never
do. Thus moving a group to another campus or changing its status does not block
consumers, while renaming it or changing its group type does. A hard identity
change is accepted explicitly and idempotently by rerunning `ct use` with the
bound id and key; ct shows the field-level identity diff before confirmation.

This decision covers independently addressable top-level resources. It does not
turn the following into separate external resources:

- owned structural children such as group member-field definitions;
- synthetic fields such as dynamic-group configuration;
- relationship edges such as group hierarchy;
- permission declarations or grants;
- person-related data, which remains permanently excluded.

Those categories may contain references to an external top-level resource, but
they do not acquire independent external bindings of their own.

### 3. Persist external identity separately from managed state

The existing `resources` map remains exclusively lifecycle-owned resources.
External bindings live in a structurally separate top-level map, for example:

```json
{
  "version": 2,
  "host": "https://example.church.tools",
  "resources": {},
  "externals": {
    "vl_ojahr_teilnehmer_aktuell": {
      "type": "group",
      "key": "vl_ojahr_teilnehmer_aktuell",
      "id": 4711,
      "owner": "shared-masterdata",
      "identity": {
        "name": "VL OJAHR Teilnehmer aktuell",
        "groupTypeId": 17
      },
      "boundAt": "2026-08-27T12:00:00Z"
    }
  }
}
```

An external entry carries no managed-field snapshot and no lifecycle flags such
as `preventDestroy`. `apply` and `destroy` enumerate only `resources`; external
bindings are therefore outside write paths by construction, not merely by a
late conditional check.

An existing binding is authoritative for that host. Live discovery must never
silently replace it. Changing the binding requires an explicit `use`
command that names the new id and confirms the replacement.

Binding state is keyed by the portable logical key. The CLI exposes an
interactive discovery form and an explicit, scriptable form:

```bash
ct use group "OJAHR Fuzzies"
ct use group 4711 --key ojahr_fuzzies
ct state list
ct state rm group ojahr_fuzzies
```

`use` is the consumer operation, symmetric with the owner operation `adopt`:

```text
ct adopt <type> <id>       --key <key>  # own and manage
ct use   <type> <selector> --key <key>  # consume read-only
```

The resource type is mandatory. The two `use` forms are therefore
`ct use <type> "<search>"` and `ct use <type> <id> --key <key>`.

The search form performs a live fuzzy search within the named resource type and
presents every matching candidate with its id, exact name, and useful
type-specific disambiguators such as group type and campus. It never guesses
when several candidates match. After the user selects one, it proposes a
logical key derived with the existing `slug()` rule (`"OJAHR Fuzzies"` →
`"ojahr_fuzzies"`). The user may accept or edit that key before confirming the
binding.

The derived key is a one-time proposal, not a live derivation. A later rename of
the ChurchTools resource never changes it. An already-bound `(type, id)` keeps
its existing key, and a derived key colliding with any managed or external key
must be replaced explicitly.

The search form requires an interactive terminal. In non-interactive use no
candidate or key is inferred; scripts use the deterministic form
`ct use <type> <id> --key <key>`.

`use` is strictly idempotent:

- no existing binding for the key or `(type, id)`: validate the live resource,
  capture its identity, and create the binding;
- the same key is already bound to the same `(type, id)` and the stored identity
  still matches: validate it and return success without changing the state file;
- the same key and id still identify the resource but its identity properties
  changed: show the identity diff and replace the snapshot only after explicit
  confirmation;
- the key is bound to another id: show the old and new live resources and
  replace the binding only after explicit confirmation;
- the `(type, id)` is externally bound under another key: fail rather than
  create a second alias;
- the `(type, id)` is managed by this project: fail because a resource cannot
  be both managed and external in one project.

The no-op case must not update a timestamp: repeated `use` commands should
leave the state byte-stable. `boundAt` records creation of the binding, not its
most recent verification.

`ct state list` shows managed resources and external bindings together by
default, with an explicit ownership/kind column. Optional `--managed` and
`--external` filters may narrow that view, but are never required to obtain a
complete project-state listing. Because managed and external keys are mutually
exclusive within one project, `ct state rm <type> <key>` can remove either kind
without another mode flag; its output must say whether it removed a managed
state entry or an external binding. Removing state never deletes the live
ChurchTools resource.

### 4. Resolution and validation

The intended resolution order is:

1. If an external host binding exists, read that id live and validate its type
   and registry-defined hard identity snapshot.
2. Without a binding, use a visible owner's state and the unresolved logical
   key as search hints only to find and describe live candidates for
   remediation.
3. Missing, unique-but-unbound, or ambiguous discovery fails before any write
   and lists actionable candidates or remedies.
4. A resolved external id is available to every existing reference position,
   including dynamic rulesets, parents, and permissions.
5. Resolution never turns the external into a desired resource and never emits
   create, update, or delete actions.

External resources always require a persisted, host-specific binding created by
an explicit `ct use` invocation. Even when discovery finds exactly one live
candidate, `plan` must not consume it ephemerally and must not write the binding
itself. Instead it fails with the candidate's identifying details and the
complete deterministic `ct use <type> <id> --key <key>` command, followed by the
`ct plan --env <env>` verification command. This keeps plan read-only, makes the
consumer relationship auditable, and prevents a later same-named resource from
changing resolution.

An identity mismatch is a hard plan error. Its explicit, local repair is the
same declarative binding command: `ct use <type> <id> --key <key>`.
With the existing id it shows and, after confirmation, accepts identity changes;
with a new id it shows both live resources and replaces the id and identity
snapshot. The operation never writes to ChurchTools. Repeating it after the
desired binding and identity have been recorded succeeds as a no-op.

### 5. Missing owner resources block the consumer

An external prerequisite is never a pending consumer resource. `PendingRef`
means that the current apply is authorised and able to create the target later
in its own dependency graph; neither is true for a resource owned by another ct
project.

If the owner project has not materialised the resource, consumer `plan` fails
before any write and identifies the owner and the next steps. Consumer `apply`
must not start with an unresolved external prerequisite, and ct never applies a
different project automatically.

Diagnostics distinguish at least:

- the visible owner state has no managed resource: apply the owner project
  first;
- the owner state carries an id but the live read returns `404`: the owner state
  is stale or the resource was deleted outside ct;
- the declared owner is not present below the explicitly analysed coordination
  root: ownership cannot be verified there;
- the live resource exists but the consumer lacks its external binding: run
  `ct use` in the consumer project.

When the visible project layout permits it, the error may print concrete `cd`,
`ct plan`, `ct apply`, and `ct use` commands. It remains diagnostic:
cross-project apply ordering or execution is a separate future orchestration
feature, not part of #143.

#### Actionable diagnostic contract

A generic "cannot resolve external resource" message is insufficient. Every
blocking external-resource diagnostic must contain:

1. **Context:** external type and key, consumer project, declared owner project,
   environment, and ChurchTools host.
2. **Evidence:** which config, managed state, external state, and live lookup
   were inspected, and the exact missing, stale, ambiguous, or mismatching fact.
3. **Consequence:** that consumer plan/apply is blocked before writes, and that
   the consumer will not create or repair the owner's resource.
4. **Numbered remediation:** copyable commands using the discovered project
   paths, environment, type, key, and id wherever those values are known.
5. **Verification:** the exact command to rerun after the repair.

For example, when a visible owner has not materialised the group:

```text
External prerequisite is not available

  resource:    group "ojahr_fuzzies"
  consumer:    ojbp
  owner:       shared-masterdata
  environment: prod
  host:        https://example.church.tools

The owner config declares the group, but its prod state contains no managed id.
The consumer is blocked before writes and will not create the owner's group.

Next steps:
  1. cd ../shared-masterdata
  2. ct plan --env prod
  3. Review the owner plan, then run: ct apply --env prod
  4. cd ../ojbp
  5. ct use group <created-id> --key ojahr_fuzzies
  6. ct plan --env prod
```

The remediation changes by cause:

- owner state id returns live `404`: run owner `plan` first and explain that its
  state may be stale; do not suggest binding the missing id in the consumer;
- owner is outside the supplied coordination root: show how to rerun
  `ct ownership check <broader-root> --env <env>` or correct the declared owner;
- owner resource exists and only the consumer binding is missing: print the
  complete deterministic `ct use <type> <id> --key <key>` command;
- discovery is ambiguous: list every candidate with identifying properties and
  print a complete bind command for each candidate;
- bound identity changed: show the field-level identity diff and print the bind
  command that accepts the current id after confirmation.

Paths and commands must be derived from the inspected coordination root rather
than hard-coded examples. The application layer should expose stable reason
codes and structured remediation details so terminal, future UI, and machine
readable output can present the same diagnosis without parsing prose.

### 6. Ownership checks within an explicit coordination scope

No local project can discover claims in unknown repositories. When several ct
projects are visible under an explicitly supplied directory, however, ct can
compare all of their environment states.

From `processes/ojbp`, this command defines `processes` as the complete visible
coordination scope for this invocation:

```bash
ct ownership check .. --env prod
```

The command recursively discovers ct projects below the explicit root while
ignoring unrelated directories such as `.git`, `node_modules`, and build
outputs. No directory outside the supplied root is searched.

For each ChurchTools host it reports at least:

- the same `(type, id)` managed by two projects: **error**;
- a resource managed by one project and consumed externally by others: **ok**;
- an external declaration naming an owner that does not manage the bound
  resource: **error**;
- conflicting logical bindings or incompatible host data: **error**.

Ownership conflicts produce a non-zero exit code so the analysis can be a CI
gate. Projects or repositories outside the explicit root remain unknowable; a
truly global guarantee would require a shared registry with atomic claims.

An explicit directory is sufficient for the first implementation. A workspace
manifest may be added later for stable project ids, inclusion, or exclusion,
but is not required initially.

## Non-goals for the first implementation

- Importing another project's complete managed state as consumer state.
- Claiming that a directory scan can detect projects outside its explicit root.
- Silently taking lifecycle ownership as a side effect of reference resolution.
- Writing ownership markers into ChurchTools without a separate design and an
  appropriate ChurchTools metadata contract.
