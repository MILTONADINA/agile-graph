# Missing-file patch feedback

- ID: missing-file-feedback
- Status: implemented
- Area: runs
- Epic: Self-improving team

## Problem

When a worker proposes a change to a file that does not exist (a guessed name
such as `math.js` when the project has `math.ts`), the feedback it receives
blames its `before` text, when the real problem is the path. The worker can
spend turns adjusting text for a file that is not there.

## Acceptance criteria

- AC1: When a worker's patch edits a path that does not exist, the system shall return feedback naming the missing project-relative file and telling the worker to create it or fix the path, classified as `missing-file`.
  - Test: packages/engine/tests/execution.test.ts :: tells the worker a patched file does not exist instead of blaming its before text
  - Test: packages/engine/tests/feedback.test.ts :: classifies a patch to a missing file as missing-file

## Security considerations

The feedback holds only the project-relative path the worker itself proposed.

## Non-goals

Suggesting similar existing files; a creation (no `before`) is unchanged.
