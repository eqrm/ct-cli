# ct-cli

**ChurchTools structure-as-code.** Describe the overarching, rights-bearing
structure of a ChurchTools instance — campuses, structural groups, hierarchies,
group types and roles, permissions, auto-groups — as versioned desired-state
code, and reconcile it against the ChurchTools API with Terraform-style
**`plan` / `apply`**.

> **People are never managed.** This tool touches only the scaffold, and only
> resources that are _explicitly_ declared or adopted. Everything else is
> invisible: never shown, never changed, never proposed for deletion.

## Why

A ChurchTools instance's structure is normally maintained by clicking. That
works — until you need to answer questions clicking cannot:

| Clicking                                    | With `ct`                                            |
| ------------------------------------------- | ---------------------------------------------------- |
| "Who changed this group's rights, and why?" | `git log`, and the PR that changed it                |
| "Set up the next campus like the last one"  | Call the same blueprint function again               |
| "Try it somewhere safe first"               | `ct plan --env dev` → `ct apply --env dev` → promote |
| "Has anyone edited this by hand?"           | `ct plan` reports drift against the last known state |
| "What will this actually change?"           | `ct plan` prints it before anything is written       |

## Show me

```ts
// ct.config.ts — no ChurchTools ids anywhere; names resolve per instance
export default (ct) => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });

  ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupType: "ministry_team" });
  ct.group({
    key: "mainz_kids_lead",
    name: "Mainz · Kids Leitung",
    groupType: "ministry_team",
    parents: ["mainz_area"],
  });
  ct.group({
    key: "mainz_kids",
    name: "Mainz · Kids",
    groupType: "ministry_team",
    campus: "mainz",
    parents: ["mainz_kids_lead"],
  });
};
```

```console
$ ct plan
  + campus.mainz
      name: "Mainz"
      shorty: "MZ"
  + group.mainz_kids_lead
      name: "Mainz · Kids Leitung"
      groupTypeId: 2
  ~ group.mainz_kids (#148)
      campusId: null -> 3

Drift detected (changed in ChurchTools since adoption):
  ! group.mainz_kids (#148): note = "bitte nicht loeschen" (last known "")

Plan: 2 to create, 1 to update, 0 to delete.
```

Nothing has been written yet. `ct apply` executes exactly that plan, in
dependency order, after a confirmation prompt and a backup.

## Install

Standalone binary — **no Node required**:

```bash
# macOS, Apple Silicon
curl -L -o ct https://github.com/eqrm/ct-cli/releases/latest/download/ct-darwin-arm64
# macOS, Intel
curl -L -o ct https://github.com/eqrm/ct-cli/releases/latest/download/ct-darwin-x64
# Linux, x64
curl -L -o ct https://github.com/eqrm/ct-cli/releases/latest/download/ct-linux-x64

chmod +x ct
sudo mv ct /usr/local/bin/ct   # or anywhere on your PATH
ct --help
```

With Node ≥ 20 already installed, the npm-pack tarball works too:

```bash
npm install -g https://github.com/eqrm/ct-cli/releases/latest/download/ct-cli.tgz
```

You also need a ChurchTools **personal login token** (ChurchTools → your user
settings). Each release additionally attaches an `INSTALL.md` with the exact
commands.

## First run

Create a config repository without having to assemble its files by hand:

```bash
mkdir bgk-ct-config
cd bgk-ct-config
ct init
```

In an interactive terminal, `ct init` collects the ChurchTools URL, the first environment name,
whether to initialize Git, and optionally a personal login token. The token input is hidden; when
provided on macOS, it is verified immediately and stored in the Keychain. On platforms without
supported secure credential storage, `ct init` does not request a token and explains how to use
`CT_HOST` and `CT_LOGINTOKEN` instead. For scripts, pass the non-secret answers explicitly and log
in through environment variables:

```bash
ct init --host https://example.church.tools --env prod --git --yes
CT_LOGINTOKEN=... ct auth login --host https://example.church.tools
ct coverage --env prod
```

The command creates `ct.config.ts`, `ct.envs.json`, `.gitignore`, `config/`, and `blueprints/`. It
refuses to overwrite existing scaffold files.

### Portable process workspace

Use the opt-in `process` template when one reusable ChurchTools process should live below
`processes/<name>/` in an existing repository and target one or more instances. Git remains opt-in;
pass `--no-git` when the parent repository already owns version control:

