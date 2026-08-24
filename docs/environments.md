# Environments (dev → prod promotion)

One config repo can drive several ChurchTools instances — e.g. a `dev`
rehearsal env and the real `prod` — Terraform-workspace-style, with **no file
edits** when switching.

## Declaring environments

Declare them once in a committed `ct.envs.json` in the config repo (default
path; override with `CT_ENVS`):

```json
{
  "environments": {
    "dev": { "host": "https://mychurch-dev.church.tools" },
    "prod": {
      "host": "https://mychurch.church.tools",
      "state": "ct-state.prod.json",
      "protected": true,
      "tokenEnv": "CT_PROD_TOKEN"
    }
  }
}
```

Each profile is a `(host, state file, token reference)` triple:

- **`host`** — the instance this env targets (the source of truth for `--env`;
  it overrides any ambient `CT_HOST`).
- **`state`** — the committed state file. Defaults to the `ct-state.<env>.json`
  convention (`ct-state.dev.json`, `ct-state.prod.json`), overridable per env.
  Both files live in the config repo and are committed, so `dev` and `prod`
  never share a state file.
- **`tokenEnv`** — the **name** of an environment variable holding the login
  token (for CI); never a literal secret, so the file is safe to commit.
- **`protected`** — see the guardrail below.

## Using them

Every state/host-touching command takes `--env <name>` (`-e`):

```bash
ct plan  --env dev     # diff dev's config against the dev host, using ct-state.dev.json
ct apply --env dev
ct plan  --env prod    # SAME checkout, no edits — prod host + ct-state.prod.json
ct state list --env prod
ct get groups --env dev
```

Without `--env`, behaviour is unchanged (single stored login, `ct-state.json`).

**Token resolution** for a chosen env: `CT_LOGINTOKEN` env (CI — a profile
`tokenEnv` is copied here when set) → the host-keyed Keychain entry. `ct auth
login` stores credentials **per host**, so one machine can hold logins for `dev`
and `prod` at once (a pre-existing single login still works as a fallback).

`ct auth status --all` is stricter about the bare `CT_LOGINTOKEN` fallback than
an `--env` command is, because it walks *every* host: an ambient
`CT_LOGINTOKEN` is offered only to the host it is bound to (`CT_HOST`, else the
stored default login's host). Give each env its own `tokenEnv` to authenticate
more than one host in CI — the alternative would post one instance's token to
every other instance listed in `ct.envs.json`.

## Which account am I using where?

`ct auth status` answers it per environment, resolving the same host and token an
`--env` command would — without writing anything:

```bash
ct auth status --env dev      # identity on dev's host (JSON on stdout, host on stderr)
ct auth status --all          # preflight: every env in ct.envs.json, one line each
```

```text
dev   https://mychurch-dev.church.tools  ✓ Ada Lovelace (#42) via Keychain
prod  https://mychurch.church.tools      ✗ no token
```

`--all` exits non-zero if any environment has no working token, so CI can gate on
it before an apply. It is the first thing to run when an `--env` command returns
401 and you need to know whether the token is missing, expired, or simply belongs
to somebody else — failures carry the HTTP status the instance returned. A green
line also means the instance meets the minimum ChurchTools version, so it is not
one an `apply` would refuse. Tokens are never printed — only where each one came
from.

`ct auth logout --env <name>` removes just that host's credentials and leaves
your other logins in place. If that host also happened to be your *default*
login, the shared entry goes with it and the command says so — commands without
`--env` then need a `ct auth login` again.

**Cross-contamination is impossible:** every state file is bound to its host, and
loading a state file against a different host is refused —
`State file host (…) does not match … Refusing to mix instances.` — so `--env prod`
can never read or write a dev-bound state file.

**Version gate per env:** envs may run different ChurchTools versions.
`ct plan --env <name>` surfaces the target env's name **and** its live CT version
in the header (e.g. `env: prod · host: … · ChurchTools 3.123.0 · …`), so a
dev/prod version skew is visible before you promote.

## Protected environments

Mark an env `"protected": true` and **apply/destroy against it ALWAYS require
typed confirmation of the environment name — even with `--auto-approve` (apply)
or `--force` (destroy)**. For non-interactive/CI use, pass `--confirm-env <name>`,
which must match the target env name exactly and substitutes for the typed input:

```bash
ct apply --env prod                          # prompts: type "prod" to confirm
ct apply --env prod --auto-approve           # STILL prompts — auto-approve does not bypass a protected env
ct apply --env prod --auto-approve --confirm-env prod   # CI: applies (flag matches)
ct destroy --env prod --target old --confirm-env prod   # --force alone is NOT enough on a protected env
```

## Promotion workflow

Promote a change dev → prod, verifying against the rehearsal env before the real
one:

```bash
# 1. Plan + apply against dev (rehearsal)
ct plan  --env dev
ct apply --env dev

# 2. Verify the change on dev: re-plan should be a clean no-op (round-trip),
#    optionally recomputing dynamic-group membership.
ct plan  --env dev            # expect "No changes"
ct apply --env dev --refresh  # (only if the change touched dynamic groups)

# 3. Plan against prod — inspect the header's CT version and the diff carefully.
ct plan  --env prod

# 4. Apply to prod. Protected → confirm the env name (or --confirm-env prod in CI).
ct apply --env prod
```

Commit both state files (`ct-state.dev.json`, `ct-state.prod.json`) after each
apply — they are the record of what is managed on each instance.
