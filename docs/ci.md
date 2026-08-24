# CI usage & machine-readable output

`ct` runs non-interactively out of the box — every state/host-touching command
works from a CI runner with no OS keychain.

## Authentication

### The auth model

The personal login token authenticates via a session handshake, **not** an
`Authorization` header:

1. `GET /api/whoami?login_token=<token>` → sets the session cookie
2. `GET /api/csrftoken` → CSRF token
3. every request sends the cookie; every write sends `CSRF-Token`

### In CI

Skip the keychain with two env vars (see
[`src/auth/tokenStore.ts`](https://github.com/eqrm/ct-cli/blob/main/src/auth/tokenStore.ts)):

```bash
export CT_HOST=https://mychurch.church.tools
export CT_LOGINTOKEN=<personal login token — from a CI secret>
ct plan
```

`CT_LOGINTOKEN` always wins over stored credentials, so this works even on a
machine that also has an interactive login. Under `--env`, a profile's
`tokenEnv` (in `ct.envs.json`) names the secret env var to read for that
target — see [Environments](environments.md) — and a protected env's
apply/destroy still needs `--confirm-env <name>`; `CT_LOGINTOKEN`/`CT_HOST`
alone do not bypass that guardrail.

## Detecting whether there are changes: `--detailed-exitcode`

Terraform-style. With the flag, `ct plan` exits:

| Exit code | Meaning                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `0`       | no changes — desired state already matches ChurchTools (resources AND permissions)                                           |
| `1`       | error — the plan is INCOMPLETE (a resource or permission fetch failed), or the command failed outright                       |
| `2`       | changes are pending — at least one resource item is not a no-op, OR at least one permission item has a grant/revoke to apply |

Without the flag, behaviour is byte-identical to before: `ct plan` exits `1`
only on an INCOMPLETE plan/error, `0` otherwise — so existing scripts that just
check for a nonzero exit code keep working unchanged.

```bash
ct plan --detailed-exitcode --env prod
case $? in
  0) echo "no changes" ;;
  1) echo "plan failed"; exit 1 ;;
  2) echo "changes pending — needs review/apply" ;;
esac
```

**Drift alone never sets exit `2`.** `--detailed-exitcode` mirrors what `ct
apply` would actually _do_ — an item can carry drift (ChurchTools changed
since the last apply) while its `action` stays `no-op` (the drifted field
isn't managed by the current config, or happens to already match it), and
`apply` would write nothing for it. Drift is always visible in the human
render's "Drift detected" section and in `--json`'s per-item `drift` array
regardless of the exit code — see below.

An INCOMPLETE plan is always exit `1`, even with `--detailed-exitcode` and
even if the (partial) plan has changes: an incomplete diff can't be trusted
enough to report "changes pending" instead of "this run failed".

## Plain-language review report: Markdown

`ct plan --format markdown` renders the same resource and permission plan as a
self-contained Markdown document for people who do not need to understand the
terminal diff or raw JSON:

```bash
ct plan --env prod --format markdown > plan-prod.md
```

The report starts with the target environment, host, ChurchTools version,
configuration and state host. It distinguishes creates, updates, drift,
delete candidates, permission grants/revocations, preserved grants and an
incomplete plan. A delete candidate is explicitly described as something
`ct apply` will **not** delete. Automatic groups receive a semantic summary;
all current and future resource types remain visible through a generic
technical appendix.

German is the deterministic default. Select English explicitly when needed:

```bash
ct plan --env prod --format markdown --locale en > plan-prod.md
```

The command computes the live plan only once even when several projections are
needed. Repeat `--format` and give one base name; `ct` adds a stable extension:

```bash
ct plan --env prod \
  --format text \
  --format json \
  --format markdown \
  --output-base reports/plan-prod

# reports/plan-prod.txt
# reports/plan-prod.json
# reports/plan-prod.md
```

For a single projection, `--output-base` follows the same convention. If the
base already ends in `.txt`, `.json`, `.md` or `.markdown`, that known extension
is replaced with the selected format's extension. Multiple formats without
`--output-base` are rejected so two documents can never be concatenated
ambiguously on stdout.

`--json` remains the backward-compatible stdout alias for `--format json`.
Combining the alias with `--format` is rejected rather than guessing which
request wins.

The Markdown renderer performs no additional ChurchTools request and does not
recalculate actions or safety policy. It consumes the same structured plan as
terminal and JSON output. Fields whose names look like credentials, tokens,
passwords or secrets are redacted in both the readable body and technical
fallback.

To publish the report as a GitHub Actions artifact:

```yaml
- name: Create review plans
  env:
    CT_LOGINTOKEN: ${{ secrets.CT_LOGINTOKEN }}
  run: |
    mkdir -p reports
    ct plan --env prod --format json --format markdown --output-base reports/plan-prod

- name: Upload plan reports
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: churchtools-plan
    path: reports/plan-prod.*
```

## Machine-readable output: `--json`

`ct plan --json` prints **only** the plan JSON to stdout — the env/host
header and any `INCOMPLETE`/permission-catalog warnings go to stderr, so
piping/`jq`-ing stdout is always safe. It composes with `--detailed-exitcode`:
the exit code is derived from the exact same data that lands on stdout.

Shape:

```jsonc
{
  "plan": {
    "items": [
      {
        "type": "group",
        "key": "kids",
        "id": 7,
        "action": "update",
        "changes": [{ "field": "name", "from": "Kid's", "to": "Kids", "source": "config" }],
        "drift": [{ "field": "campusId", "from": 4, "to": 9 }],
      },
    ],
  },
  "permissions": [
    /* PermissionPlanItem[]: { key, domainType, domainId, pendingDomain?, diff: { toPut, toDelete, preserved } } */
  ],
  "summary": {
    "resources": { "create": 0, "update": 1, "delete": 0, "no-op": 3 },
    "drifted": 1,
    "permissions": { "toPut": 0, "toDelete": 0, "preserved": 0 },
    "hasChanges": true,
  },
}
```

### Distinguishing drift from a config change

Per resource item:

- `changes` is what `ct apply` would actually write: desired config vs. the
  live ChurchTools value, field by field. Every `changes` entry on a create
  is necessarily `"source": "config"` (there is no live baseline yet to
  drift from). On an update, each entry carries a best-effort `source`,
  attributed from the same three values the engine already has — the
  last-known state snapshot, the desired config, and the fetched actual:
  - `"config"` — ChurchTools still matches the last-known snapshot; the
    diff exists purely because the desired config changed since the last
    apply.
  - `"drift"` — the config is unchanged, but ChurchTools was edited
    manually since the last apply; applying reverts that manual edit.
  - `"config+drift"` — both moved independently (config changed AND
    ChurchTools drifted) to values that don't coincide.
- `drift` (top-level, on the item) is informational and present whenever
  non-empty: every field where ChurchTools has moved away from the
  last-known state snapshot, regardless of whether the current config even
  manages that field — a **superset** of what `changes[].source` narrows
  down to only the fields `apply` will actually touch.
- **Permission items carry no `source`.** The state file snapshots managed
  _resource_ fields only, not granted permissions, so there is no
  last-known baseline to attribute a permission diff to config-vs-drift.
  `diff.toPut`/`diff.toDelete` is honestly just desired-vs-actual — this is
  the one place the tool cannot make the distinction, so it doesn't
  pretend to.
- **A permission domain declared by reference to a same-run-created group
  type** (e.g. `ct.groupTypeRole({ groupType: "struktur", ... })` against a
  fresh instance where `struktur` is itself in the create-set) plans as a
  **pending domain** instead of aborting. Its `domainId` is `null` and it
  carries a `pendingDomain` object (the logical reference, e.g.
  `{ kind: "group-type", key: "struktur", __ctRef: true }`); the human render
  shows `<group-type:struktur (created this apply)>`. Its grants land in
  `diff.toPut` and count toward `summary.permissions.toPut`, `hasChanges`,
  and exit code `2` — so a fresh-instance `ct plan` reports the create-set +
  pending grants rather than failing. `ct apply` re-resolves the real domain
  id after the group type is created and reconciles the grants in the same
  run. The hard error is reserved for references that resolve to nothing at
  all (a key absent from the config, state, and the live catalog — a typo).

## Posting a plan as a PR comment

The human renderer (`renderPlan` / `renderPermissionPlan`) is safe to paste
into a GitHub PR comment: it uses `picocolors`, which disables ANSI color
whenever stdout isn't a TTY or `NO_COLOR` is set, and the `+`/`~`/`-`/`!`/`?`
line prefixes already carry the create/update/delete/drift/unresolved meaning
— the rendering reads cleanly with no color at all.

**One GitHub Actions gotcha:** picocolors treats the `CI=true` env var (set by
every GitHub Actions runner) as its own signal to force color ON, even when
stdout is redirected to a file — so `ct plan > plan.txt` on a runner still
embeds ANSI escapes unless you override it. Set `NO_COLOR=1` when capturing
output for a PR comment:

```yaml
- name: Plan
  id: plan
  env:
    CT_HOST: ${{ vars.CT_HOST }}
    CT_LOGINTOKEN: ${{ secrets.CT_LOGINTOKEN }}
    NO_COLOR: "1"
  run: |
    set +e
    ct plan --detailed-exitcode > plan.txt
    echo "exitcode=$?" >> "$GITHUB_OUTPUT"
    set -e

- name: Comment plan on PR
  if: always()
  uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const body = fs.readFileSync('plan.txt', 'utf8');
      const exitcode = '${{ steps.plan.outputs.exitcode }}';
      const verdict = exitcode === '0' ? 'No changes' : exitcode === '2' ? 'Changes pending' : 'Plan FAILED';
      await github.rest.issues.createComment({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        body: `### ct plan — ${verdict}\n<details><summary>Show plan</summary>\n\n\`\`\`\n${body}\n\`\`\`\n</details>`,
      });
```
