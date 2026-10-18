# Changelog

## [Unreleased]

### Changed

- Verification containers now run as a non-root user on every platform, and
  the verification image ends with `USER node`. Running the engine as root is
  refused for verification; run it as a non-root user.

### Fixed

- A patch whose before text matches at overlapping positions is now refused
  instead of patching the first match (#179).
