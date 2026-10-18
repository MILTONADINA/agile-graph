# Test isolation from user data

- ID: test-isolation
- Status: implemented
- Area: quality
- Epic: Production readiness

## Problem

Developers run the engine test suites on the same machine where they use the
engine. Tests that open a project without choosing a data folder wrote under
the user's real data directory, leaving hundreds of project data folders for
temporary repositories that no longer exist (issue #176).

## Acceptance criteria

- AC1: When the engine's vitest suite starts without `GRAPH_ENGINE_DATA_DIR` set, the suite shall point `GRAPH_ENGINE_DATA_DIR` at a new temporary folder for that run in every test worker, and so in every process a test spawns with the inherited environment, so no project data folder is created under the user's data directory. A test that spawns a process with an explicit environment shall pass its own temporary `GRAPH_ENGINE_DATA_DIR`.
  - Test: packages/engine/tests/test-data-dir.test.ts :: keeps every test's project data out of the user's data directory
- AC2: When the run ends, the suite shall remove only the folder that run created; a folder the caller set, or one an outer run created and a nested run inherited, shall be kept.
  - Test: packages/engine/tests/test-data-dir.test.ts :: never removes a data folder this run did not create

## Security considerations

Test runs no longer leave copies of synthetic project state, memory or run
records in the user's data directory, where they could be mistaken for real
project data or swept up by backups. The temporary folder is created with
`mkdtemp`, so its name is unpredictable.

## Non-goals

This does not clean up folders earlier test runs already left behind, and it
does not cover the `node --test` suites in `scripts/` and `evaluation/`.
