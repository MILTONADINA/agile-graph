# Changelog

## [Unreleased]

### Changed

- Run events are read a bounded page at a time. The event stream fetches only
  events after the last one it sent instead of re-reading the whole run every
  second, and `GET /api/runs/:id` returns at most `limit` events (default
  1000, maximum 5000) after `after`, with `nextAfter` when more remain.

### Fixed

- The engine test suite no longer writes project data folders into the
  user's data directory: each run uses a temporary `GRAPH_ENGINE_DATA_DIR`
  that is removed afterwards (#176).

## [0.2.0] - 2026-10-18

### Added

- `serve --log-requests` writes one stderr line per request (method, route
  pattern, status, duration) and per 5xx error (redacted). Off by default.
- A written flaky-test policy, `docs/flaky-tests.md`: rerun once, file an
  issue, no blind timeout raises, quarantine rules and retro counting.

### Security

- The dashboard server sends a Content-Security-Policy with
  `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response,
  including event streams; answers 413, 415 and a generic 500 instead of
  masking faults as 400; and caps concurrent event streams (503 with
  Retry-After).
- CI scans the full Git history for secrets with a pinned gitleaks.
- The verification image now pins its base image by digest
  (`node:24-bookworm@sha256:...`), and a test requires every registry `FROM`
  in `infra/*.Dockerfile`, the engine test fixture Dockerfiles and
  `sidecars/*/Dockerfile` to carry a digest. The Laya sidecar image now pins
  `python:3.12-slim` by digest.
- CI now runs `npm audit --omit=dev --audit-level=high` and fails on a high or
  critical advisory in production dependencies. Dependabot opens weekly
  grouped update pull requests for npm and GitHub Actions.

### Changed

- A worker's edit to an existing file must change only lines the worker was
  shown; other edits are held back with feedback instead of applied.
- Verification containers now run as a non-root user on every platform, and
  the verification image ends with `USER node`. Running the engine as root is
  refused for verification; run it as a non-root user.

### Fixed

- `serve`, `mcp` and `watch` close their stores and exit 1 on a fatal error
  instead of hanging, with closing bounded at 5 seconds.
- The SQLITE_BUSY retry when opening the run and context databases now uses
  jittered backoff, and both databases set `synchronous = FULL` explicitly
  with WAL.
- A patch whose before text matches at overlapping positions is now refused
  instead of patching the first match (#179).
