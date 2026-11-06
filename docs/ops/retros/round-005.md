# Retro round 005: release 0.5.0

- Date: 2026-11-06
- Change this round: the Sprint 4 work was cut as release 0.5.0, and small
  follow-up stories ran while the release waited for the owner's tag.

## Where the numbers come from

- **Repository delivery:** the pull requests merged into `main` on
  2026-11-06 after the round 004 retro (`gh pr list --state merged`), and the
  CI runs the orchestrator watched for each one.

## What shipped

| Merge | Stories                                                                           |
| ----- | --------------------------------------------------------------------------------- |
| #328  | release 0.5.0: versions, changelog and the upgrading guide                        |
| #329  | the release docs state the enforced gate (a pull request with passing checks)     |
| #331  | `npm run preflight` runs `spec-check` when a spec-linked test changes or is moved |

Issues #293 and #330 closed with these merges. #330 was filed during the
round, after #329 failed CI in a way preflight should have caught.

## What was slow

- **A cancelled job blocks a release.** One platform job on #328 was
  cancelled without a failure log, and the pull request stayed blocked until
  the job was rerun.
- **Preflight passed where CI failed.** #329 renamed a test that a spec
  links. Preflight ran `spec-check` only for changes under `specs/` or engine
  tests, so all four platform jobs failed at `spec-check` and cost one CI
  cycle. #331 closes that gap.
- **A stale shared dependency tree.** Worktrees that reuse the main
  checkout's `node_modules` missed a dependency added in 0.5.0, so the build
  failed until the worktree ran its own `npm ci`.
- **Advisory fixes wait on the owner.** Both advisory fixes are ready and
  merge cleanly, but merging one needs the owner to lift administrator
  enforcement for the merge.

## What review by a second model found

- In #331, a renamed spec-linked test still skipped `spec-check`, because the
  changed-files diff reported only a rename's new path. Diffing without rename
  detection now counts the old path as deleted.

## Hypotheses for the next rounds

1. **One changelog fragment per story (round 004): not tried.** The release
   assembled the changelog by hand again. Keep it for the next release.
2. **A local gate should check whatever links to the changed files.** The
   spec-check gap came from a link (a spec naming a test) that the change set
   did not include. Next change: look for other checks keyed on links, such as
   docs that name scripts or workflows that name test files.
3. **Tag the release commit, not the branch tip.** `main` moved past the
   release commit before the tag was pushed. Next change: the release handover
   names the release commit in the tag command.

## Deferred

- The 0.5.1 patch release, which waits on the advisory fix it carries.
- The engine declarations (#286) and MCP input bounds (#296).
- Repository settings for release tags and the npm environment (#289, #292).
- The managed draft-PR base branch, which waits on an owner decision (#277).
