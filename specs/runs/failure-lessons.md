# Lessons from repeated failures

- ID: failure-lessons
- Status: implemented
- Area: runs
- Epic: Self-improving team

## Problem

The baseline retro (`docs/ops/retros/round-000.md`) found the same stop
reasons run after run, with nothing carrying the lesson from one run to the
next. A team learns from a failure once: it writes down the countermeasure,
and the next person who meets the same failure is told it at once. Within a
run, a retry now learns from the previous attempt (`retry-learning`); this
feature carries what a stopped run learned to every later run, through the
project memories a person already reviews.

## Acceptance criteria

- AC1: When a run stops because its checks failed the same way on three attempts in a row, or its reviewer judged a repeated failure blocked, it proposes a private observation memory naming the failing checks and exit codes, the task and any reviewer guidance, and records `lesson.proposed` with the memory and the failure signature.
  - Test: packages/engine/tests/lessons.test.ts :: proposes a private lesson when a run stops on a repeated failure
- AC2: Once a person accepts that lesson, any later run whose checks fail with the same signature shows it to the worker with the very next attempt, and records `lesson.applied` when that attempt receives it (never when no attempt is left to receive it); a lesson superseded by a newer accepted memory is shown as the newer one, whatever rejected drafts were proposed in between.
  - Test: packages/engine/tests/lessons.test.ts :: shows an accepted lesson to a later run as soon as it meets the same failure
  - Test: packages/engine/tests/lessons.test.ts :: does not count a lesson as shown when no attempt is left to receive it
  - Test: packages/engine/tests/lessons.test.ts :: shows the accepted replacement of a lesson even after a rejected draft replacement
- AC3: A lesson nobody accepted, or one a person rejected, is never shown.
  - Test: packages/engine/tests/lessons.test.ts :: never shows a lesson nobody accepted, or one a person rejected
- AC4: A cloud worker is shown a lesson only once its exact text is authorized for export and, as for mandatory memory, only while it is shared, holds no potential secret and cites sources inside today's export paths, re-checked at every turn.
  - Test: packages/engine/tests/lessons.test.ts :: gives a cloud worker an accepted lesson only once its exact text is authorized for export
  - Test: packages/engine/tests/lessons.test.ts :: re-checks an authorized lesson against today's export policy before a cloud worker sees it
- AC5: `graph-engine retro` counts lessons proposed and lessons shown, per run and in total.
  - Test: packages/engine/tests/retro.test.ts :: counts lessons proposed after a repeated failure and lessons shown to a worker

## Security considerations

A lesson is a proposed, private memory: it stays out of every context packet
until a person accepts it, like any other proposal. Its text holds the
failing check commands, exit codes and the task, never check output. The
failure signature lives only in the run event, as a truncated hash of check
identities, exit codes and a normalized output tail. Cloud workers receive a lesson only under the
existing exact-text export authorization, which also requires the memory to
cite source evidence inside the export paths; an automatic lesson cites none,
so it reaches a cloud worker only after a person replaces it with one that
does (`memory-add --source ... --supersedes`).

## Non-goals

Accepting, editing or sharing lessons on a person's behalf; turning a lesson
into a check or a gate automatically; lessons for review or security-gate
failures, which already carry their findings across attempts by ID and
fingerprint.
