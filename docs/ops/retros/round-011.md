# Retro round 011: streaming DAG scheduler and the 0.8.0 release

- Date: 2026-11-09 to 2026-11-10
- Change this round: the stories were the follow-ups filed in round 010 (#364,
  #365, #373) and the Laya dependency upgrade (#351). Story PRs were stacked
  on each other, so the release PR carried the last story through one CI run.

## Where the numbers come from

- **Repository delivery:** the pull requests merged into `main` on
  2026-11-09 and 2026-11-10 (`gh pr list --state merged`), and the release
  workflow run for `v0.8.0`.

## What shipped

| Merge | Stories                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| #376  | a frozen workspace snapshot per generation (#373, through #374) and a failure that blocks only its dependants (#365) |
| #378  | the optional review-round prior (#364, through #377) and release 0.8.0                                               |
| #380  | parallel steps import a shared memory once (#379)                                                                    |
| #381  | the #379 fix recorded under 0.8.0, which was not yet tagged                                                          |

`@agile-graph/engine` and `@agile-graph/contracts` 0.8.0 are published as
`latest` with SLSA v1 provenance, and the GitHub release carries the
changelog section. Issues #364, #365, #373 and #379 are closed. #351 is in
review as #382. #375 could not be reproduced on `main`; the evidence is on
the issue.

## What was slow

- **Spec links name tests by their exact title.** Splitting a slow test with
  `it.each` renamed it, and `spec-check` failed the release PR on every
  platform. Preflight catches this; it was skipped for that one commit.
- **A test with five full runs hit the 30-second timeout on Linux CI.** One
  case per test gives each run its own budget.
- **The automated reviewer found two real gaps after push** (a prior that took
  the first provider's record instead of the first usable answer, and verify-fix
  rounds that were never scored). Both were fixed with tests that fail without
  the fix, but each cost a CI cycle.
- **Probing one issue found another.** Testing #375 with two parallel cloud
  steps exposed a check-then-insert race in the shared-memory import (#379).
  Run-context engines share one SQLite file across parallel steps, so a lock
  inside one engine would not have helped; the fix is in SQL.
- **The release command was wrong.** The handed-over tag command signed with
  `-s`, but this repository's tags are annotated and unsigned, and the
  machine has no GPG key for that identity. The tag was then pushed one commit
  before the changelog PR merged. The published code was still right.
- **The checkpoint download needed a new host.** Hugging Face now redirects the
  model file to `us.aws.cdn.hf.co`, so provisioning stopped at the redirect
  until that host was allowed.

## What to keep

- Stack story PRs and let the release PR carry the last one through CI.
- A test that fails without the fix for every review finding.
- Compare old and new dependency pins on the same model and prompt before
  merging a model runtime upgrade.

## What to change

- Run preflight on every commit that renames a test, even a test-only one.
- Hand over tag commands that match the repository's existing tags, with no
  inline `#` comments (zsh does not treat them as comments when typed).
- Hand over the tag command only after the last PR it should include has
  merged.
