---
name: git-integration-worktree
description: Combine multiple open GitLab merge-request or GitHub pull-request branches in a disposable Git worktree for joint testing while keeping every review branch independent. Use when creating, updating, rebuilding, or diagnosing an integration test branch for several open changes; do not use for ordinary single-branch development.
---

# Integration worktree

Maintain a disposable integration branch in a separate Git worktree so open
merge requests remain individually reviewable while their combined behavior can
be tested.

## Invariants

- Keep every feature/MR branch independent. Merge only from feature branches
  into the integration branch, never from the integration branch back into a
  feature branch.
- Make feature improvements and their commits on the original feature branch.
  Then merge that updated branch into the integration branch and rerun tests.
- Never commit conflict resolutions or combined changes to a feature branch.
  Resolve integration-only conflicts on the integration branch. If a conflict
  reveals a real feature defect, fix it separately on the relevant feature
  branch and update the integration branch afterward.
- Treat the integration branch and worktree as disposable test infrastructure,
  not as a merge candidate for the target branch.
- Do not push the integration branch, create a draft MR/PR, or modify remote
  state unless the user explicitly requests it.
- Preserve unrelated and uncommitted work. Before switching, merging, removing
  a worktree, or rebuilding a branch, inspect `git status --short`,
  `git worktree list`, and the relevant refs. Stop if the exact safe target
  cannot be established.

## Workflow

1. Determine the target branch, the feature branch refs, a unique integration
   branch name, and a sibling directory for the worktree. Prefer names such as
   `test/all-open-mrs` and `../<repo>-integration`, but respect existing names.
2. Fetch remote refs when current remote state is needed and network access is
   authorized.
3. Create the integration worktree from the target branch. Never build it from
   a feature branch or from the user's dirty primary worktree.
4. Merge each feature ref into the integration branch with explicit merge
   commits (`--no-ff`) in a stable, recorded order. This makes the combined
   composition and later updates visible.
5. Install worktree-local dependencies if required, then run the repository's
   relevant type, lint, build, and test commands.
6. Report the target ref, integration branch, worktree path, merged feature refs
   and commit ids, merge order, conflicts, and test results.

## Updating one feature

After a feature branch receives new commits, fetch if necessary, enter the
integration worktree, merge the updated feature ref, and repeat the relevant
tests. Do not merge the integration branch into the feature branch.

If repeated update merges make the integration history confusing, offer to
rebuild it from the current target and current feature heads. Rebuilding may
delete or replace the disposable integration branch/worktree, so first verify
that its worktree is clean and obtain confirmation when the user has not already
requested that destructive rebuild.

## Typical command shape

Adapt names and test commands to the repository; do not copy placeholders
literally:

```bash
git fetch origin
git worktree add ../<repo>-integration -b test/all-open-mrs origin/<target>
cd ../<repo>-integration
git merge --no-ff origin/<feature-1>
git merge --no-ff origin/<feature-2>
<project test commands>
```

For a local feature branch whose newest commit has not been pushed, merge the
verified local branch ref instead of silently testing an older remote ref.
