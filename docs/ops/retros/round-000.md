# Retro round 000: the baseline

- Date: 2026-10-12
- Change this round: none. This round only measures, so later rounds have a
  before number to beat.

## Where the numbers come from

- **Managed runs:** `graph-engine retro` over this project's 12 managed runs
  (2026-09-22 to 2026-10-10), all of them local dogfood runs of Agile Graph
  on itself.
- **Repository delivery:** GitHub Actions history of the last 100 pull-request
  runs of the `Platform checks` workflow, read with `gh api`.

## What was slow

The numbers below use the retro's final definitions (wall-clock phase spans
that count a multi-step plan's steps, and failure signatures that include
each check's output tail). An earlier draft of this page used a first
version that ignored output and counted 2 repeated failures; with the final
signature there are none, and the hypotheses below say so.

| Managed runs (12)                       | Value                              |
| --------------------------------------- | ---------------------------------- |
| Succeeded / failed                      | 3 / 9                              |
| Minutes from first event to end         | 1,348 in total, median 3.4 per run |
| Stopped, waiting for a person to resume | 1,278 (95%)                        |
| Worker / verification / review          | 25.9 / 14.6 / 0.6                  |
| Waiting outside any phase               | 28.9                               |
| Worker attempts / verifications         | 17 / 8                             |
| First verification passed               | 2 of the 3 runs that reached one   |

Almost all elapsed time was a stopped run waiting for a person. Compute was
about 41 minutes across all twelve runs.

| Repository CI (last 100 PR runs)         | Value                                   |
| ---------------------------------------- | --------------------------------------- |
| Passed                                   | 35, median 26 minutes (13 to 31)        |
| Failed (latest attempt)                  | 8, median 21 minutes before the failure |
| Runs with a failed platform job, any try | 11                                      |
| Cancelled                                | 56, lower PRs of stacks, by design      |

A failure costs about 21 minutes to surface, then a fix, then a full 26-minute
cycle again. Of the 11 runs with a failed platform job, read from their job
logs:

- 3 hit the 30-second test limit on the Windows runner, 2 of them with no
  other failure;
- 1 hit a test's own 10-second speed limit on Windows;
- 3 failed other tests on Windows only;
- 2 failed the same test on three or four platforms, regressions a local
  run would show in minutes;
- 3 failed the Linux Dart or Java analyzer bindings.

## What kept failing

- **The same early stops, run after run.** Seven of the nine failed runs
  stopped before any verification. Their stop kinds repeat across runs:
  `missing-file` 3, `worker-no-progress` 3, `aborted` 3, `scope` 2,
  `context-budget` 2, `patch-secret` 1. Nothing carried a lesson from one run
  to the next.
- **Checks run again on unchanged work.** 2 of 8 verifications re-checked a
  snapshot the same step had already checked, each time right after a
  resume.
- **Retries did change the outcome.** In the one run that needed several
  attempts, each failed verification failed differently (a permissions
  error, then the test runner, then an assertion) before the fourth passed.

## Hypotheses for the next rounds

Each is confirmed or refuted by the deciding number above, and ranked by
minutes saved per round divided by risk.

1. **A retry repeats the previous approach.** Refuted on this sample: 0 of 8
   verifications repeated the step's previous failure, though there is only
   one multi-attempt run to judge from. The retry notice and the stop on a
   third identical failure are still added as a cheap guard (they change
   nothing until a failure actually repeats), and the next retros count how
   often they fire.
2. **Recurring stop kinds have no memory.** Confirmed by the stop kinds
   above. Next change: a lesson is an accepted project memory carrying a
   failure signature, matched against a failure and shown to the next
   attempt; a run stopped by a repeated failure proposes one.
3. **Stopped time dominates.** Confirmed: 95% of elapsed minutes. To
   measure next: how much of it follows a failure a decision could have
   settled without waiting for a person.
4. **Windows-only CI failures cost full cycles.** Confirmed for timeouts: 2
   runs failed only on the 30-second limit on Windows, and a third also hit
   it. Next change: a 60-second default on Windows only.
5. **Nothing checks a change before CI.** Confirmed: 2 runs failed on three
   or four platforms. Next change: a local preflight of format, lint, type
   check and the tests related to the change.
6. **Resumes re-check unchanged work.** New: 2 of 8 verifications. To
   measure next: the minutes they cost.

## What Laya, Jev and the advisor did

- **Jev and Laya** answered two design questions, with design text only.
  On a repeated failure, Jev chose a reviewer decision with plain retry ruled
  out (0.92); Laya leaned to one more retry told to change approach (0.58).
  The change takes Jev's choice and gives every retry the change-approach
  instruction. For lessons, both chose accepted memories with a failure
  signature (Jev 0.93, Laya 0.68). Jev spend: under $0.001.
- **The advisor** set the order: measure first, change retries second,
  lessons third, and record Laya and Jev verdicts in shadow before either
  may gate anything.

## Deferred

- Per-check durations on `verification.completed`, so gate minutes can be
  split by check.
- Laya and Jev checks before verification and review, recorded in shadow
  with their latency and hit rate. Letting them stop a change is a promotion
  decision for the owner, made on that recorded evidence.
