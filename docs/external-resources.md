# External ct-cli resources

Independent ct projects can share one ChurchTools object without sharing its
lifecycle. The owner project declares or adopts it. Each consumer records a
host-specific, read-only binding with `ct use` and keeps using the normal
portable `ref.*` form in config.

```bash
# owner project: lifecycle ownership
ct adopt group 4711 --key ojahr_fuzzies --env prod

# consumer project: read-only consumption
ct use group 4711 --key ojahr_fuzzies --owner shared-masterdata --env prod
```

```ts
ref.group("ojahr_fuzzies");
```

There is deliberately no `ct.external.*` config DSL. The config stays portable;
state binds its logical keys to ids separately on every ChurchTools host.

## Terminology boundary

ChurchTools does not use one official umbrella term for the objects in the
ct-cli registry, and it uses “Resource” for other product concepts. In this
documentation:

- **ct project** means one config plus its environment-specific state files and
  therefore one lifecycle boundary.
- **ct-cli resource** means an independently addressable top-level object in
  the resource registry. It does not mean a ChurchTools “Resource” feature.
- **managed** means this ct project owns lifecycle responsibility. Its plan,
  apply, and an explicit destroy may act on the object.
- **external** means this ct project can resolve the object read-only but does
  not own it. This is ct-cli state only; no ChurchTools flag is written.
- **owner project** is the project with the managed state entry; a **consumer
  project** has an external binding.
- A **logical key** is the portable, user-controlled name used by `ref.*`. It is
  never stored in ChurchTools.
- A **host binding** maps `(ct-cli resource type, logical key)` to a ChurchTools
  id for one host.
- An **identity snapshot** is the minimal live identity used to detect a changed
  binding meaning. It is validated, never reconciled by the consumer.
- A **coordination scope** is only the explicit directory tree inspected by
  `ct ownership check`; it is not a ChurchTools boundary.

## Creating a binding

The deterministic form is suitable for scripts and CI. Both id and key are
mandatory outside a terminal:

```bash
ct use group 4711 --key ojahr_fuzzies --env prod
```

In a terminal, a string selector performs fuzzy discovery within the explicit
type and shows every match with its id, exact name, and disambiguating fields:

```bash
ct use group "OJAHR Fuzzies" --env prod
```

The command never guesses among multiple matches. It proposes an existing
consumer key when the id is already bound; otherwise it proposes a one-time
slug that can be edited. A logical key is never recalculated later.

`ct use` reads ChurchTools to validate the selected object but never writes it.
It is byte-idempotent: the same key, id, owner metadata, and hard identity is a
successful no-op and does not update `boundAt`. A hard identity change or a
replacement id requires interactive confirmation or `--yes`; the command shows
the changed fields or old/new targets first. Display-only changes need no
confirmation. Managed keys and ids cannot be rebound as external, and neither a
key nor `(type, id)` may have a second external alias.

Supported top-level types come directly from the registry: `campus`, `group`,
`group-type`, `age-group`, `target-group`, `relationship-type`,
`person-status`, `department`, `security-level`, `comment-viewer`, and
`group-role`. Permissions, relationship edges, owned child structures, and all
person-related data are not independent external types.

## State and identity

State version 2 keeps lifecycle ownership and consumption separate:

```json
{
  "version": 2,
  "host": "https://example.church.tools",
  "resources": {},
  "externals": {
    "ojahr_fuzzies": {
      "type": "group",
      "key": "ojahr_fuzzies",
      "id": 4711,
      "owner": "shared-masterdata",
      "identity": { "name": "OJAHR Fuzzies", "groupTypeId": 17 },
      "boundAt": "2026-08-27T12:00:00.000Z"
    }
  }
}
```

Version-1 files load in memory as version 2 with an empty `externals` map and
are written as version 2 on the next state mutation. Managed entries remain in
`resources`; external entries never carry managed fields or lifecycle flags.

The registry defines hard identity: name for every type, plus group type id for
groups and group roles. Short names, translated names, campus/status, sort
order, relationship labels, member-status meaning, numeric security level, and
leader/participant role type are selection display only. Thus moving a group to
another campus does not block a consumer plan; renaming it or changing its group
type does.

Inspect or maintain either state partition with the shared commands:

```bash
ct state list --env prod             # managed and external, with explicit kind
ct state list --managed --env prod
ct state list --external --env prod
ct unuse group ojahr_fuzzies --env prod
ct unadopt group owned_group --env prod
ct state rekey group old_key new_key --env prod
```

`unuse` removes only external bindings; `unadopt` removes only managed ownership.
Neither contacts ChurchTools or deletes the live object. Both first check every
known config declaration and `ref.*` position, show the exact entry and state
file, then require the environment name to be typed. A referenced key blocks by
default; `--force` overrides that check only when the config and state changes
are deliberately made together. `--dry-run` previews without confirmation or a
write. In non-interactive use, confirmation remains explicit:

```bash
ct unuse group ojahr_fuzzies --env prod --confirm-env prod
```

`ct state rm` remains the low-level repair escape hatch and carries the same
typed confirmation plus a best-effort reference check; unlike the public
lifecycle commands it can proceed with a warning when a broken config cannot be
inspected. Prefer `unuse`/`unadopt`. Rekeying requires every config and `ref.*`
use to be changed consistently.

## Planning and safety boundary

Resolution checks managed state first, same-run managed declarations second,
and persisted external bindings third. A bound external is read live by id and
its hard identity is verified before use in supported positions such as
permissions, hierarchy parents, and dynamic rulesets.

An external is never a desired or pending resource. It therefore cannot emit a
create, update, or delete action; consumer `apply` and `destroy` enumerate only
managed state. If an external prerequisite is missing, stale, ambiguous, or has
changed identity, plan fails before writes. Discovery may provide complete
`ct use` commands, but plan never persists or temporarily consumes a candidate.
The consumer never applies or repairs the owner project.

Blocking diagnostics include a stable reason code and structured context,
evidence, consequence, numbered remedies, and an exact verification command.
Typical recovery is one of:

```bash
# create/repair the object from its owner project first
cd ../shared-masterdata && ct plan --env prod

# bind the verified live object in the consumer
ct use group 4711 --key ojahr_fuzzies --env prod
ct plan --env prod
```

Do not bind an id that returns 404. Repair the owner's stale state or restore the
object first.

## Checking ownership across projects

Run the check with an explicit complete directory scope:

```bash
ct ownership check .. --env prod
```

It recursively finds ct projects below that root, ignores `.git`,
`node_modules`, and build output, groups results by ChurchTools host, and makes
no network calls. It reports duplicate managed owners, missing or mismatching
owner hints, different keys for the same `(type, id)`, conflicting bindings,
and incompatible identity snapshots. Conflicts return a non-zero exit code for
CI and include `ct state rekey`, `ct unuse`, `ct unadopt`, or broader-scope
remediation.

The guarantee is intentionally scope-limited. Projects outside the supplied
root remain unknowable; global atomic ownership would require a separate shared
registry.
