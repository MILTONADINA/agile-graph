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
- AC6: A cloud reviewer is not sent non-exportable or secret-bearing changes, an oversized change is not truncated, and in those cases the review fails. A change is oversized when its request, counted strictly at one token per UTF-8 byte, exceeds the reviewer's input ceiling (the smaller context limit less the output reservation, as workers AC12 says), so the gate never judges input a provider might cut; fix checks are refused the same way. A non-exportable change is recorded as a blocked review, not a started one, since nothing reached the reviewer.
  - Test: packages/engine/tests/execution.test.ts :: refuses a cloud reviewer for non-exportable changes and reports a failed review
  - Test: packages/engine/tests/execution.test.ts :: lets a person approve a change a cloud reviewer may not receive
  - Test: packages/engine/tests/review.test.ts :: refuses secrets for cloud reviewers, oversized changes and installed agents
  - Test: packages/engine/tests/review.test.ts :: refuses a change too large for the reviewer under the strict one-token-per-byte count with the output reserved, never truncating it

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
  - Test: packages/engine/tests/execution.test.ts :: re-checks earlier blocking findings before reviewing again, skips the full review while one is unfixed, and stops on that repeat
- AC10: When the latest AI review in the run asked for changes with blocking findings, the next review first checks each of them (at most 20; any beyond count as inconclusive) in a fresh, separate call to the reviewer carrying only that finding, the task and the current diff, with the same provider, secret and context-budget refusals as a review and the same worker slot and cost reservation. Each check is recorded as a `review.verify_fix` event naming the snapshot it judged. A check that errors stops the run as "Code review did not complete" without passing the review. If any is not shown fixed, the review fails without a full review, records a failed `review.completed` listing the unfixed findings, and the feedback names each by its ID with the evidence; the full review runs only once all are fixed. A person's approval of the snapshot still stands in for all of this.
  - Test: packages/engine/tests/execution.test.ts :: re-checks earlier blocking findings before reviewing again, skips the full review while one is unfixed, and stops on that repeat
  - Test: packages/engine/tests/review.test.ts :: re-checks only the blocking findings of the latest AI review that asked for changes
  - Test: packages/engine/tests/review.test.ts :: checks one earlier finding in a fresh structured call
  - Test: packages/engine/tests/review.test.ts :: refuses the same inputs for a fix check as for a review
  - Test: packages/engine/tests/execution.test.ts :: lets a person approve a run that stopped at an unfixed earlier finding
  - Test: packages/engine/tests/execution.test.ts :: checks at most 20 earlier findings and records the rest inconclusive, which blocks
  - Test: packages/engine/tests/execution.test.ts :: stops the run without passing review when a fix check fails, and reuses that snapshot's fixed verdicts on resume
  - Test: packages/engine/tests/execution.test.ts :: runs each fix check in the reviewer's worker slot under a reserved, turn-counted call
- AC11: A failing review's feedback also lists its advisory findings, under a section labelled optional, bounded to five findings of at most 300 characters each with a count of any omitted, so optional suggestions never push the required repair past its context budget; a passing review's feedback stays empty.
  - Test: packages/engine/tests/review.test.ts :: keeps advisory findings as optional feedback when a review fails
  - Test: packages/engine/tests/review.test.ts :: bounds the optional advisory feedback so it cannot crowd out the required repair
- AC12: `graph-engine run-receipt` includes an evidence ledger projected from the run's events alone: the final snapshot (that of the latest required checks), and for the latest verification, review and security-gate results the snapshot each ran against, whether it passed and whether it is current (equal to the final snapshot), with `complete` true only when every gate that ran is current and no gate's latest attempt started without recording a result (listed in `unfinished`). It never changes gating.
  - Test: packages/engine/tests/store-receipt.test.ts :: projects an evidence ledger of the snapshot each gate last ran against
  - Test: packages/engine/tests/store-receipt.test.ts :: leaves the evidence incomplete when a gate's latest attempt never recorded a result
- AC13: A review resumed at the same snapshot reuses that snapshot's earlier `fixed` fix-check verdicts instead of calling the reviewer again, recording each as a `review.verify_fix` event with `reused: true`; a verdict from another snapshot, and any `still_present` or `inconclusive` verdict, is never reused. Fix checks count against the run's shared `policy.maxTurns`, and the plan-time turn warning reserves three per repair attempt with a reviewer (never more than the 20 a review may check).
  - Test: packages/engine/tests/review.test.ts :: reuses only fixed verdicts recorded for the same snapshot
  - Test: packages/engine/tests/execution.test.ts :: stops the run without passing review when a fix check fails, and reuses that snapshot's fixed verdicts on resume
  - Test: packages/engine/tests/execution.test.ts :: re-checks earlier blocking findings before reviewing again, skips the full review while one is unfixed, and stops on that repeat
  - Test: packages/engine/tests/planning.test.ts :: reserves expected fix checks of earlier review findings per repair attempt
