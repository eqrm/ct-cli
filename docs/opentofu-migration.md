# Living alongside terraform-provider-churchtools

The TypeScript DSL is frozen and the tier-0 resources — campuses, group types,
Bereiche, person statuses, comment viewers — are moving to
[`terraform-provider-churchtools`](https://github.com/eqrm/terraform-provider-churchtools).
`ct export tf` produces the HCL and the import blocks for that move. This page
covers the two things needed to live in the in-between state, where OpenTofu owns
tier-0 and `ct` still owns everything above it.

## The id map: references that outlive their declarations (#181)

When tier-0 leaves `ct.config.ts`, its **references** stay: several hundred
`campus: "mainz"`, `personStatus: "status_unbekannt"`, `{ groupType: "struktur" }`
on groups, grants and rulesets. Those are logical references — they ask the host
for an id rather than carrying one — so they look like they should survive.

They do not, on their own. `ct` resolves a logical reference from its own state
first and falls back to matching the key against the live object's **name**. While
the resource was in ct's state the key resolved exactly; with the state entry gone,
only the name fallback is left, and ct's tier-0 keys were never name-derived:

| key                | live name                   |
| ------------------ | --------------------------- |
| `status_unbekannt` | `Unbekannt`                 |
| `status_5_core`    | `5 - Core`                  |
| `egc`              | `Equippers Germany Central` |

No slug of those names produces those keys, so removing the state entries makes
`ct plan` fail to resolve them. Pinning numeric ids is not an escape either: one
config serves two hosts, and on the eqrm estate 39 of 43 tier-0 ids differ between
them.

So `ct` reads a committed **id map** — the exact `key → id` table for this host:

```
.ct/ids.<host>.json
```

```json
{
  "$meta": {
    "host": "https://eqrm.church.tools",
    "source": "ct export tf",
    "generatedAt": "2026-09-21",
    "entries": 50
  },
  "campus": { "mainz": { "id": 0 } },
  "person-status": { "status_unbekannt": { "id": 0 }, "status_5_core": { "id": 6 } }
}
```

It sits **between** the two existing sources: after ct's own managed state (ct
never stops trusting what it owns) and before the live catalog (an exact table
beats a name guess). A repo without a map behaves exactly as before.

`ct plan` names the map it loaded in its header, next to the permission catalog:

```
permission catalog: .ct/permission-catalog.eqrm.church.tools.json
tofu id map: .ct/ids.eqrm.church.tools.json
```

**Commit the map, one per host.** It is host-checked on load — a map whose `$meta.host`
does not match the resolved host is rejected rather than applied, because 39 of 43
ids differing means a foreign map would resolve every reference to a real,
_wrong_ resource, which nothing downstream could detect.

### Writing it

`ct export tf` writes it from the state it is exporting, so the cutover itself
needs no extra step:

```bash
ct export tf --env prod            # tofu/*.tf, tofu/imports.tf, and .ct/ids.<host>.json
ct export tf --env prod --no-ids   # …without the map, if your repo generates it another way
```

The map is written under `.ct/`, not into the tofu output directory: it is `ct`'s
input, not part of the root module tofu reads.

A partial export (`--only campus`) rewrites only the types it was asked for and
carries the rest of the map over untouched — otherwise a type-at-a-time cutover
would drop the ids of every type it had not reached yet. Within a type the
rewrite is wholesale: a resource that has left `ct`'s state has left `ct`'s
ownership, and its id goes with it.

An export that maps **nothing** leaves an existing map alone and says so, rather
than emptying it. That is not an edge case but the end state: once tier-0 is gone
from `ct.config.ts` and `ct-state.<env>.json`, every `ct export tf` exports zero
resources, and the map it would overwrite is the only thing still resolving the
references that stayed behind. From that point on the map is refreshed from tofu,
with `ct ids sync` — not from `ct`.

### Keeping it current

An export can only describe what `ct` still holds. Once tier-0 belongs to tofu,
tofu is the only place new ids appear — a campus created by `tofu apply` exists in
no ct state file. `ct ids sync` reads tofu's own state instead:

```bash
tofu state pull | ct ids sync --env prod --tofu-state -   # any backend, no S3 client in ct
ct ids sync --env prod --tofu-state terraform.tfstate     # or a local file
ct ids sync --env prod --tofu-state terraform.tfstate --dry-run
ct ids list --env prod                                    # what ct would resolve through
```

