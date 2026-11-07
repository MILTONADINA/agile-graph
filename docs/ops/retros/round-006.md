# Retro round 006: patch releases 0.5.1 and 0.5.2

- Date: 2026-11-06
- Change this round: two advisory fixes were merged through their private
  forks and cut as patch releases, and a preflight follow-up ran while the
  releases waited for the owner's tags.

## Where the numbers come from

- **Repository delivery:** the commits on `main` after the round 005 retro
  (`git log 5596ca86..origin/main`), and the CI runs the orchestrator watched
  for each pull request.

## What shipped

| Merge          | Stories                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| #334           | the preflight rename test ignores the developer's git configuration      |
| GHSA-6g95 fork | the verification-config gate reads `npm-run-all` overwrite options       |
| #335           | release 0.5.1                                                            |
| GHSA-8v9m fork | the release workflow publishes from a job that runs no dependency code   |
| #336           | release 0.5.2                                                            |
| #338           | preflight warns and runs `spec-check` when it cannot read the spec links |

Issue #333 closed with #338. It was filed in round 005's checklist review of
#331.

## What was slow

- **Advisory forks have no CI.** A private fork runs no workflows, so each fix
  was checked locally before the merge: a rebase onto `main`, the related
  tests and `npm run preflight`. Merging still needs administrator
  enforcement lifted for a moment, because the branch rules refuse the
  advisory merge otherwise.
- **Rebases of old fork branches.** Both forks were branched before releases
  that touched the same files (`CHANGELOG.md`, `docs/publishing.md`). Each
  conflict was small, but a changelog entry could land under a released
  version, and once it did, before the 0.5.1 merge.
- **A wait loop that read an empty status as done.** A background wait on
  #336 stopped when a check reported an empty conclusion. Reading the check
  bucket (`pass`, `fail`, `pending`) instead of the conclusion fixed it.

## What review by a second model found

- In #338, the fallback that treats every touched test file as spec-linked
  first matched only JavaScript and TypeScript names. It now matches any
  `*.test.*` file. The review also found that the new constant had separated
  `planPreflight` from its doc comment.

## Hypotheses for the next rounds

1. **Rebase advisory forks right after each release.** A fork that waits
   across releases conflicts in the changelog and docs. Next change: rebase
   every open advisory fork when a release merges, and check where its
   changelog entry lands.
2. **One changelog fragment per story (round 004): not tried.** The two patch
   releases assembled their changelogs by hand again.
3. **Tag the release commit, not the branch tip (round 005): applied.** The
   0.5.2 handover names the release commit (`3fadf0db`) in the tag command.

## Deferred

- Publishing the 0.5.2 packages and the GHSA-8v9m advisory, which wait for
  the owner's tag and approval.
- #286 (engine declarations need `@types/node`), which changes a pinned
  lockfile resolution and adds a consumer typecheck to the npm smoke test.
