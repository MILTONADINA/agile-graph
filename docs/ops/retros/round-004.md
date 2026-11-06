# Retro round 004: Sprint 4

- Date: 2026-11-06
- Change this round: a production-readiness audit filed its findings as
  issues, and each fix landed as one small story in a stacked merge train.
  Exploitable findings went to private security advisories instead of
  public issues.

## Where the numbers come from

- **Repository delivery:** the pull requests merged into `main` from
  2026-10-26 to 2026-11-06 (`gh pr list --state merged`), and the CI runs the
  orchestrator watched for each train.

## What shipped

| Merge | Stories                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #236  | engine coverage collected in the existing Ubuntu test run                                                                                                           |
| #238  | a run stops when review rejects the same finding twice                                                                                                              |
| #239  | the retro counts graph-owned stops that have no follow-up plan                                                                                                      |
| #240  | AGENTS.md routes readers by situation, with a test that locks its safety rules                                                                                      |
| #242  | `context_get`, `symbol_search` and `graph_neighbors` report evidence, unknowns and limits                                                                           |
| #245  | the reviewer rules on each security-scan finding by stable ID                                                                                                       |
| #250  | upgrading guide from 0.2.0                                                                                                                                          |
| #252  | release 0.4.0                                                                                                                                                       |
| #254  | property tests for the verification-config gate, with the fixes they found                                                                                          |
| #255  | `memory_propose` takes an optional `validFrom`                                                                                                                      |
| #257  | gate tests for `run-s`, `run-p`, `npm-run-all` and `tool.coverage` respelling                                                                                       |
| #263  | coverage train 1: Cursor runner, embeddings, project config, trust anchor                                                                                           |
| #271  | the Linux x64 platform job may run for 60 minutes                                                                                                                   |
| #299  | train 1: time-budget baseline verdict, cancellable git filter probe, root source listing                                                                            |
| #300  | the MCP server exits when its client closes stdin                                                                                                                   |
| #305  | the security gate says Docker is not installed when the binary cannot start                                                                                         |
| #314  | train 2: malformed JSON-RPC lines answered over stdio, non-ASCII symbol search, CLI flag and JSON input errors name the input                                       |
| #320  | train 3: unconfirmed container removal reported, unreadable CI workflows reported, denied endpoint hosts hidden from cloud clients, memory proposal origin recorded |
| #325  | train 4: malformed criterion lines reported, literals ignored when reading test switches, execution image pulled by digest, every scripts test run in CI            |

The four audit trains carried sixteen stories in four merges. Their lower
pull requests were closed after each train merged.

## What was slow

- **Stacked pull requests based on each other get no CI.** CI runs only on
  pull requests into `main`. Train 4's top pull request sat with no checks
  until every pull request in the stack was based on `main`; retargeting
  alone starts no run, so it was closed and reopened.
- **Advisory fixes drift while they wait.** A private fork's fix conflicts
  with `main` as soon as the next train merges, and an advisory fork has no
  CI. The fix was rebased twice and checked with `npm run preflight` each
  time.
- **Advisory merges need a protection change.** `main` enforces its rules for
  administrators, so the advisory page's "Merge and bypass branch
  protections" is refused until the owner switches that off for the merge.
- **Late review findings on the top of a train.** Unresolved review threads
  block a merge, and one finding on the top pull request reruns the whole
  train's CI.

## What review by a second model found

- The stdio size limit was checked before splitting lines, so one large
  batch refused small requests with it.
- Symbol search folded case but not the Greek final sigma.
- `--local-thinking-budget` refused 0, which is a valid budget.
- A criterion written `- AC9 (#274): ...` was dropped silently, and its test
  links were attached to the criterion above.
- The endpoint-host rewrite missed hosts with underscores.
- The literal-aware switch reader treated `/*` inside a regex as a comment
  and a slash after `x++` as a regex.
- The new CI step for scripts tests would have failed on Windows, where two
  of its tests assume POSIX file modes.

## Hypotheses for the next rounds

1. **Trains save CI runs (round 003): held.** Four merges carried sixteen
   stories. Next change: base every train pull request on `main` from the
   start, and check review threads ten minutes after opening.
2. **Changelog lines misfiled across releases (round 003): partly held.**
   Every rebase conflicted only in `CHANGELOG.md`. Next change: one
   changelog fragment per story, assembled at release.
3. **Upstream advisories arrive without warning (round 003): held.** Fifteen
   Dependabot alerts accumulated before an issue tracked them (#326). Next
   change: triage alerts weekly, with each one fixed or dismissed with a
   reason.
4. **New: a test file can exist without running.** Five scripts test files
   were never named by CI (#323). A test now fails when one is missing; the
   same check belongs on every suite that lists files by hand.

## Deferred

- The pinned root lockfile and engine declarations (#286), and the tool-hash
  input bounds that need a DevOPs pin update (#296).
- Repository settings for release tags and the npm environment (#289, #292).
- The managed draft-PR base branch, which waits on an owner decision (#277).