`sync` reports every id it adds, changes or drops, and **refuses to replace a
populated map with an empty one** — the likeliest cause of an empty read is the
wrong workspace, and overwriting 50 working ids with nothing would break every
reference at once. Provider resource types `ct` has no mapping for (a
`churchtools_group`, another provider's resources in a shared state) are reported
and skipped.

One subtlety: `ct export tf` relabels keys that are not valid HCL identifiers
(`3_groupactive` → `g_3_groupactive`), and that mapping is many-to-one, so it
cannot be inverted by rule. The map records the label alongside the key, and
`ct ids sync` uses the existing map to translate a tofu address back to the ct
key. Without a previous map, the label is taken as the key — correct for every
key that needed no relabelling.

Reading tofu's **remote** state directly was considered and rejected: it would put
an S3 backend, its credentials and an AWS SDK inside a CLI whose every other read
is ChurchTools. Piping `tofu state pull` keeps the backend tofu's problem.

## `ct auth token`: a credential helper (#179)

The provider needs credentials, and its `token` attribute wants a ChurchTools
personal login token — which is permanent, cannot be scoped or rotated by
ChurchTools, and is an admin credential on prod. Writing one to a `.env` file for
the provider to read is the thing worth avoiding.

`ct auth token` hands over the **session** that token buys instead:

```bash
$ ct auth token --env dev | jq
{
  "operation": "auth",
  "action": "token",
  "environment": "dev",
  "host": "https://eqrm-dev.church.tools",
  "cookie": "ChurchTools_eqrm-dev=…",
  "csrfToken": "…",
  "expiresAt": "2026-09-22T06:12:00.000Z",
  "source": "cache"
}

$ ct auth token --env dev --raw    # the bare cookie, for command substitution
```

Why the session rather than the token: it expires, `ct auth logout --env dev`
kills it, and a copy that leaks into a `tofu` debug log or a CI artifact is dead
within hours instead of being the permanent admin credential forever. The login
token itself never leaves the Keychain.

The contract:

- the credential goes to **stdout and nothing else does** — every message,
  warning and Keychain prompt is on stderr, so `$(ct auth token --raw)` is safe;
- a failure writes **nothing** to stdout and exits non-zero, with the remedy
  named (`ct auth login --env <name>`);
- printing to a **terminal is refused** unless `--allow-tty` — a credential in
  your scrollback defeats the point of it being short-lived;
- `expiresAt` is `ct`'s reuse ceiling (12h), not a promise from ChurchTools:
  treat a 401 as "ask again", which is cheap because this command answers from
  the Keychain-cached session.

Calling it on every `tofu` run is the intended usage. Sessions are cached per host
in the Keychain (macOS), so that is normally zero network calls; when a handshake
_is_ needed, a cross-process brake keeps it from becoming a burst:

- handshakes against one host are spaced at least 3s apart (waited out, not an
  error);
- more than 120 in a rolling hour is refused, naming when the window frees up —
  that is a runaway loop, and hammering a throttled instance only lengthens the
  outage for everyone on it;
- `CT_NO_LOGIN_THROTTLE=1` disables it, for a CI job that knows it runs alone.

The counter lives in `$XDG_CACHE_HOME/ct-cli/login-throttle.<host>.json` and holds
nothing but timestamps. Deleting it, or being unable to write it, simply means no
throttle. It is read-modify-written without a lock, so it bounds a _sequence_ of
invocations rather than a simultaneous burst: two `ct` processes starting at the
same instant are spaced no better than not at all.

**The brake sits in the login handshake, so it covers every `ct` command**, not
just `ct auth token` — and on Linux and Windows there is no session cache, so
there each invocation is one handshake. That is why the hourly cap is 120 rather
than a number sized for a credential helper alone: a pipeline should never reach
it, while a runaway loop passes it in about six minutes. A CI job that runs more
`ct` invocations than that against one host in an hour should set
`CT_NO_LOGIN_THROTTLE=1`.

A CI job otherwise needs none of this: it passes the token explicitly from a
GitHub secret, which is already storage-free. This path exists for local
development, where the alternative was a token on disk.
