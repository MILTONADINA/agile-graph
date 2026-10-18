# Changelog

## [Unreleased]

### Added

- `serve --log-requests` writes one stderr line per request (method, route
  pattern, status, duration) and per 5xx error (redacted). Off by default.

### Security

- The verification image now pins its base image by digest
  (`node:24-bookworm@sha256:...`), and a test requires every registry `FROM`
  in `infra/*.Dockerfile`, the engine test fixture Dockerfiles and
  `sidecars/*/Dockerfile` to carry a digest. The Laya sidecar image now pins
  `python:3.12-slim` by digest.
- CI now runs `npm audit --omit=dev --audit-level=high` and fails on a high or
  critical advisory in production dependencies. Dependabot opens weekly
  grouped update pull requests for npm and GitHub Actions.

### Changed

- Verification containers now run as a non-root user on every platform, and
  the verification image ends with `USER node`. Running the engine as root is
  refused for verification; run it as a non-root user.

### Fixed

- The SQLITE_BUSY retry when opening the run and context databases now uses
  jittered backoff, and both databases set `synchronous = FULL` explicitly
  with WAL.
- A patch whose before text matches at overlapping positions is now refused
  instead of patching the first match (#179).
