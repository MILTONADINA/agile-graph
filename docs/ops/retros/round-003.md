# Retro round 003: Sprint 3

- Date: 2026-10-26
- Change this round: stories ran as parallel API leads, each in its own
  worktree. A cheap local judgment routed each story by difficulty first, and
  reviewed stories were stacked into merge trains with CI on the top only.

## Where the numbers come from

- **Repository delivery:** the pull requests merged into `main` from
  2026-10-19 to 2026-10-26 (`gh pr list --state merged`), and the CI runs the
  orchestrator watched for each train.

## What shipped

| Merge | Stories                                                                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #213  | minor and patch dependency updates after the rename                                                                                                                                 |
| #214  | Laya sidecar 0.4.12                                                                                                                                                                 |
| #219  | npm Dependabot limited to security updates, Jev key from the login keychain, release SBOMs, parser property tests, Windows close releases every handle, `--ignore-scripts` installs |
| #227  | lockfile advisory fixes, zod 4 with bounded arrays, untrusted prompt data, licence allowlist, support policy, dashboard time zone, README quick-start check, reproducible packing   |
| #229  | release 0.3.0                                                                                                                                                                       |
| #231  | new-dependency gate for worker patches, engine coverage floor, preflight lint on warnings                                                                                           |
| #233  | structured request log                                                                                                                                                              |

Twenty-four stories reached `main` in seven merges. The lower pull requests of
each train (#216 to #218, #226) were closed after their train merged.

## What was slow

- **Upstream advisories broke the audit gate mid-sprint.** New high
  advisories (body-parser, and zod with no 3.x fix) made every pull request
  fail `npm audit`. Unblocking took a lockfile update and a zod 4 migration
  before any other train could merge.
- **One credential outage cost a batch.** A revoked API credential, then a
  burst of parallel leads, failed sixteen stories before they did any work.
  The dispatcher now retries after a credential cooldown and runs three
  leads at a time.
- **A reboot removed temporary worktrees.** Committed work survived on its
  branches; seven stories that had not committed restarted. Worktrees now
  live outside the system temporary directory.
- **The coverage pass doubled a test run.** The Linux platform job ran past
  its 45-minute limit once; it now has 60 minutes, and #232 tracks folding
  coverage into the main test run.

## What review by a second model found

- The SBOM named the private workspace root as its subject, dropped the
  engine's optional peers under `--omit dev`, and later kept the engine's
  dev-only type packages. All three were fixed before merge.
- The keychain lookup searched every keychain instead of the login keychain.
- A refactor of the scripts' entry check into a shared module broke the
  tests that run a copied script on its own; it was dropped.
- Preflight linted changed files without `--max-warnings 0`, so it passed
  a warning CI would fail (fixed in #231).

## Hypotheses for the next rounds

1. **Trains save CI runs.** Seven merges carried twenty-four stories. Keep
   stacking reviewed stories, and rebase a train as soon as `main` moves.
2. **Cherry-picking across a release misfiles changelog lines.** A story
   branched before a release puts its lines in the released section. Next
   change: check the `[Unreleased]` section after every stack.
3. **Upstream advisories arrive without warning.** Next change: a scheduled
   audit run on `main`, so a new advisory opens an issue before it blocks a
   pull request.

## Deferred

- Folding coverage into the main test run (#232).
- Preflight building the engine before script tests that need it (#228).
- Root causes of the Dart (#185) and RSS (#188) flakes remain closed as
  diagnosed; reopen if they recur.
