# Retro round 007: release-path fix, published declarations and action pins

- Date: 2026-11-07
- Change this round: the stories came from the round 006 deferrals and the
  2026-11-06 audit. Each merged as its own pull request into `main` rather
  than in a train, because each was ready at a different time.

## Where the numbers come from

- **Repository delivery:** the pull requests merged into `main` from
  2026-11-07 (`gh pr list --state merged`), and the CI runs watched for each
  one.

## What shipped

| Merge | Stories                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------- |
| #341  | the release workflow publishes each tarball by a `./` path                                      |
| #343  | `@agile-graph/engine` depends on `@types/node`; the npm smoke runs a strict `nodenext` consumer |
| #344  | `web-tree-sitter` types stay out of the published declarations                                  |
| #345  | CI fails when a workflow action is not pinned to a full SHA with a version comment              |

Issues #286, #342 and items 2 and 3 of #290 closed with them. #342 was filed
while #343 was in review.

## What was slow

- **A release tag on a commit that cannot publish.** The 0.5.2 publish job
  read a bare tarball file name as a package spec. The fix (#341) is merged,
  but the tag must be moved to it before the packages can publish, and only
  the owner moves tags.
- **A new worktree has no dependencies.** `npm run preflight` failed with
  `prettier: command not found` in a fresh worktree. Linking the main
  checkout's `node_modules` would resolve the workspace packages to the main
  checkout, so each worktree ran `npm ci --ignore-scripts --prefer-offline`
  and the rebuild allowlist first.
- **A review thread after green CI.** #345 passed all checks, then waited on
  an automated review thread opened after the first push. Resolving it took
  a second CI cycle.
- **A smoke test that first allowed one error.** #343's consumer compile at
  first accepted one `web-tree-sitter` type error. It came from engine
  declarations that re-exported the parser's types, so #344 removed them, and
  the smoke now accepts no errors. That took a second story.

## What review by a second model found

- In #345, the first pin check matched `uses:` only at the start of a block
  line. A flow mapping (`{uses: ...}`), a quoted key, an escaped key
  (`"us\u0065s":`), an explicit `?` key or an alias key passed it. With no
  YAML parser installed, the check now refuses any line it cannot read in
  plain block form, and any explicit, escaped or alias key.
- Also in #345: composite actions under `.github/actions/` were not scanned,
  and Docker images pinned by digest were refused.

## Hypotheses for the next rounds

1. **Dry-run the exact publish command (new).** The release workflow's
   tests checked its structure, not what `npm publish <file>` does with the
   argument. Next change: a release-path change runs the publish command
   against a local tarball with `--dry-run` before merge.
2. **Rebase advisory forks right after each release (round 006): open.** No
   advisory fork was rebased this round. Check again after the 0.5.2 tag
   moves.
3. **One changelog fragment per story (round 004): not tried.** Each story
   still edited `CHANGELOG.md` directly.
4. **Security checks without a parser fail closed (new).** A line matcher
   that reads a structured format misses forms the format allows. Next
   change: a check like this refuses what it cannot read, and its tests list
   the format's alternate spellings.

## Deferred

- Moving the `v0.5.2` tag to the publish fix, then the 0.5.2 publish and the
  GHSA-8v9m update, which wait for the owner.
- #340 (MCP input bounds), held until 0.5.2 publishes.
- The repository setting that requires SHA pins (#290 item 1), the release
  tag ruleset (#292) and the npm environment (#289).
- The managed draft-PR base branch, which waits on an owner decision (#277).
- The GitHub Actions update #337: its `download-artifact` major bump runs only
  in the release job, which pull-request CI does not exercise.
