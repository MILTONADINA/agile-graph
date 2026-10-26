# Changelog

## [Unreleased]

### Added

- The release workflow generates a CycloneDX SBOM (`npm sbom`, with the
  published package as its subject and only what that package reaches,
  optional peers included) for each published package and uploads it as a workflow
  artifact; see `docs/publishing.md`.
- `npm run graph:local -- --with-jev` can read the Jev key from the macOS
  login keychain: `jev-key-source.json` accepts
  `{"format":"keychain","service":...,"account":...}`. It fails closed off
  macOS or when the lookup fails, and errors name only the service.
- `docs/coverage.md`: plan for an engine coverage report and ratchet floor. Not wired up yet, because `@vitest/coverage-v8` is not installed.
- `scripts/license-allowlist.mjs` fails CI when a production dependency in
  `package-lock.json` has a missing licence or one outside
  `scripts/license-allowlist.json`. It runs offline after `npm audit`.
- `backup` and `restore` warn when the run store holds orphan rows
  (`run_events` or `run_outcomes` without a run, `plan_approvals` without a
  plan). Only counts are reported; nothing is deleted and the check still
  passes.

### Documentation

- Document the versioning and support policy for 0.x packages.

### Security

- Patched npm dependencies for the advisories that failed CI's production
  `npm audit` gate: body-parser (GHSA-27r3-jxmh-p828), fast-uri, hono
  (GHSA-5r4p-p66f-jhc7 and others), ip-address (GHSA-rxp7-6hxx-x8q5), sharp
  (GHSA-wq5f-xc86-pv6w), source-map-js (GHSA-68fv-2mgg-jv7q), undici
  (GHSA-4qv8-2p9j-2685, GHSA-xjj6-f33q-929c) and vite (including
  GHSA-9jrq-w75r-8gcw). The zod advisory (GHSA-mrhx-c7xc-m3w5) is fixed by the
  zod 4 upgrade below.
- Upgraded zod to ^4.6.7, which fixes memory exhaustion while validating large
  arrays (GHSA-mrhx-c7xc-m3w5), and gave every array schema in the engine an
  explicit maximum length. `npm audit --omit=dev --audit-level=high` passes.

### Internal

- A test checks the README's Install commands and Node range against the built
  CLI and `engines.node`, and the npm smoke runs the README's `init` and
  `index --lexical` arguments, so the README cannot drift unnoticed.

### Changed

- The engine uses zod 4 (`@agile-graph/contracts` has no zod dependency, so
  contracts consumers see no zod types). Accepted and rejected inputs are
  unchanged, but zod's own error wording differs. The JSON input schemas the
  MCP server publishes now come from zod 4, so MCP tool definition hashes
  change: pins in `mcp.toolHashes` or `--tool-hashes` files must be taken
  again with `graph-engine mcp-tools --hashes --all-configurations`. A plan
  step's `dependsOn` accepts at most 100 entries.
- CI and release workflows install with `npm ci --ignore-scripts` and rebuild only
  an allowlist of packages with install scripts; a test keeps the list in sync
  with `package-lock.json`.
- Dashboard timestamps now show a time zone abbreviation (for example
  `Oct 19, 4:02 PM CDT`) so run times are unambiguous across machines.
- Renamed Graph Engineering to Agile Graph. This ships in 0.3.0. Visible
  changes: the MCP server now reports the name `agile-graph` (client
  configurations and `mcp__graph-engineering__` tool permissions need the new
  name, see `docs/platform.md`), and the dashboard header reads AGILE GRAPH.
  The private data folder is now `agile-graph` in the per-user data
  directory; an existing `graph-engineering` folder is still used when it is
  the only one, and nothing is moved. `npm run verify:image` builds
  `agile-graph-verify:local` (the old tag is still applied too), live-scan containers are labelled
  `agile-graph.live-scan`, SARIF reports name the tool `agile-graph`, and the
  default key backup file is `agile-graph-keys.backup.json`. The dashboard
  moves a token stored under the old session key. Signature domains, record
  kinds, the trust anchor location and the Dart image labels keep their old
  spelling.
- Minor and patch dependency updates: eslint 10.12.0, globals 17.13.0, prettier
  3.9.10, typescript-eslint 8.71.2, react and react-dom 19.3.1,
  @playwright/test 1.64.1, @fastify/static 10.1.6, @modelcontextprotocol/sdk
  1.32.1, fastify 5.12.7, ignore 7.0.12 and @huggingface/transformers 4.3.1.
  Held back: web-tree-sitter stays at 0.25.10 because 0.27.1 cannot load the
  pinned tree-sitter-wasms 0.1.13 grammars, and @cursor/sdk stays at 1.0.32
  because the Cursor worker refuses any version that has not passed its
  control audit.
- The Laya sidecar uses `laya` 0.4.12 and checkpoint revision
  `7b928d828b7b0e022f929d9bd2e44165aa270148`, whose model files are identical
  to the earlier `1c5edc17` pin. The served model id is now
  `laya-english@7b928d8…/sdk0.4.12/prob-v1`, so provision the checkpoint into a
  fresh directory (an existing one is refused), serve from it and update `decisions.json`. The sidecar also refuses any answer
  the SDK reports as computed on a truncated state.
- Dependabot no longer opens npm version-update pull requests, which failed
  CI by design against the hash-pinned lockfile; npm security updates are
  unaffected by this limit, and a maintainer accepts version updates monthly.
- Run events are read a bounded page at a time. The event stream fetches only
  events after the last one it sent instead of re-reading the whole run every
  second, and `GET /api/runs/:id` returns at most `limit` events (default
  1000, maximum 5000) after `after`, with `nextAfter` when more remain.
- The run store indexes `plans`, `runs`, `decisions`, `plan_approvals`,
  `worker_leases` and `owner_proofs` by `project_id`, so per-project lookups
  no longer scan the table. The indexes are added on open without changing
  any row or the schema version, so an older engine still opens the database.

### Internal

- `npm run lint` now fails on any ESLint warning (`--max-warnings 0`), and the
  unused `no-control-regex` disable comment in the fatal-error sanitiser is
  removed.

### Security

- Worker, planner, reviewer and security-audit prompts now wrap all
  repository-derived text (file excerpts, memory, spec text, diffs, check
  output) in one block with a random per-prompt delimiter the content cannot
  contain, preceded by a notice that the text is data, never instructions.
  Request size estimates include the wrapper.

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
