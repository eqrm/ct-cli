# ct-cli documentation

Two audiences, kept apart on purpose (#89).

## `handbuch/` — published, reader-facing

The **generic ChurchTools reference**: how ChurchTools' own permission model,
dynamic groups and field definitions behave, independent of any one instance.
These pages are published into a wider ChurchTools Handbuch, so they carry
`sources:` frontmatter and are gated by the staleness checker (#89).

| Page                                                             | About                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| [`handbuch/index.md`](handbuch/index.md)                         | Section overview                                              |
| [`handbuch/permissions.md`](handbuch/permissions.md)             | Grant domains, `domainId` semantics, scope resolution         |
| [`handbuch/dynamic-groups.md`](handbuch/dynamic-groups.md)       | Auto-groups, the ChurchQuery DSL, portable rulesets           |
| [`handbuch/field-definitions.md`](handbuch/field-definitions.md) | Person master data, security levels, custom-field definitions |
| [`handbuch/blueprints.md`](handbuch/blueprints.md)               | Parametrized, reusable structure                              |

**A page publishes only if it lives under `handbuch/` and is reachable from
`handbuch/mkdocs.yml`'s nav.** Everything else in `docs/` stays invisible.

Build it locally:

```bash
python3 -m venv .venv-docs && .venv-docs/bin/pip install -r docs/handbuch/requirements.txt
.venv-docs/bin/mkdocs build -f docs/handbuch/mkdocs.yml --strict
```

### Re-signing a page

Each page declares the code it documents in `sources:` and signs it with
`sources_hash`. A PR that changes a declared source without re-signing the page
fails the `Docs / staleness` check — the point being that someone re-read the
page against the new code. Bumping `reviewed:` alone does **not** satisfy it.

The signature is a sha256 over each resolved file's
`<repo-relative-path>\0<contents>\0`, files sorted, truncated to 16 hex chars.
Check and re-sign locally:

```bash
node .github/scripts/docs-staleness.mjs          # what CI runs
node .github/scripts/docs-staleness.mjs --sign   # re-sign, after re-reading
```

A page with no code behaviour to track declares `sources: []` plus a
`sources_exempt_reason:` instead.

## Everything else — developer- and operator-facing, unpublished

| Page                                                     | About                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`adoption-contract.md`](adoption-contract.md)           | What else comes along when `ct adopt` adopts one resource — the five categories and their defaults |
| [`external-resources.md`](external-resources.md)         | Read-only cross-project bindings, `ct use`, identity validation, state, and ownership checks       |
| [`api-coverage.md`](api-coverage.md)                     | Which ChurchTools endpoints support which CRUD verbs                                               |
| [`group-field-decisions.md`](group-field-decisions.md)   | Which group fields are managed vs. left to the CT UI, and why                                      |
| [`runbook-manual-surface.md`](runbook-manual-surface.md) | What `ct` cannot automate today — where the write path is missing, and the manual steps around it  |
| `superpowers/`                                           | Historical implementation plans; kept as a record, never published                                 |