- AC14: Each blocking finding of a rejection gets a deterministic signature (a truncated hash of its file path and its text with case, digits and whitespace normalised, so a moved line gives the same one), recorded on the `review.completed` event with the round's duration in `minutes`. The next repair round's instructions list the signatures and short texts of the findings raised so far and say not to repeat the same fix. When a rejection shares a signature with the one before it, the run records `review.repeated_finding` and stops with the `repeated-review-finding` stop kind, asking for a changed approach (narrow the scope, a structural fix, or blocked); it never counts as an accept. A rejection with different signatures continues.
  - Test: packages/engine/tests/review.test.ts :: ignores line numbers, numbers in the text and whitespace
  - Test: packages/engine/tests/review.test.ts :: differs for another file or another message
  - Test: packages/engine/tests/review.test.ts :: reads rejections from events and finds the repeats
  - Test: packages/engine/tests/execution.test.ts :: carries earlier rejections' signatures into the next repair round, and stops when the same finding comes back
  - Test: packages/engine/tests/execution.test.ts :: continues when the next rejection raises a different finding
- AC15: When a reviewer is configured and the run's security scan has findings, baselined findings or inline suppressions, the system shall give each to the reviewer with a stable ID, and shall fail the review as not completed if the reviewer's answer omits any ID or names an ID it was not given; each ruling is `raised` or `dropped` with a non-empty reason, recorded in `review.completed`, and a `dropped` ruling never clears the security gate. Beyond that: a ruling on one ID twice also fails the review; the reviewer receives scanner text only, redacted, with a message only for a new finding, and for a non-local reviewer a finding in a path it may not receive is given by ID, tool and rule alone (path `(withheld)`, line 0); no new files are sent, so cloud export and secret screens are unchanged; the scan runs once per verified snapshot and is reused by the security gate, which alone records `security.scan_started`; the review record keeps whether its findings may leave the machine (`scanExportable`), and a retry or resume never sends a stored finding to a non-local reviewer or worker when that is false or, on a record that ruled on scan results, missing: the fix check is not run (it is inconclusive, so the run stays held for a person or a local reviewer) and the feedback is marked not exportable, even when the reviewer provider was reconfigured since; and there is no fixed count limit, the review instead reserves 40 output tokens per result on top of its usual verdict budget and fails before calling the reviewer, naming `policy.maxOutputTokens`, when the policy cannot hold that.
  - Test: packages/engine/tests/review.test.ts :: fails when an ID is omitted
  - Test: packages/engine/tests/review.test.ts :: fails on an ID it was not given, or one ruled twice
  - Test: packages/engine/tests/review.test.ts :: fails on an empty or blank reason
  - Test: packages/engine/tests/execution.test.ts :: fails the review as not completed when the answer omits an ID
  - Test: packages/engine/tests/execution.test.ts :: fails the review as not completed when the answer names an ID it was not given
  - Test: packages/engine/tests/execution.test.ts :: never lets a dropped ruling clear the security gate
  - Test: packages/engine/tests/execution.test.ts :: gives the reviewer every finding, baselined and suppression with a status and ID, and records the rulings
  - Test: packages/engine/tests/execution.test.ts :: withholds a local reviewer's stored finding from a reviewer reconfigured to a cloud provider, and from the worker
  - Test: packages/engine/tests/review.test.ts :: fails closed when a record with scan rulings lacks a boolean flag
  - Test: packages/engine/tests/review.test.ts :: refuses up front, naming the remedy, when the policy's output cap cannot hold 210 rulings
  - Test: packages/engine/tests/review.test.ts :: grows the requested output with the number of scan results when the policy allows
  - Test: packages/engine/tests/execution.test.ts :: keeps the review stop visible to a person's approval: no scan_started follows a review that threw
  - Test: packages/engine/tests/execution.test.ts :: scans once per verified snapshot, shared by the review and the gate
  - Test: packages/engine/tests/execution.test.ts :: does not blame the reviewer when the scan itself stops the run
  - Test: packages/engine/tests/execution.test.ts :: rules on more results than the old fixed cap of 100
  - Test: packages/engine/tests/execution.test.ts :: sends a message only for a new finding, never for a baselined one or a suppression

## Security considerations

The diff shown to the reviewer is built from raw bytes outside the repository, with no Git attributes, diff drivers or configuration, so a change cannot hide itself with `.gitattributes` tricks. The operator's own uncommitted files are excluded so they are neither reviewed as the worker's nor sent to a cloud reviewer. Cloud reviewers receive only exportable, secret-free diffs. A reviewer can only hold a change back: it cannot accept a change, skip checks or the security gate, or stand in for human acceptance. A check of an earlier finding is a separate call that sees only that finding, the task and the diff, so the reviewer does not confirm its own finding while looking for new ones; it too can only hold a change back. Stored review records redact evidence and messages.

## Non-goals

The review gate does not replace human acceptance, required checks or security scanning. Installed agents cannot act as reviewers yet, and large changes are failed rather than summarized or truncated.
