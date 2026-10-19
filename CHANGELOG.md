# Changelog

## [Unreleased]

### Changed

- Renamed Graph Engineering to Agile Graph. This ships in 0.3.0. Visible
  changes: the MCP server now reports the name `agile-graph` (client
  configurations and `mcp__graph-engineering__` tool permissions need the new
  name, see `docs/platform.md`), and the dashboard header reads AGILE GRAPH.
  The private data folder is now `agile-graph` in the per-user data
  directory; an existing `graph-engineering` folder is still used when it is
  the only one, and nothing is moved. `npm run verify:image` builds
  `agile-graph-verify:local`, live-scan containers are labelled
  `agile-graph.live-scan`, SARIF reports name the tool `agile-graph`, and the
  default key backup file is `agile-graph-keys.backup.json`. The dashboard
  moves a token stored under the old session key. Signature domains, record
  kinds, the trust anchor location and the Dart image labels keep their old
  spelling.
- Run events are read a bounded page at a time. The event stream fetches only
  events after the last one it sent instead of re-reading the whole run every
  second, and `GET /api/runs/:id` returns at most `limit` events (default
  1000, maximum 5000) after `after`, with `nextAfter` when more remain.
- The run store indexes `plans`, `runs`, `decisions`, `plan_approvals`,
  `worker_leases` and `owner_proofs` by `project_id`, so per-project lookups
  no longer scan the table. The indexes are added on open without changing
  any row or the schema version, so an older engine still opens the database.

### Added

- `backup` and `restore` warn when the run store holds orphan rows
  (`run_events` or `run_outcomes` without a run, `plan_approvals` without a
  plan). Only counts are reported; nothing is deleted and the check still
  passes.

### Fixed

- The engine test suite no longer writes project data folders into the
  user's data directory: each run uses a temporary `GRAPH_ENGINE_DATA_DIR`
  that is removed afterwards (#176).
- `snapshots-prune --apply` now checkpoints the WAL and runs `VACUUM` after
  deleting snapshots, so the data folder shrinks (#177). The output reports
  `vacuum.reclaimedBytes`; if another process holds the database the prune
  still succeeds and reports why space was not reclaimed. `--no-vacuum` skips
  it, and a dry run never vacuums.

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
