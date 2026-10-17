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

- AC2: When a worker's patch edits a path that does not exist, the system shall also list up to 3 existing files with the same base name (any extension) or the same file name in another directory, or say that none exists.
  - Test: packages/engine/tests/execution.test.ts :: tells the worker a patched file does not exist instead of blaming its before text
- AC3: If a file with a similar name is excluded by policy, outside exportPaths for a cloud worker, named like a credential, or not an existing regular file, then the system shall not list it in the feedback.
  - Test: packages/engine/tests/execution.test.ts :: suggests only readable files when a patched file does not exist
  - Test: packages/engine/tests/execution.test.ts :: suggests only exportable, non-credential files to a cloud worker

## Security considerations

The feedback holds the project-relative path the worker itself proposed and
suggested names drawn only from the files the worker may read: Git's file list
minus policy-excluded paths and, for a cloud worker, paths outside exportPaths
or named like a credential.

## Non-goals

A creation (no `before`) is unchanged.
