# Whole criteria, clarified specs, criteria coverage and converge

- ID: spec-kit-planning
- Status: implemented
- Area: planning

## Problem

Planning from a spec loses or guesses information. A criterion written over several lines, or with nested bullets, reached workers as its first line only. A spec can still hold open questions when it is marked ready, and a planner then guesses the answers. A person approving a decomposed plan cannot see which criteria its steps address, and after a run whose review found criteria unmet there is no quick way to plan only the remaining work. These upgrades are adapted from GitHub's spec-kit.

## Acceptance criteria

- AC1: A spec's acceptance criterion keeps its indented continuation lines, nested bullets and indented fenced code blocks, joined into one string, while its `- Test:` link lines stay out of the text and keep linking tests, and nothing inside a fence is read as a criterion, a test link or a clarification marker. A fence closes only on a line of the same delimiter character, at least as long as the opening one and with no info string, as in CommonMark, so a four-backtick block can hold a three-backtick example.
  - Test: packages/engine/tests/specs.test.ts :: keeps a criterion's wrapped lines and nested bullets in its text
  - Test: packages/engine/tests/specs.test.ts :: keeps a fenced block under a criterion in its text but reads no marker in it
  - Test: packages/engine/tests/specs.test.ts :: closes a fence only with the same delimiter, at least as long, with no info string
  - Test: packages/engine/tests/specs.test.ts :: passes a ready spec whose four-backtick example holds a three-backtick snippet and a marker
- AC2: An inline NEEDS CLARIFICATION marker, in any case and with or without a colon and a question, in the Problem, Acceptance criteria, Security considerations or Non-goals section is a `spec-check` error naming its question, or saying none was written, for a ready or implemented spec, a draft may hold markers, `plan --spec` refuses a spec while any remain and names them, and the spec template explains the marker in a comment line.
  - Test: packages/engine/tests/specs.test.ts :: fails a ready spec with open clarification markers but lets a draft hold them
  - Test: packages/engine/tests/specs.test.ts :: refuses to plan a spec with open clarification markers, naming them
  - Test: packages/engine/tests/specs.test.ts :: finds clarification markers in any case, with or without a question
  - Test: packages/engine/tests/specs.test.ts :: explains the clarification marker in a template comment
- AC3: A plan step may name the acceptance-criterion IDs it covers, the planner is asked for them and its blank entries are dropped rather than failing the proposal, and `plan-approve` and `decompose` show which criteria no step covers and which named IDs match no criterion when any step names some, as advice that gates nothing; a plan whose steps name none hashes exactly as before.
  - Test: packages/engine/tests/planning.test.ts :: reports criteria no step covers and covers entries naming no criterion
  - Test: packages/engine/tests/plan-worker.test.ts :: asks the planner which acceptance criteria each step covers
  - Test: packages/engine/tests/plan-worker.test.ts :: drops blank covers entries instead of failing a paid-for proposal
  - Test: packages/engine/tests/dag.test.ts :: accepts covers on a step and leaves the hash of a plan without it unchanged
  - Test: packages/engine/tests/cli.test.ts :: shows acceptance-criteria coverage in plan-approve when steps name the criteria they cover
  - Test: packages/engine/tests/cli.test.ts :: includes acceptance-criteria coverage in the decompose output when the planner names it
- AC4: `converge <runId>` creates a new plan, through the ordinary plan creation, whose acceptance criteria are only those the finished run's latest AI review did not find met and whose objective starts with a single "Follow-up of run <runId>:" naming that run, any earlier follow-up prefix stripped, cut to the 16000-character plan objective limit; it never changes the run or its plan, and creates nothing when every criterion was met.
  - Test: packages/engine/tests/planning.test.ts :: takes the criteria the latest AI review did not find met, by position
  - Test: packages/engine/tests/planning.test.ts :: keeps one follow-up prefix naming the latest run and caps the objective
  - Test: packages/engine/tests/execution.test.ts :: converges a finished run into a new plan of only its unmet criteria, changing nothing else

## Security considerations

Coverage is a step's own claim, shown to the person who approves the plan; it is never evidence that a criterion is met and never gates a run, which stays with the checks, the reviewer and the person. Covers entries are untrusted planner text: they are length-bounded, included in the secret check on an export-only proposal, and part of the stored plan its approval binds. A follow-up plan from `converge` goes through the normal plan creation, so it is bound to the current policy and source and needs its own approval wherever plans do; the run it follows is only read. A person's approval in place of the reviewer judges no criterion, so `converge` reads only the AI reviewer's answers.

## Non-goals

Coverage does not check that a step's work satisfies the criteria it names. `converge` does not run the new plan, carry over the original plan's steps or spec binding, or merge results across runs. Clarification markers outside the four plan sections, or inside fenced examples, are not checked.
