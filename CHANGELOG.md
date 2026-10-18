# Changelog

## [Unreleased]

### Security

- The verification image now pins its base image by digest
  (`node:24-bookworm@sha256:...`), and a test requires every registry `FROM`
  in the repository's Dockerfiles to carry a digest.
- CI now runs `npm audit --omit=dev --audit-level=high` and fails on a high or
  critical advisory in production dependencies. Dependabot opens weekly
  grouped update pull requests for npm and GitHub Actions.

### Changed

- Verification containers now run as a non-root user on every platform, and
  the verification image ends with `USER node`. Running the engine as root is
  refused for verification; run it as a non-root user.

### Fixed

- A patch whose before text matches at overlapping positions is now refused
  instead of patching the first match (#179).
