# Retro round 001: Sprint 1

- Date: 2026-10-18
- Change this round: the local preflight from round 000 (hypothesis 5),
  merge trains of stacked PRs, and a hardening backlog shipped as small
  stories, each reviewed by a different model before it joined a train.

## Where the numbers come from

- **Repository delivery:** GitHub Actions history of the `Platform checks`
  pull-request runs created from 2026-10-13 to 2026-10-18, read with
  `gh api`, and the pull requests merged in the same window.

## What shipped

| Train     | Stories                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- |
| #167      | refuse path globs that could backtrack for minutes                                                 |
| #170–#175 | resume and review fixes, SDK and Node 22 floor, the security policy                                |
| #178      | release 0.1.2, with npm provenance                                                                 |
| #180–#184 | edits held to shown lines, fatal-error shutdown, dashboard headers, a gitleaks job, property tests |

One security advisory was published with the 0.1.2 release.

## What was slow

| Repository CI (26 PR runs) | Value                                   |
| -------------------------- | --------------------------------------- |
| Passed                     | 6, median 35 minutes (23 to 37)         |
| Failed                     | 3, median 30 minutes before the failure |
| Cancelled                  | 17, lower PRs of stacks, by design      |

Thirteen pull requests reached `main` through four merges and nine
completed CI runs, so a story cost about 0.7 full CI runs. The cost moved
into the trains: a train waits for its slowest story, and a rebase after another merge restarts a 35-minute
cycle (the strict up-to-date rule).

Of the 3 failed runs:

- 2 failed the Linux Dart syntax indexing test, the same binding failure
  round 000 counted. It still has no fix and still costs a full cycle.
- 1 failed on macOS only: a test of the 413 body limit sent a real request
  and the runner reset the connection. It now injects the request instead.

## What the preflight changed

The preflight caught failures before CI on two stories (a resume test that
no longer showed its worker the edited file, and a flaky ceiling test whose
worker edited a file it was never shown). Neither reached CI. It did not
catch the Linux Dart or macOS network failures, which need the platform.

## What review by a second model found

Every story was reviewed by a different model than the one that wrote it,
and the review found real defects before merge: a security policy that
claimed more than the provenance shows, and a Node floor one minor release
too low for the type stripping the engine relies on. One more review thread arrived after a push and cost a
cycle; reviews now finish before a branch joins a train.

## Hypotheses for the next rounds

1. **Platform-only failures still cost full cycles.** Confirmed: all 3
   failures were platform-specific. Next change: fix or quarantine the Linux
   Dart indexing test (#185), and keep network-free HTTP tests.
2. **A patch's `before` text is unique when it splits into two parts.**
   Refuted by a property test: overlapping matches pass as unique (#179).
   Next change: count overlapping matches.
3. **Trains trade CI runs for waiting.** To measure next: minutes from a
   story's review to its merge, inside a train and alone.

## Deferred

- Per-check durations on `verification.completed` (from round 000).
- Coverage for startup faults before the fatal-error handler is installed.
