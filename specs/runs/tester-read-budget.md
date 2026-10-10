# Tester first packet and read budget

- ID: tester-read-budget
- Status: implemented
- Area: runs
- Epic: AI agile team

## Problem

Running the graph on itself, a local tester with a 16k context and
`maxTurns` 12 spent every turn requesting files and never wrote a test
([local validation](../../docs/local-validation.md), the 2026-10-10
self-development entry). Every model call reserves a turn against the run's
shared `policy.maxTurns`, and a call that only asks for files costs a full
turn, so nothing stopped reading from crowding out the proposal.

Two changes address it. A configured tester's first context packet leads
with what a tester needs most: the existing tests near the code the plan
names, and the source those tests exercise. And request-only calls get a
bounded read budget that comes out of `maxTurns`, so a worker that keeps
reading is told to propose with the evidence it has.

Definitions:

- A **request-only** result asks for files (`requests` is not empty) and
  proposes no change (`changes` is empty). A result with both is a proposal
  and does not count against the read budget.
- The **read budget** is `policy.maxReadTurns`, or `floor(maxTurns / 2)`
  when it is absent. The policy schema accepts an integer from 0 to 100,
  and a policy whose `maxReadTurns` is above its `maxTurns` is refused.
  The budget is shared by every step, attempt and resume of a run, like
  `maxTurns`; its count is kept in the run's `worker.read` events, so a
  resumed run keeps it. A tester that uses it all leaves none for the
  implementer, which then proposes from its own first packet. That is the
  reason the tester's first packet is targeted.

The total number of model calls in a run stays capped by `policy.maxTurns`
exactly as before: the read budget is part of `maxTurns`, never added to
it, and no code path that reserves a worker turn changed.
`likelyWorkerTurns`, the planning estimate of three calls per worker step,
already counts the calls spent reading, so it is unchanged: the budget caps
those calls and adds none.

## Acceptance criteria

- AC1: A configured tester's first context packet leads with the existing test files that import, or share a basename with, the code the plan's objective and acceptance criteria name (found through the symbol index, the import graph and the tester's write globs), followed by the source files those tests import. The paths are priority hints within the same context budget, exclusions, export rules and secret checks as any packet; a cloud tester gets only exportable paths.
  - Test: packages/engine/tests/tester-read-budget.test.ts :: leads the tester's first packet with a related existing test and the module it exercises
  - Test: packages/engine/tests/tester-read-budget.test.ts :: names the related test first and screens every path with the caller's export rule
- AC2: Each request-only result counts against the run's read budget, which defaults to half of `maxTurns` rounded down and is shared by every worker in the run.
  - Test: packages/engine/tests/tester-read-budget.test.ts :: counts request-only results against the read budget, then tells the worker to propose
  - Test: packages/engine/tests/tester-read-budget.test.ts :: defaults to half of maxTurns and accepts only a budget within maxTurns
- AC3: Once the read budget is spent, every later worker call is told to stop requesting and propose with the evidence it has. The next request-only result is refused with clear feedback, sends no file and does not fail the run, and a proposal that follows is accepted; a second request-only result in a row stops the run with an error naming the read budget.
  - Test: packages/engine/tests/tester-read-budget.test.ts :: counts request-only results against the read budget, then tells the worker to propose
  - Test: packages/engine/tests/tester-read-budget.test.ts :: refuses a request after the read budget is spent with feedback, and accepts the proposal that follows
  - Test: packages/engine/tests/tester-read-budget.test.ts :: stops a worker that keeps requesting after the refusal, without a call beyond maxTurns
- AC4: The total number of model calls in a run never exceeds `policy.maxTurns`, whatever the read budget, with or without a tester.
  - Test: packages/engine/tests/tester-read-budget.test.ts :: never makes more model calls than maxTurns ($maxTurns, read budget $maxReadTurns, tester $tester)
- AC5: `maxReadTurns` is not in the default policy, so a policy without it keeps its hash and existing plans still run; setting it changes the hash like any other policy field.
  - Test: packages/engine/tests/tester-read-budget.test.ts :: keeps the hash of every policy without maxReadTurns

## Security considerations

The tester's focus paths are computed from the plan's objective and
acceptance criteria, which are already part of the packet. Each path is
filtered by the caller's rule before it is used: `isAllowedPath` with the
export flag for a cloud tester, and a credential-shaped path is dropped.
`getContext` then screens the paths as it screens a path named in the query,
so a focus path never reaches an excluded, unexportable or secret-bearing
file and never bypasses the budget. The read-budget feedback names no path,
so a cloud worker may receive it. The budget is part of the hashed project
policy: changing it voids existing plans, as any policy change does.

## Non-goals

A per-step read budget, a separate turn budget on top of `maxTurns`, or
changing how a request with changes is treated while the budget lasts.
Choosing which tests to write remains the tester's job; the first packet
only gives it the nearby evidence.
