# Code review gate

- ID: code-review-gate
- Status: implemented
- Area: quality

## Problem

A team does not call work done because its author says so or because tests pass; another engineer reviews the change against what was asked. An operator wants to require a reviewer model's approval of every managed run, with the reviewer seeing exactly the worker's change, answering each acceptance criterion, and sending requested changes back to the worker.

## Acceptance criteria

- AC1: With a reviewer configured, a run completes only after a clean approval, and the review is recorded.
  - Test: packages/engine/tests/execution.test.ts :: completes only after the reviewer approves, and records the review
  - Test: packages/engine/tests/review.test.ts :: passes only a clean approval
  - Test: packages/engine/tests/review.test.ts :: asks for a structured review and parses it
- AC2: Requested changes go back to the worker as feedback, and the run completes after a later approval.
  - Test: packages/engine/tests/execution.test.ts :: sends requested changes back to the worker and completes after approval
- AC3: An approval that leaves any acceptance criterion unconfirmed is not accepted.
  - Test: packages/engine/tests/execution.test.ts :: does not accept an approval with a criterion it could not confirm
- AC4: The reviewer sees every file the worker wrote (every step's change in a multi-step plan) and nothing else, as raw bytes regardless of Git attributes, compared with the run's base commit even after its own publication commit.
  - Test: packages/engine/tests/execution.test.ts :: shows the reviewer every file the worker wrote and nothing else
  - Test: packages/engine/tests/execution.test.ts :: shows raw bytes whatever encoding the change's attributes declare
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shows the reviewer every step's change
  - Test: packages/engine/tests/execution.test.ts :: reviews the run's whole change against its base commit after a publication commit
- AC5: The reviewer a run started with is kept across a resume, even if the project's setting changes.
  - Test: packages/engine/tests/execution.test.ts :: keeps the reviewer a run started with across a resume
- AC6: A cloud reviewer is not sent non-exportable or secret-bearing changes, an oversized change is not truncated, and in those cases the review fails. A non-exportable change is recorded as a blocked review, not a started one, since nothing reached the reviewer.
  - Test: packages/engine/tests/execution.test.ts :: refuses a cloud reviewer for non-exportable changes and reports a failed review
  - Test: packages/engine/tests/execution.test.ts :: lets a person approve a change a cloud reviewer may not receive
  - Test: packages/engine/tests/review.test.ts :: refuses secrets for cloud reviewers, oversized changes and installed agents

- AC7: A person can approve a run's change in place of the reviewer, from the command line only, when the run's latest attempt stopped at review after its required checks passed and its retained workspace still matches that snapshot, including a change a cloud reviewer may not receive; the run then completes, and its review is recorded as approved by a person, shown separately from AI approvals.
  - Test: packages/engine/tests/execution.test.ts :: lets a person approve in place of the reviewer, recorded as a person's approval
  - Test: packages/engine/tests/execution.test.ts :: lets a person approve a change a cloud reviewer may not receive
  - Test: packages/engine/tests/execution.test.ts :: refuses a person's approval when the checks did not pass or the change moved
  - Test: packages/engine/tests/execution.test.ts :: refuses a person's approval for a run the reviewer approved that failed afterwards
  - Test: packages/engine/tests/execution.test.ts :: refuses a person's approval when the latest attempt stopped before reaching review again
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
- AC8: `graph-engine reviewer <id>` warns as soon as the reviewer is set when that provider is an installed agent (codex, claude or cursor), since installed agents cannot review yet and every run would refuse it at start; an API or local reviewer gets no such warning.
  - Test: packages/engine/tests/cli.test.ts :: warns when the reviewer is set to an installed agent, which cannot review, instead of only when a run starts
- AC9: Each reviewer finding gets an engine-assigned ID, `R` and the first 10 hex characters of the SHA-256 of its path, line and whitespace-normalized message, recorded with the finding in `review.completed` and named in the feedback.
  - Test: packages/engine/tests/review.test.ts :: gives each finding a stable ID that ignores whitespace
  - Test: packages/engine/tests/execution.test.ts :: re-checks earlier blocking findings before reviewing again and skips the full review while one is unfixed
- AC10: When the latest AI review in the run asked for changes with blocking findings, the next review first checks each of them (at most 20; any beyond count as inconclusive) in a fresh, separate call to the reviewer carrying only that finding, the task and the current diff, with the same provider, secret and context-budget refusals as a review and the same worker slot and cost reservation. Each check is recorded as a `review.verify_fix` event. If any is not shown fixed, the review fails without a full review, records a failed `review.completed` listing the unfixed findings, and the feedback names each by its ID with the evidence; the full review runs only once all are fixed. A person's approval of the snapshot still stands in for all of this.
  - Test: packages/engine/tests/execution.test.ts :: re-checks earlier blocking findings before reviewing again and skips the full review while one is unfixed
  - Test: packages/engine/tests/review.test.ts :: re-checks only the blocking findings of the latest AI review that asked for changes
  - Test: packages/engine/tests/review.test.ts :: checks one earlier finding in a fresh structured call
  - Test: packages/engine/tests/review.test.ts :: refuses the same inputs for a fix check as for a review
  - Test: packages/engine/tests/execution.test.ts :: lets a person approve a run that stopped at an unfixed earlier finding
- AC11: A failing review's feedback also lists its advisory findings, under a section labelled optional; a passing review's feedback stays empty.
  - Test: packages/engine/tests/review.test.ts :: keeps advisory findings as optional feedback when a review fails
- AC12: `graph-engine run-receipt` includes an evidence ledger projected from the run's events alone: the final snapshot (that of the latest required checks), and for the latest verification, review and security-gate results the snapshot each ran against, whether it passed and whether it is current (equal to the final snapshot), with `complete` true only when every gate that ran is current. It never changes gating.
  - Test: packages/engine/tests/store-receipt.test.ts :: projects an evidence ledger of the snapshot each gate last ran against

## Security considerations

The diff shown to the reviewer is built from raw bytes outside the repository, with no Git attributes, diff drivers or configuration, so a change cannot hide itself with `.gitattributes` tricks. The operator's own uncommitted files are excluded so they are neither reviewed as the worker's nor sent to a cloud reviewer. Cloud reviewers receive only exportable, secret-free diffs. A reviewer can only hold a change back: it cannot accept a change, skip checks or the security gate, or stand in for human acceptance. A check of an earlier finding is a separate call that sees only that finding, the task and the diff, so the reviewer does not confirm its own finding while looking for new ones; it too can only hold a change back. Stored review records redact evidence and messages.

## Non-goals

The review gate does not replace human acceptance, required checks or security scanning. Installed agents cannot act as reviewers yet, and large changes are failed rather than summarized or truncated.
