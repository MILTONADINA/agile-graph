# Retries that learn from the previous failure

- ID: retry-learning
- Status: implemented
- Area: runs
- Epic: Self-improving team

## Problem

When a run's checks fail, the worker tries again with the latest failure's
output and nothing else. It is never told that it is retrying, that its last
change did not reach the cause, or that it changed nothing at all, so it can
resubmit the same approach until the attempt budget runs out. The baseline
retro (`docs/ops/retros/round-000.md`) measured this: in the one run that
needed several attempts, two verifications in a row failed exactly as the
one before. A strong team never answers a repeated failure by doing the same
thing again; it changes approach, and when the same failure keeps coming
back it stops and asks for a decision instead of burning more time.

## Acceptance criteria

- AC1: Every retry after a check failure is told, before the failure output, which attempt failed and to change approach rather than resubmit the same change; the notice is fixed sentences with no project data, so every worker kind receives it, and the first attempt gets none.
  - Test: packages/engine/tests/repeat-failure.test.ts :: tells every retry after a check failure to change approach, and names a repeated failure
- AC2: When an attempt's checks fail exactly as the previous attempt's did (the same failing checks with the same exit codes, never their output), the next attempt is told so, and the run records an `attempt.repeated_failure` event with the attempt, a truncated failure signature, the number of repeats in a row and whether the checked files were unchanged.
  - Test: packages/engine/tests/repeat-failure.test.ts :: tells every retry after a check failure to change approach, and names a repeated failure
- AC3: When the checks fail the same way on three attempts in a row, the run stops with a `repeated-failure` stop kind instead of spending further attempts, whatever attempt budget remains.
  - Test: packages/engine/tests/repeat-failure.test.ts :: stops when the checks fail the same way three times in a row instead of spending another attempt
- AC4: A retry that fails differently starts the count again.
  - Test: packages/engine/tests/repeat-failure.test.ts :: starts the count again when a retry fails differently
- AC5: When an attempt left the checked files exactly as they were, the next attempt is told so.
  - Test: packages/engine/tests/repeat-failure.test.ts :: tells the worker when its last change left the checked files as they were

## Security considerations

The notice is built from the attempt number, the attempt budget and two
fixed sentences, so it carries no source, check output, path or secret and
is safe to send to a cloud worker, which still receives only a generic
sentence in place of the failure output. The failure signature is a
truncated hash of check identities and exit codes; check output never
enters it or the event. Stopping on a repeated failure only ends work
earlier; it never skips, weakens or reorders a check.

## Non-goals

Asking a reviewer model to decide between changing approach, narrowing the
scope or declaring the run blocked (the next change in this epic); lessons
that carry across runs; changing review or security-gate retries, which
already re-check earlier findings by ID and fingerprint; changing the
recovery controller's decision inputs.
