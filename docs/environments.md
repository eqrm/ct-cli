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

### Process workspaces

`ct init <directory> --template process --host <url> --env <name>` creates a process-oriented
workspace whose environment uses an explicit hostname-bound state path:

```json
{
  "environments": {
    "prod": {
      "host": "https://example.church.tools",
      "state": "instances/example.church.tools/ct-state.example.church.tools.json",
      "protected": true
    }
  }
}
```

The corresponding empty state is written immediately with the same normalized host. This makes the
instance binding reviewable from the first commit and avoids creating a hostless `ct-state.json`.
Additional instances follow the same invariant: hostname directory, state filename, state content
and environment host must all identify the same ChurchTools instance.

Run `plan` and `apply` from the process directory with an explicit environment, for example
`ct plan -e prod`. The existence of `ct.envs.json` does not yet make `--env` mandatory: changing that
single-instance fallback is a separate, engine-wide safety decision rather than scaffold behavior.

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
