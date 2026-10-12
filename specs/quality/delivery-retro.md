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
- AC2: It counts worker attempts and verifications, verifications whose checks failed exactly as the same step's previous verification did (failing checks and exit codes, never output), and verifications of the same snapshot as the step's previous one, across stops and resumes.
  - Test: packages/engine/tests/retro.test.ts :: counts verifications that repeated the step's previous failure or re-checked an unchanged snapshot
  - Test: packages/engine/tests/retro.test.ts :: compares each verification with the previous one of the same step, across a stop and resume
- AC3: Stop reasons are reported only as the catalogue's error kinds, which now also name a path outside the allowed scope, a missing file, a potential secret in a patch and an aborted operation; the message is never kept.
  - Test: packages/engine/tests/retro.test.ts :: reports stop reasons as kinds only, never the message
- AC4: The totals give runs by status, summed and median minutes, the first-pass verification rate (runs whose first verification passed, of runs that reached one; a first verification that never finished counts as reached and not passed) and stop kinds, holding only counts, minutes, kinds and run IDs, with no timestamps.
  - Test: packages/engine/tests/retro.test.ts :: totals runs, the first-pass verification rate and stop kinds, keeping only counts, minutes, kinds and run IDs
  - Test: packages/engine/tests/retro.test.ts :: counts a first verification that never finished as reached and not passed
  - Test: packages/engine/tests/retro.test.ts :: prints no timestamps
- AC5: `--since <date>` limits the retro to runs created on or after an ISO 8601 date.
  - Test: packages/engine/tests/retro.test.ts :: limits the retro to runs created on or after --since

## Security considerations

The retro reads the local run store and prints to the terminal; no MCP tool
or dashboard endpoint returns it. Its output holds run IDs, counts, minutes
and fixed error kinds. Check output, error messages, paths, prompts and
memory text are never copied into it, and failure signatures are truncated
hashes of check identities and exit codes.

## Non-goals

Changing any gate, prompt, retry or decision; scoring workers or providers;
sending the numbers anywhere; counting as promotion evidence for a decision
provider. Acting on the numbers is the job of later features in this epic,
each measured before and after with this retro.
