# Delivery retro

- ID: delivery-retro
- Status: implemented
- Area: quality
- Epic: Self-improving team

## Problem

A strong agile team gets faster by looking back at where its time went and
what kept failing, then changing one thing at a time and measuring the
effect. Managed runs already record every phase as timestamped events, but
nothing reads them, so nobody can say how long verification takes, whether a
retry changed anything, or which failures keep recurring. Without those
numbers, every later improvement (retrying with context, stopping on a
repeated failure, lessons from failures) would be guesswork. This feature is
the measuring step: it changes no gate, prompt or run.

## Acceptance criteria

- AC1: `graph-engine retro` reports, per run and in total, the minutes from a run's first event to its last stop or success, split into worker, verification, review and security phases (wall-clock time while at least one of the phase's start events was not yet matched by the same step's finish, so concurrent steps count once), time stopped before a resume, and the rest as waiting; a stop ends every open phase, so stopped time is never also phase time, and events after the run ended (a person's acceptance) are not counted.
  - Test: packages/engine/tests/retro.test.ts :: splits a run's minutes into worker, verification, review, security, stopped and waiting time
  - Test: packages/engine/tests/retro.test.ts :: ends open phases at a stop, so stopped time is never also phase time
  - Test: packages/engine/tests/retro.test.ts :: counts concurrent steps' phase time once, as wall-clock time
  - Test: packages/engine/tests/retro.test.ts :: counts a multi-step plan's worker steps as worker time and attempts
- AC2: It counts worker attempts (including a multi-step plan's worker steps) and verifications, verifications whose checks failed exactly as the same step's previous verification did (failing checks, identified by check ID or else by command and image, their exit codes, and their output's last 40 lines with durations, timestamps, temporary paths and long IDs normalized; only a truncated hash is kept), and verifications of the same snapshot as the step's previous one, across stops and resumes.
  - Test: packages/engine/tests/retro.test.ts :: counts verifications that repeated the step's previous failure or re-checked an unchanged snapshot
  - Test: packages/engine/tests/retro.test.ts :: compares each verification with the previous one of the same step, across a stop and resume
  - Test: packages/engine/tests/retro.test.ts :: tells unnamed checks with the same command in different images apart
  - Test: packages/engine/tests/retro.test.ts :: tells two failures of the same check apart by their output, ignoring durations, timestamps and temporary paths
  - Test: packages/engine/tests/retro.test.ts :: reads at most 40 lines of 500 characters of a check's output, quickly
- AC3: Stop reasons are reported only as the catalogue's error kinds, which now also name a path outside the allowed scope, a missing file, a potential secret in a patch and an aborted operation; the message is never kept.
  - Test: packages/engine/tests/retro.test.ts :: reports stop reasons as kinds only, never the message
- AC4: The totals give runs by status, summed and median minutes, the first-pass verification rate (runs whose first verification passed, of runs that reached one; a first verification that never finished counts as reached and not passed, even when the run is later resumed) and stop kinds, holding only counts, minutes, kinds and run IDs, with no timestamps.
  - Test: packages/engine/tests/retro.test.ts :: totals runs, the first-pass verification rate and stop kinds, keeping only counts, minutes, kinds and run IDs
  - Test: packages/engine/tests/retro.test.ts :: counts a first verification that never finished as reached and not passed
  - Test: packages/engine/tests/retro.test.ts :: keeps a first verification a stop interrupted as failed after a resume
  - Test: packages/engine/tests/retro.test.ts :: prints no timestamps
- AC5: `--since <date>` limits the retro to runs created on or after an ISO 8601 date or date-time, and refuses any other text or an impossible calendar date.
  - Test: packages/engine/tests/retro.test.ts :: limits the retro to runs created on or after --since
- AC6: Each stop kind, and a human-acceptance wait, is classified in `retro.ts` as a person reason (`approval`, `credential`, `spending` or `owner-decision`) or `graph`, a defect the graph can fix itself; an unclassified stop kind does not compile. Each run and the totals report `deferredToPerson` (stops and waits routed to the person), `deferredByReason` (the same per reason) and `graphOwnedStops`, and records made before these fields existed still summarise as zero.
  - Test: packages/engine/tests/retro.test.ts :: classifies every stop kind as a person reason or the graph's own
  - Test: packages/engine/tests/retro.test.ts :: counts a plan-approval stop as deferred with reason approval
  - Test: packages/engine/tests/retro.test.ts :: counts a spending-cap stop and a human-acceptance wait as deferred
  - Test: packages/engine/tests/retro.test.ts :: counts a new-dependency refusal as approval, and an acceptance wait only in a run that succeeded
  - Test: packages/engine/tests/retro.test.ts :: counts a checks-failed stop as graph-owned, not deferred
  - Test: packages/engine/tests/retro.test.ts :: aggregates across runs and still reads an old record without the fields

## Security considerations

The retro reads the local run store and prints to the terminal; no MCP tool
or dashboard endpoint returns it. Its output holds run IDs, counts, minutes
and fixed error kinds. Check output, error messages, paths, prompts and
memory text are never copied into it. A failure signature is a truncated hash
of check identities, exit codes and a bounded, normalized output tail, so the
output cannot be read back from it.

## Non-goals

Changing any gate, prompt, retry or decision; scoring workers or providers;
sending the numbers anywhere; counting as promotion evidence for a decision
provider. Acting on the numbers is the job of later features in this epic,
each measured before and after with this retro.
