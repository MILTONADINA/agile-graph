# Retries that learn from the previous failure

- ID: retry-learning
- Status: implemented
- Area: runs
- Epic: Self-improving team

## Problem

When a run's checks fail, the worker tries again with the latest failure's
output and nothing else. It is never told that it is retrying, that its last
change did not reach the cause, or that it changed nothing at all, so it can
resubmit the same approach until the attempt budget runs out. The owner has
seen exactly that in another project. This project's own baseline
(`docs/ops/retros/round-000.md`) does not show it yet: in its one
multi-attempt run every retry failed differently. So this is a cheap guard
rather than a measured fix: it changes nothing until a failure actually
repeats, and later retros count how often it fires. A strong team never
answers a repeated failure by doing the same thing again; it changes
approach, and when the same failure keeps coming back it stops and asks for
a decision instead of burning more time.

## Acceptance criteria

- AC1: Every retry after a check failure is told, before the failure output, which attempt failed and to change approach rather than resubmit the same change; the notice is fixed sentences with no project data, so every worker kind receives it, and the first attempt gets none.
  - Test: packages/engine/tests/repeat-failure.test.ts :: tells every retry after a check failure to change approach, and names a repeated failure
- AC2: When an attempt's checks fail exactly as the previous attempt's did (the same failing checks with the same exit codes and the same normalized output tail, compared by a truncated hash so the output is never kept), the next attempt is told so, and the run records an `attempt.repeated_failure` event with the attempt, a truncated failure signature, the number of repeats in a row and whether the checked files were unchanged.
  - Test: packages/engine/tests/repeat-failure.test.ts :: tells every retry after a check failure to change approach, and names a repeated failure
- AC3: When the checks fail the same way on three attempts in a row, the run stops with a `repeated-failure` stop kind instead of spending further attempts, whatever attempt budget remains.
  - Test: packages/engine/tests/repeat-failure.test.ts :: stops when the checks fail the same way three times in a row instead of spending another attempt
- AC4: A retry that fails differently starts the count again.
  - Test: packages/engine/tests/repeat-failure.test.ts :: starts the count again when a retry fails differently
- AC5: When an attempt left the checked files exactly as they were, the next attempt is told so.
  - Test: packages/engine/tests/repeat-failure.test.ts :: tells the worker when its last change left the checked files as they were
- AC6: A multi-step plan's repair, and a retry after a reused solution failed its checks, starts from that failed verification: the first retry is told the previous attempt failed, and its failure counts towards a repeat.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: tells the first repair that the combined checks failed, and stops when the repairs repeat that failure

- AC7: When a run has a reviewer and an attempt remains, the first repeated failure goes to it in one fresh call with the task, the acceptance criteria, which checks failed with which exit codes on which two attempts, and the current diff; it answers change approach (with guidance), narrow the scope, or blocked, never a plain retry. The next attempt is told the decision and its guidance, and the run records `attempt.repeat_decision_started` and `attempt.repeat_decision`, which the retro counts as review time.
  - Test: packages/engine/tests/repeat-failure.test.ts :: asks the run's reviewer to decide a repeated failure and passes its guidance to the next attempt
  - Test: packages/engine/tests/repeat-failure.test.ts :: asks the reviewer only on the first repeat, and still stops at the third
  - Test: packages/engine/tests/retro.test.ts :: counts a reviewer's decision on a repeated failure as review time
- AC8: A reviewer's blocked decision stops the run at once with the `repeated-failure` kind.
  - Test: packages/engine/tests/repeat-failure.test.ts :: stops at once when the reviewer judges a repeated failure blocked
- AC9: When the decision cannot be made (a failed call, a cost cap, or a change a cloud reviewer may not receive, recorded as `scope`), the run records why as an error kind and the retry falls back to the change-approach notice.
  - Test: packages/engine/tests/repeat-failure.test.ts :: falls back to the change-approach notice when the reviewer's decision fails
  - Test: packages/engine/tests/repeat-failure.test.ts :: records a repeat decision refused by the cost cap as cost-cap
- AC10: A cloud reviewer gets the failing checks and exit codes but never their output, and a cloud worker gets the guidance only when it came from a cloud reviewer that saw nothing outside the export paths and holds no potential secret.
  - Test: packages/engine/tests/repeat-failure.test.ts :: gives a cloud reviewer the failing checks and exit codes but never their output, and passes its guidance to a cloud worker
- AC11: In a multi-step plan's repair, an implementer disputing the tester's test (proposing no change) and the tester's answer are the dispute flow a person settles: they are never counted as repeats, so the run still ends with the dispute named for a person.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never counts an implementer's dispute and the tester's answer as repeated failures
- AC12: No reviewer decision is requested when no attempt is left to act on it.
  - Test: packages/engine/tests/repeat-failure.test.ts :: does not pay for a repeat decision when no attempt is left to act on it

## Security considerations

The notice is built from the attempt number, the attempt budget and two
fixed sentences, so it carries no source, check output, path or secret and
is safe to send to a cloud worker, which still receives only a generic
sentence in place of the failure output. The failure signature is a
truncated hash of check identities, exit codes and a normalized output
tail; the output itself never enters it or the event. Stopping on a repeated failure only ends work
earlier; it never skips, weakens or reorders a check.

The reviewer decision is a reviewer call like the review itself: it shares
the run's worker slots, turn budget and cost reservations, refuses secrets
and installed agents, and is skipped for a cloud reviewer when the change
touches paths outside the export paths. Check output, which may quote
private source, goes only to a local reviewer, and guidance from a local
reviewer never reaches a cloud worker. The guidance is redacted and kept to
1,500 characters in the event.

## Non-goals

Lessons that carry across runs (the next change in this epic); changing review or security-gate retries, which
already re-check earlier findings by ID and fingerprint; changing the
recovery controller's decision inputs.
