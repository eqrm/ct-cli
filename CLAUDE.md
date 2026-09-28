# Working in ct-cli

Read `CONTRIBUTING.md` first: it has the checks CI runs (`format:check`, `lint`, `typecheck`, `test`, `build`), the docs signing step and the commit convention. This file adds what past sessions had to learn the hard way.

## This repo is public

Everything here is world-readable: code, comments, tests, docs, commit bodies, PR titles and descriptions, and issue comments. Keep instance-specific data out, meaning real campus, Bereich or group names, person ids and internal group keys (`sLL-*`, `sFlow*`). Use neutral placeholders instead. Per-instance values belong in the private `eqrm/ct-structure`. Endpoint facts and "verified on prod" provenance notes are fine. Before pushing, scan the diff _and_ the PR body, and before merging, scan the squash message you're about to write.

## Merging is releasing

Every push to `main` runs semantic-release, and a squash merge takes the PR title as the commit subject, so the title decides the version:

- The angular preset does not parse `!`. A `fix(x)!:` title produces **no release**. For a major, use a plain `feat(...)`/`fix(...)` subject and pass a body that ends in a `BREAKING CHANGE:` footer (`gh pr merge --squash --subject … --body-file …`).
- In a stack, merge one PR at a time and let its Release run finish before merging the next.
- After merging, confirm the release (`gh release list`) and that the version reached GitHub Packages (`npm view @eqrm/ct-cli version`), since that is where ct-structure installs from.
- Downstream bumps go in a separate PR in `eqrm/ct-structure`. Open it but don't merge it unless asked: merging there applies to the dev instance.

`Closes #a, #b` closes only `#a`. Repeat the keyword (`Closes #a, closes #b`), and after merging check every referenced issue with `gh issue view <n> --json state`.

## Live API work

- Run `ct auth status` before any live probe. The authenticated host changes between prod and dev, so don't carry it over from memory.
- Keep probes small. Prefer the OpenAPI spec, then a single collection GET. A per-resource sweep rate-limited prod once. Ask before any fan-out.
- Dev writes are fine when the user asks, as long as they leave the instance as they found it: create one disposable `zz-ct-probe-<date>` row, exercise it, delete it, then re-read and compare against the baseline.
- The login token is permanent and carries its owner's full rights, so features that hand out credentials build on the host-bound session the CLI already caches (`src/auth/sessionStore.ts`) instead of printing or persisting the token.
