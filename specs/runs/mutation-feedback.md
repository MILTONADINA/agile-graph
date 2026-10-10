# Mutation feedback to the tester

- ID: mutation-feedback
- Status: implemented
- Area: runs
- Epic: AI agile team

## Problem

A configured tester writes tests before anyone implements the change, but
nothing checks that those tests would notice a wrong implementation. Mutation
testing (as in MutGen and Meta's ACH) measures that: small, deliberate
changes to the code (mutants) that no test notices show where the tests are
weak, and telling the test writer about them improves the tests.

`policy.mutationRounds` (an integer from 0 to 3, absent or 0 meaning off)
turns on a bounded loop after the tester proposes its tests and before they
are applied:

1. The engine generates simple, deterministic, language-agnostic mutants of
   the code files the tester's focus found from the plan's objective and
   acceptance criteria (the files a cloud tester may see, for a cloud
   tester): a flipped comparison, a swapped logical or arithmetic operator,
   a negated `if`/`while` condition, or a return of the constant 0. Lines
   with no executable code (blank, comment-only, import or package lines,
   braces) are never mutated, and operators inside string literals are left
   alone. At most 12 mutants run per round.
2. The project's checks run in the offline sandbox (`verifyInContainer`) on
   temporary views of the workspace with the tester's tests added; each
   mutant is a replaced file in its own view. The workspace is never
   written, and these runs record no `verification.*` events, so they are
   never acceptance evidence.
3. Only checks that pass on the unmutated code with the new tests count: a
   mutant is killed when one of them fails on it. When none pass, as is
   usual before an implementation exists, nothing can be measured and the
   round is recorded as `baseline-failed`.
4. Surviving mutants (at most 10) go back to the tester as feedback that
   names each one's `file:line` and the operator change, never source text,
   for one more test-writing round. The tester proposes its complete tests
   again; it may resubmit them unchanged.

Each round records a `mutation.analyzed` run event with the round, status,
mutant, killed, survived and equivalent counts, the score (killed /
mutants, or null) and the survivors' locations. The run receipt's evidence
ledger carries the latest one as `mutation`; it is advisory and never gates
a run. A round needs one more model call within `policy.maxTurns`: when the
tester's proposal came on its last turn, the round is recorded as
`turn-budget` and the proposal is accepted. The whole analysis (baseline and
mutants) shares one check timeout (`verificationTimeoutSeconds`, else
`timeoutSeconds`): once it has passed no further mutant starts, the round
is recorded as `time-budget`, and survivors found so far still go back. A
mutant is killed only by a failing result from a check; a run with no
failing result and fewer results than checks is `inconclusive`, and
unrun or inconclusive mutants are left out of the score (killed / scored,
or null). Because the analysis is advisory, any error in it (a sandbox,
overlay or read failure) records the round as `error`, with no error
text, and the proposal is accepted. Re-proposals and file requests
count against `maxTurns` and the read budget as any call does.

Each surviving mutant is also put to the configured decision providers as a
`mutant_equivalence` question (`distinct` baseline, `equivalent`
alternative), with the mutated line in local-only state and
`exportable: false`. A survivor is dropped only when that category's answer
is applied; while decisions are shadow, every survivor goes back to the
tester and the answers are only recorded.

## Acceptance criteria

- AC1: Mutants are deterministic, change one operator, condition or return per mutant, and are never made on lines without executable code or from operators inside strings, in JavaScript-like and Python sources.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: mutates operators, conditions and returns on executable lines only
  - Test: packages/engine/tests/mutation-feedback.test.ts :: leaves arrows, strings, comments and imports alone and works on Python
- AC2: Without `policy.mutationRounds` nothing changes: no mutation analysis, no extra sandbox runs or tester calls, and a policy without the key keeps its hash; values above 3 are refused.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: is off without policy.mutationRounds and keeps the policy hash
- AC3: With `mutationRounds` set, surviving mutants go back to the tester as `file:line: description` lines with no source text, at most once per round, and each round records its score in a `mutation.analyzed` event and the receipt's evidence ledger.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: sends surviving mutants back to the tester as locations and operators only, and records the score
- AC4: When no check passes on the unmutated code with the new tests, the round runs no mutant, records `baseline-failed` and sends no feedback.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: skips the analysis when no check passes on the unmutated code
- AC5: A round never makes a model call beyond `policy.maxTurns`: on the tester's last turn it records `turn-budget` and accepts the proposal without running the sandbox.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: never spends a round when no model call is left within maxTurns
- AC6: Each survivor is put to the decision providers as a local-only `mutant_equivalence` question, and in shadow mode every survivor still goes back to the tester.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: asks the local decision provider about each survivor and still feeds every survivor back in shadow mode
- AC7: An error during the analysis never fails the tester step: the round is recorded as `error` with no error text and the proposal is accepted.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: records an analysis error and accepts the tester's proposal when the sandbox throws
- AC8: A mutant counts as killed only when a check returns a failing result on it; a run that returns no failing result is inconclusive and left out of the score.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: counts a mutant whose sandbox run returned no failing result as inconclusive, not killed
- AC9: Once the analysis has used one check timeout, no further mutant starts and the round is recorded as `time-budget` with unrun mutants left out of the score.
  - Test: packages/engine/tests/mutation-feedback.test.ts :: starts no mutant once the analysis has used the check timeout

## Security considerations

Mutant runs use the same offline sandbox, registered images and temporary
views as required checks; `replaced` overlays may only overwrite a file the
view already copied under the policy, through `safePath`. The mutated files
are the tester's focus code, already screened by the tester's export rule,
so a cloud tester's feedback names only paths it may see, and the feedback
carries operators and line numbers, never source text. The equivalence
questions are not exportable and carry source lines only in local state.
`mutationRounds` is part of the hashed policy: setting it voids existing
plans, as any policy change does.

## Non-goals

Per-test kill attribution (checks report pass or fail as a whole), mutation
after implementation, language-specific mutation operators, or gating a run
on its mutation score.