```bash
ct init processes/example-process \
  --template process \
  --host https://example.church.tools \
  --env prod \
  --protected \
  --no-git \
  --yes
```

The process template creates:

```text
processes/example-process/
├── ct.config.ts
├── ct.envs.json
├── .gitignore
├── README.md
├── blueprint/
├── configs/
└── instances/
    └── example.church.tools/
        ├── ct-state.example.church.tools.json
        ├── backups/
        ├── reference/
        └── reports/
```

`ct.config.ts` at the process root is the normal entry point, so no `-c` is needed. The generated
environment binds the normalized host to the state below its matching hostname directory; the empty
state is created immediately and no ambiguous `ct-state.json` is generated. Portable definitions
stay in `blueprint/`, while `configs/` is reserved for exceptional entry points such as a staged
bootstrap of an empty instance.

Run commands from the process directory and select the target explicitly:

```bash
ct plan -e prod
ct apply -e prod
ct plan -c configs/<bootstrap-config>.ts -e prod
```

Do not omit `-e`: enforcing that rule automatically whenever `ct.envs.json` exists is a separate
engine-wide safety change. Until then, an invocation without `-e` still selects the backward-
compatible single-instance mode. The scaffold contains no credentials or live ChurchTools IDs;
reports, backups and captured reference output are kept below their host-specific instance and
ignored by default, while the host-bound state remains trackable.

```bash
# The host is captured at login and stored with the token; CT_HOST overrides it for CI.
ct auth login --host https://mychurch.church.tools --token <personal-login-token>
ct auth status                # who am I?

ct get groups                 # JSON to stdout — pipe into jq (every page, not just the first)
ct adopt campus 0             # bring ONE existing resource under management
ct coverage                   # what the instance has that the config does not manage
ct state list                 # what is managed
ct state rm campus mainz      # un-adopt: drop it from state. Never touches ChurchTools.
ct plan                       # diff the config against ChurchTools (read-only)
ct apply                      # create + update in dependency order (confirm + backup first)
ct refresh --group <key>      # make ChurchTools re-evaluate one auto-group now
```

`state rm` is the inverse of `adopt`, and only of `adopt`: it removes the entry
from the state file, makes no HTTP call, and leaves the resource in place in
ChurchTools, now unmanaged. It refuses a key the config still declares — that
would make the next plan propose creating a resource that already exists — so
delete the declaration first, or pass `--force` to do both in one change.
"Declares" covers permission declarations too, not only resources: a key named
by a `ct.groupRole` domain or a group scope is just as broken to remove, and the
refusal is what keeps that from surfacing one command later as a plan error.

`apply` reconciles **creates and updates** only, saving state after each action
(crash-safe / resumable). It **never deletes**: a resource dropped from the
config is surfaced as a notice pointing at `destroy`. `destroy --target <key>`
deletes only what you name, in reverse dependency order, after a typed
confirmation — and a declaration marked `preventDestroy: true` blocks even that.

## What it manages

| Resource                                                                   | DSL                                                                                                            | Guide                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Campuses                                                                   | `ct.campus`                                                                                                    | [config guide](docs/configuration.md)             |
| Groups (fields, campus, multi-parent hierarchy)                            | `ct.group`                                                                                                     | [config guide](docs/configuration.md)             |
| Group types, roles, age/target groups, relationship types, person statuses | `ct.groupType`, `ct.roleDefinition`, `ct.ageGroup`, `ct.targetGroup`, `ct.relationshipType`, `ct.personStatus` | reusable building blocks                          |
| Permissions (group-role, group-type-role, person-status)                   | `ct.groupRole`, `ct.groupTypeRole`, `ct.status`                                                                | [permissions](docs/handbuch/permissions.md)       |
| Auto-groups (dynamic groups)                                               | the `dynamic` block on a group                                                                                 | [dynamic groups](docs/handbuch/dynamic-groups.md) |
| Repeated structure, parametrized                                           | a plain function over the DSL                                                                                  | [blueprints](docs/handbuch/blueprints.md)         |

Read-only by design: the person master-data model, security levels and
custom-field _definitions_ (`ct get person-masterdata`, `ct get data-fields`) —
schema in scope, per-record values never. See
[field definitions](docs/handbuch/field-definitions.md).

References are logical throughout: `groupType: "ministry_team"` resolves to that
instance's id at plan time, so the same config drives a dev and a prod instance
unchanged. Numeric ids remain an escape hatch everywhere — and where one is left
in place, `ct` says so rather than letting a host-specific id travel silently to
another instance.

