# Flaky tests

A test is flaky when it passes and fails on the same commit under the same
conditions, including the same platform. A failure that goes away after a fix,
or one that always happens on one platform, is not flaky.

## When one appears

1. Rerun only the failed job, once. Do not rerun the whole workflow.
2. If it fails again, or the same test flakes twice in a week, an issue is
   needed in this repository's tracker; an agent may file it. Include the run
   id, the test name, the platform and the exact assertion message. Issues #185 and #188 are the model.
3. On a first flake that passes on rerun, name the failed run in the PR
   instead of an issue. Merging still needs every required check green on the
   head commit, explained or not.

## Rules

- Never skip or delete a test without an issue that explains why.
- Never raise a timeout blindly. Make the test deterministic, or make the
  failure explain itself: assert diagnostics first (what was loaded, what the
  tool printed) so an empty result reports its cause instead of
  `expected [] to deeply equal [...]`.
- A fix is judged by the test no longer being able to fail the same way, not
  by one green run.

## Quarantine

Quarantine is a last resort for a test that blocks others while its fix is in
progress.

- The test name or skip reason carries the issue number, for example
  `skip: #185 call edges missing on ubuntu-24.04`.
- Revisit it within one sprint: fix it and remove the quarantine, or record
  in the issue why it stays.
- A quarantined test is listed in the next retro.

## Retros

Each retro in [docs/ops/retros/](ops/retros/) counts the flakes of its
window: how many distinct tests flaked, how many CI runs each cost, and which
quarantines are older than one sprint. Count a flake once per test and
platform per week, and link the issue.
