# Spec-driven development

- ID: spec-driven-development
- Status: implemented
- Area: quality
- Epic: AI agile team

## Problem

A team builds what was agreed and can show that it works. Every feature of
Agile Graph, and of a project that uses it, is written as a spec
before it is built: the problem, acceptance criteria, and a link from each
criterion to the test that proves it. A checker keeps the links honest, CI
runs it, and plans can be created straight from a ready spec.

## Acceptance criteria

- AC1: A spec is read into its title, ID, status, area, epic, sections, criteria and test links, ignoring anything inside code fences, where a fence closes only on a line of its own delimiter character, at least as long and with no info string.
  - Test: packages/engine/tests/specs.test.ts :: reads fields, sections, criteria and test links
  - Test: packages/engine/tests/specs.test.ts :: ignores headings and criteria inside code fences
  - Test: packages/engine/tests/specs.test.ts :: passes a ready spec whose four-backtick example holds a three-backtick snippet and a marker
- AC2: `spec-new` scaffolds a valid draft, and a draft cannot be planned.
  - Test: packages/engine/tests/specs.test.ts :: scaffolds a valid draft
  - Test: packages/engine/tests/specs.test.ts :: refuses to plan a draft
- AC3: `spec-check` passes an implemented spec whose criteria all link existing tests, and reports missing tests, missing sections, wrong placement and duplicate IDs.
  - Test: packages/engine/tests/specs.test.ts :: passes an implemented spec whose criteria link existing tests
  - Test: packages/engine/tests/specs.test.ts :: reports missing tests, missing sections, bad placement and duplicate IDs
- AC4: A ready spec may have criteria without tests yet, but not zero criteria.
  - Test: packages/engine/tests/specs.test.ts :: lets a ready spec have untested criteria but not an empty one
- AC5: A link counts only when the named file defines a runnable test with exactly that name; commented-out tests and symlinked files do not count, and comment markers inside strings or regex literals (such as the glob `"**/*.md"`) do not hide the tests after them.
  - Test: packages/engine/tests/specs.test.ts :: counts only a runnable test with exactly the linked name
  - Test: packages/engine/tests/specs.test.ts :: finds tests after a glob string or a regex that look like comments
  - Test: packages/engine/tests/specs.test.ts :: does not follow a symlinked test file
- AC6: In a repository with CI workflows, a criterion proven only by tests that need an environment switch no CI step sets for that file fails the check. Finding a switch on an enclosing `describe` block takes one linear pass over the test file, however many gated blocks it opens.
  - Test: packages/engine/tests/specs.test.ts :: reads the switch a linked test needs
  - Test: packages/engine/tests/specs.test.ts :: reads switches in a file of many unclosed gated blocks in one linear pass
  - Test: packages/engine/tests/specs.test.ts :: fails a criterion proven only by a switched-off test that no CI step runs
- AC7: `plan --spec` takes the objective and criteria from a ready spec and records the spec's path and hash on the plan.
  - Test: packages/engine/tests/outcomes.test.ts :: takes the objective and criteria from a ready spec and records it on the plan
- AC8: When `npm run preflight` plans a script test that loads or runs the built engine (`packages/engine/dist`), the system shall run the engine build step before the script tests, once, and shall add no build step when no planned script test needs it.
  - Test: scripts/preflight.test.mjs :: the engine build runs before script tests that need the built engine
  - Test: scripts/preflight.test.mjs :: no engine build is added for script tests that do not need it
  - Test: scripts/preflight.test.mjs :: a spec change with a dist-dependent script test builds once, before the script tests and spec-check
- AC9: When `.github/workflows` is missing, the system shall treat the repository as having no CI to check switched tests against. When the directory or a `*.yml`/`*.yaml` entry in it exists but cannot be read (not a directory, permission denied, a dangling link, a directory named like a workflow), `spec-check` shall report a problem naming that path and the error code, and shall not let the unreadable entry verify a test behind an environment switch. (#274)
  - Test: packages/engine/tests/specs-workflows.test.ts :: reports a workflows path that is a regular file and does not count the switched test
  - Test: packages/engine/tests/specs-workflows.test.ts :: reports a dangling workflow link and does not count the switched test
  - Test: packages/engine/tests/specs-workflows.test.ts :: reports an unreadable workflow entry but still counts a readable one that runs the switch
  - Test: packages/engine/tests/specs-workflows.test.ts :: still treats a repository without .github as having no CI to check
- AC10: A criterion is a line `- AC<n>: text`, where the ID may carry one lowercase letter suffix (`AC7a`). When a line in "Acceptance criteria" starts with `- AC` and a digit but is not in that form, `spec-check` shall report it with its file and line number, and the `Test:` links under it shall belong to no criterion until the next well-formed one. Plan coverage reads suffixed IDs the same way (#318).
  - Test: packages/engine/tests/specs-criteria.test.ts :: reports a criterion line with text before its colon and keeps its test links off the criterion above
  - Test: packages/engine/tests/specs-criteria.test.ts :: fails spec-check on a malformed criterion, naming the file and line
  - Test: packages/engine/tests/specs-criteria.test.ts :: reads a criterion ID with a letter suffix, such as AC7a, and covers it in plans
- AC11: When `spec-check` looks for the environment switch that gates a test, code written inside a string, template literal, regex literal or comment shall neither gate nor enclose the test, and shall not stand in for the test's own definition (#319).
  - Test: packages/engine/tests/specs-switch-literals.test.ts :: ignores a gated describe written inside $label
  - Test: packages/engine/tests/specs-switch-literals.test.ts :: ignores a test name written inside a string in a gated block
  - Test: packages/engine/tests/specs-switch-literals.test.ts :: ignores braces inside strings when pairing a gated block
  - Test: packages/engine/tests/specs-switch-literals.test.ts :: ignores braces inside regex literals but not division
  - Test: packages/engine/tests/specs-switch-literals.test.ts :: reads a comment opener inside a regex literal as part of the regex
  - Test: packages/engine/tests/specs-switch-literals.test.ts :: reads a slash after a postfix increment as division

## Security considerations

Test files are read through the same path checks as any source read:
symlinks, escapes and excluded paths never count as proof. Specs and tests
are plain repository files and are reviewed like code. A test link proves a
named test exists and, where CI workflows exist, that CI runs it; it does
not prove the test is thorough.

## Non-goals

Judging test quality, updating links automatically, or reading CI
configuration as full YAML; the workflow check is a textual reading of each
step.