`ct coverage` answers the other direction: what exists on the instance that the
config does not manage, and which of it could be declared today (per group _and_
role, with the blocking scope dimension named). `--json` makes it a CI gate.

## Environments and CI

One config repo, several ChurchTools instances, no file edits when switching:

```bash
ct plan  --env dev     # rehearse against the dev instance
ct apply --env dev
ct plan  --env prod    # SAME checkout — prod host, prod state file
ct apply --env prod    # protected env: type the env name to confirm
```

- [**Environments**](docs/environments.md) — `ct.envs.json`, per-env state files,
  protected environments, the dev → prod promotion workflow.
- [**CI usage**](docs/ci.md) — the auth model and token-from-secret setup,
  `--detailed-exitcode`, the `--json` plan shape, drift-vs-config attribution,
  and a copy-pasteable job that posts the plan as a PR comment.

## Guardrails (by design)

- `plan` is the default; `apply` is explicit, with a confirmation prompt.
- `apply` never deletes; destruction is explicit via `destroy --target`.
- Destroy-protection (`preventDestroy`); never implicit deletions.
- Protected environments: apply/destroy always require typed confirmation of the
  env name — `--auto-approve` / `--force` never bypass it.
- Per-env state files are host-bound: `--env prod` can never touch a dev-bound state.
- People and memberships are never touched (a hard boundary in code).
- Backup/export before every `apply` and `destroy`.
- Rate-limit + retry on API calls (writes are never blindly re-sent on 5xx).
- Tokens live in the OS keychain / `.env`, never in git.

## Two-repo model

| Repo                          | Contents                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- |
| **`eqrm/ct-cli`** (this repo) | The tool: CLI, API client, plan/apply engine. Generic, reusable.          |
| _your config repo_ (private)  | Your instance's desired-state config + state files. Depends on this tool. |

Like Terraform, the tool never lives in the same repo as the infra config — the config
repo holds an organisation's actual structure and stays private. This repo is the tool
only; it carries no instance data.

## Documentation

- [`docs/configuration.md`](docs/configuration.md) — writing the config: keys, portable references, escape hatches
- [`docs/environments.md`](docs/environments.md) · [`docs/ci.md`](docs/ci.md) — multi-instance and automation
- [`docs/handbuch/`](docs/handbuch/) — the **generic ChurchTools reference** (permissions, dynamic groups, field definitions, blueprints), published into the Handbuch
- [`docs/api-coverage.md`](docs/api-coverage.md) · [`docs/runbook-manual-surface.md`](docs/runbook-manual-surface.md) — what the API supports, and what still has to be done by hand
- [`docs/README.md`](docs/README.md) — how the docs are organised and how pages stay in sync with the code
- Runnable configs: [`examples/`](examples/)

## Development

```bash
npm ci
npm run build                  # -> dist/index.js (the `ct` binary)
npm link                       # optional: puts `ct` on your PATH
npm run dev -- get campuses    # run from source (tsx)
npm test                       # vitest
npm run typecheck && npm run lint
npm run generate:client        # regenerate the typed client from the live OpenAPI spec
```

Node ≥ 20 (the repo pins 22 via `.nvmrc`). Every push to `main` that lands a
`feat:`/`fix:`/breaking-change commit runs the full CI gate, compiles the
binaries, smoke-tests each on its native OS/arch, and — only if all of that is
green — cuts the version and publishes the GitHub Release via
[semantic-release](https://semantic-release.gitbook.io/). No manual tag push.

## Status

Phases 0–5 (spike → CLI/client → adopt/state → declarative engine → apply +
guardrails → blueprints) are complete. Phase 6 — reproducible instances,
environments, GitOps — is tracked in
[#19](https://github.com/eqrm/ct-cli/issues/19); the overall design lives in
[#1](https://github.com/eqrm/ct-cli/issues/1).

Built against a real ChurchTools instance, so a fair amount of the value here is the
written-down API archaeology — see [`docs/api-coverage.md`](docs/api-coverage.md) for
which endpoints actually support which verbs, and
[`docs/runbook-manual-surface.md`](docs/runbook-manual-surface.md) for what ChurchTools
gives no API for at all.

## Contributing

Issues and PRs are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports
go through [private vulnerability reporting](SECURITY.md), not a public issue.

## License

[MIT](LICENSE). Not affiliated with or endorsed by ChurchTools.
