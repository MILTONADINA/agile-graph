# Engine line coverage floor

- ID: coverage-floor
- Status: implemented
- Area: quality
- Epic: Production readiness

## Problem

The engine had no coverage signal, so a change could remove tests without
anyone noticing. A measured floor that only moves up makes a drop visible in CI.

## Acceptance criteria

- AC1: When the engine's total line coverage in the json-summary report is below the whole percent in `scripts/coverage-floor.json`, `scripts/coverage-floor.mjs` shall exit 1 and name both percentages; at or above the floor it shall exit 0.
  - Test: scripts/coverage-floor.test.mjs :: fails when line coverage is below the floor
  - Test: scripts/coverage-floor.test.mjs :: passes at and above the floor
  - Test: scripts/coverage-floor.test.mjs :: the command exits 1 below the floor and 0 at it
- AC2: If the summary or the floor is missing, not JSON, or lacks a numeric percentage from 0 to 100, then `scripts/coverage-floor.mjs` shall fail instead of passing.
  - Test: scripts/coverage-floor.test.mjs :: fails on malformed summaries and floors
- AC3: The committed floor shall be a whole percent from 1 to 100.
  - Test: scripts/coverage-floor.test.mjs :: the committed floor is a whole percent from 1 to 100

## Security considerations

The check reads two local JSON files and writes only to the console. The
coverage report directory is ignored by Git, and no data leaves the machine.

## Non-goals

No branch or function floor, and no tolerance. The floor is not raised
automatically.
