# Contributing

## Operation projection rule

User-facing behavior starts in the transport-neutral operation catalog. Define canonical parameter
and result schemas once, then provide both CLI and HTTP bindings in the same change. The Commander
tree, router, capabilities and OpenAPI enumerate that catalog; do not maintain an independent route
or command list.

Adapters may map canonical input to flags/arguments or HTTP path/query/body fields and may render
results differently. They must not duplicate handlers, reconciliation, defaults, summaries,
confirmation policy or safety checks. Adapter-only mechanics such as pairing and terminal prompts
must be marked explicitly. Add or update catalog parity tests for every operation change.

This tool was built for one organisation's ChurchTools instance and then generalised, so
the most useful contributions are usually the ones that make it less specific to that
origin: another instance's API quirk, a field the engine does not manage yet, a
ChurchTools version where an endpoint behaves differently.

## Getting set up

```bash
npm ci
npm test                       # vitest — 570-odd unit tests, no network
npm run typecheck && npm run lint
npm run build                  # -> dist/index.js (the `ct` binary)
npm run dev -- get campuses    # run from source against a live instance
```

Node ≥ 20; the repo pins 22 via `.nvmrc`.

To run against a real instance, `ct auth login --host https://your.church.tools` stores
host + token in the **macOS Keychain**. There is no keychain backend on Linux or Windows —
export `CT_LOGINTOKEN` (and `CT_HOST`) instead. Never commit a token — see
[SECURITY.md](SECURITY.md).

## Things worth knowing before you change engine code

- **`plan` must stay honest.** A plan that under-reports a change is the worst bug this
  tool can have. Anything touching diffing needs a test that pins the rendered plan.
- **A clean apply must round-trip to a no-op.** If applying a config and re-planning shows
  a diff, the resource's `managedFields` are wrong — that is a bug, not a quirk.
- **People are out of scope, permanently.** `assertNotPeople` guards every write path.
  PRs that manage people will be declined regardless of quality; it is a boundary, not a
  gap.
- **Live-API tests are opt-in, and writes are triple-gated.** Reads need `CT_LIVE=1`.
  Writes additionally need `CT_LIVE_WRITE=1` **and** `CT_LIVE_WRITE_HOST` set to exactly
  the authenticated host — a deliberate barrier against a live write landing on prod.
  They must target a dev instance and clean up after themselves. CI never runs them.

## Documentation

Pages under `docs/handbuch/` declare the code they document in `sources:` frontmatter and
are signed with `sources_hash`. Change a documented source and CI fails until the page is
re-read and re-signed:

```bash
node .github/scripts/docs-staleness.mjs          # what CI runs
node .github/scripts/docs-staleness.mjs --sign   # after re-reading the page
```

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) —
`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. This is load-bearing, not
cosmetic: every push to `main` runs semantic-release, which derives the version and cuts
the GitHub Release from the commit history. A `feat:` gets a minor, a `fix:` a patch,
`BREAKING CHANGE:` in the body a major.

Open an issue before a large change so the design can be argued about before it is built.
Issues opened without a milestone are labelled `triage` automatically and picked up in the
weekly sweep; nothing is closed for being old.
