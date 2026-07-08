# ct-cli

ChurchTools **structure-as-code** CLI. Describe the _overarching, rights-bearing
structure_ of a ChurchTools instance — campuses, structural groups, hierarchies,
group types/roles, permission & auto-groups — as versionable **desired-state
code**, and reconcile it idempotently against the ChurchTools API with
Terraform-style **`plan` / `apply`**.

> **People are never managed.** This tool touches only the scaffold, and only
> resources that are _explicitly_ declared or adopted. Everything else is
> invisible: never shown, never changed, never proposed for deletion.

## Two-repo model

| Repo                          | Contents                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| **`eqrm/ct-cli`** (this repo) | The tool: CLI, API client, plan/apply engine. Generic, reusable.                              |
| **`eqrm/ct-structure`**       | Equippers' actual desired-state config (`.ts` blueprints) + state file. Depends on this tool. |

Like Terraform, the tool never lives in the same repo as the infra config.

## Status

Early scaffold. See the [epic (#1)](https://github.com/eqrm/ct-cli/issues/1) and phase issues.

- ✅ **Phase 0 — Spike** ([#2](https://github.com/eqrm/ct-cli/issues/2)): API CRUD coverage mapped — see [`docs/api-coverage.md`](docs/api-coverage.md). Instance runs CT **3.123.0**; 7 resources have full CRUD.
- ✅ **Phase 1 — CLI + client** ([#3](https://github.com/eqrm/ct-cli/issues/3)): `auth login`, `get` commands, session handshake.
- ✅ **Phase 2 — Read/Adopt** ([#4](https://github.com/eqrm/ct-cli/issues/4)): `ct adopt` + JSON state file.
- ✅ **Phase 3 — Declarative engine** ([#5](https://github.com/eqrm/ct-cli/issues/5)): config DSL, `plan`/diff, dependency graph, group hierarchy.
- ✅ **Phase 4 — Apply + guardrails** ([#6](https://github.com/eqrm/ct-cli/issues/6)): `ct apply` / `ct destroy`, confirmation, backup, `preventDestroy`.
- ⬜ Phase 5: blueprints.

## Requirements

- Node ≥ 20 (repo pins 22 via `.nvmrc`)
- A ChurchTools **personal login token** (ChurchTools → your user settings)

## Install (dev)

```bash
npm ci
npm run build        # -> dist/index.js (the `ct` binary)
npm link             # optional: puts `ct` on your PATH
```

## Usage

```bash
# The host is captured at login (stored with the token). No hardcoded default —
# CT_HOST overrides the stored host for CI / one-off use.
ct auth login --host https://mychurch.church.tools --token <personal-login-token>
ct auth status                                  # who am I?

ct get campuses            # JSON to stdout — pipe into jq
ct get groups
ct get group-types
ct get raw /groups/42      # arbitrary GET

ct adopt campus 0          # bring an existing resource under management (→ state file)
ct state list              # show the managed set
ct plan                    # diff the desired-state config against ChurchTools (read-only)
ct plan --json             # the raw plan as JSON

ct apply                   # create + update in dependency order (confirmation + backup first)
ct apply --auto-approve    # skip the prompt (CI); apply NEVER deletes
ct destroy --target old    # explicit, protected deletion (typed confirmation)
```

`apply` reconciles **creates and updates** only, in dependency order, saving
state after each action (crash-safe / resumable). It **never deletes**: a
resource dropped from the config is surfaced as a notice pointing at `destroy`.
Before any write it prints the plan, asks for confirmation (`-y` to skip), and
writes a JSON backup of the affected resources to `backups/` beside the state
file (override with `--backup-dir` / `CT_BACKUP_DIR`).

`destroy` deletes only the resources named by `--target` (repeatable or
comma-separated), in reverse dependency order, after a typed confirmation
(`--force` to skip). A resource declared with `preventDestroy: true` is blocked
until that flag is removed from the config.

The desired state lives in a config file (default `ct.config.ts`) that
default-exports a function receiving the DSL:

```ts
export default (ct) => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
  ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupTypeId: 2 });
  // Hierarchy is opt-in and multi-parent: `parents` are managed group keys, each declared
  // in this config. Omit it to leave a group's hierarchy unmanaged; edges to unmanaged
  // groups stay invisible. (`parent:` is unrelated — an ordering hint only, not hierarchy.)
  ct.group({ key: "mainz_kids_lead", name: "Mainz · Kids Leitung", groupTypeId: 2, parents: ["mainz_area"] });
};
```

Machine-readable output goes to **stdout** (pipe/`jq` it); human status lines go
to **stderr**.

## Auth model

The personal login token authenticates via a session handshake, **not** an
`Authorization` header:

1. `GET /api/whoami?login_token=<token>` → sets the session cookie
2. `GET /api/csrftoken` → CSRF token
3. every request sends the cookie; every write sends `CSRF-Token`

## Development

```bash
npm run dev -- get campuses   # run from source (tsx)
npm test                      # vitest
npm run typecheck
npm run lint
npm run format
npm run generate:client       # regenerate the typed client from the live OpenAPI spec
```

## Guardrails (by design)

- `plan` is the default; `apply` is explicit, with a confirmation prompt.
- `apply` never deletes; destruction is explicit via `destroy --target`.
- Destroy-protection (`preventDestroy` config flag); never implicit deletions.
- People/memberships are never touched (hard boundary in code).
- Backup/export before every `apply` and `destroy`.
- Rate-limit + retry on API calls (writes are never blindly re-sent on 5xx).
- Tokens live in the OS keychain / `.env`, never in git.
