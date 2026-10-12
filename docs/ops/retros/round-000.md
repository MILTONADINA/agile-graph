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

| Managed runs (12)                       | Value                              |
| --------------------------------------- | ---------------------------------- |
| Succeeded / failed                      | 3 / 9                              |
| Minutes from first event to end         | 1,348 in total, median 3.4 per run |
| Stopped, waiting for a person to resume | 1,278 (95%)                        |
| Worker / verification / review          | 21.5 / 14.6 / 0.6                  |
| Waiting outside any paired phase        | 33.3                               |
| First verification passed               | 2 of the 3 runs that reached one   |

Almost all elapsed time was a stopped run waiting for a person. Compute was
about 36 minutes across all twelve runs.

| Repository CI (100 PR runs) | Value                                   |
| --------------------------- | --------------------------------------- |
| Passed                      | 35, median 26 minutes (13 to 31)        |
| Failed                      | 8, median 21 minutes before the failure |
| Cancelled                   | 56, lower PRs of stacks, by design      |
| Re-run after a failure      | 2                                       |

A failure costs about 21 minutes to surface, then a fix, then a full 26-minute
cycle again. Of the 8 failed runs, 6 failed `npm run check` on Windows
(4 of them on Windows only), 2 failed the Linux Dart or Java analyzer
bindings, 1 failed the scanner sidecar, and 1 failed `npm run check` on all
four platforms: a regression a local run would have shown in minutes.

## What kept failing

- **Retries that did not learn.** Of 8 verifications, 2 failed exactly as
  the same step's previous verification had (same failing check, same exit
  code), and 2 re-checked a snapshot that had not changed. In the one run
  that needed several attempts, the second and third verifications both
  repeated the first failure before the fourth passed.
- **The same early stops, run after run.** Seven of the nine failed runs
  stopped before any verification. Their stop kinds repeat across runs:
  `missing-file` 3, `worker-no-progress` 3, `aborted` 3, `scope` 2,
  `context-budget` 2, `patch-secret` 1. Nothing carried a lesson from one run
  to the next.

## Hypotheses for the next rounds

Each is confirmed or refuted by the deciding number above, and ranked by
minutes saved per round divided by risk.

1. **A retry repeats the previous approach.** Confirmed: 2 of the 3
   re-verifications in the multi-attempt run repeated the failure. Next
   change: every retry carries the previous failure with an instruction to
   change approach, and a repeated failure goes to the reviewer model for a
   decision (change approach, narrow the scope or blocked; never a plain
   retry) instead of spending another attempt.
2. **Recurring stop kinds have no memory.** Confirmed by the stop kinds
   above. Next change: a lesson is an accepted project memory carrying a
   failure signature, matched against a failure and added to the next
   attempt; a stopped run proposes one for a person to accept.
3. **Stopped time dominates.** Confirmed: 95% of elapsed minutes. To
   measure next: how much of it follows a repeated failure that a decision
   could have settled without waiting.
4. **Windows-only CI failures cost full cycles.** To measure next: how many
   were test timeouts on a slow runner rather than real faults.
5. **Nothing checks a change before CI.** To measure next: which of the 8
   CI failures a local preflight of format, lint, type check and the changed
   tests would have caught.

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
