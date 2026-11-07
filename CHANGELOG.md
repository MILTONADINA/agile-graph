# Changelog

## [Unreleased]

## [0.5.1] - 2026-11-06

### Security

- The verification-config gate reads `run-s`, `run-p` and `npm-run-all` command lines the way
  npm-run-all does: a `--<pkg>:<key> <value>` overwrite option takes the next word, and any other
  unknown option followed by a word leaves the invocation unresolved, so the gate still fires
  (GHSA-6g95-x523-3j5c).

### Fixed

- The preflight rename test runs git with an empty global config and signing
  off, so a developer's `commit.gpgsign` or global hooks cannot fail it.
- `npm run preflight` now runs `spec-check` when a change touches a test file
  that a spec links, so renaming or deleting a linked test fails locally instead
  of on every CI platform. A rename now counts as its old path deleted and its
  new path added (#330).
- `docs/publishing.md` and the release workflow no longer say only reviewed
  work is released. They now say what is enforced: a commit merged to `main`
  through a pull request with passing checks. Branch protection requires no
  approving review. A test forbids the old wording (#293).

## [0.5.0] - 2026-11-06

### Added

- Tests for the promotion trust-anchor schema (pin limits and formats, the
  Rekor key and issuer cross-checks) and for the anchor reader's refusal of
  non-file and non-canonical paths.
- Direct tests for project initialisation and loading, the cloud MCP policy
  builder, project data directory ids and provider configuration.
- Offline tests for the local embedding model loader and downloader: asset and
  checksum verification, vector validation, and the download host, scheme,
  credential and redirect limits.
- Tests for run publication: its guards, cancellation messages, commit
  content, push-URL allowlist and draft pull request creation, all against a
  local repository with `git push` and `gh` replaced.
- Tests for the Cursor text-proposal runner's input validation, token and
  byte bounds, model pinning and unusable-usage handling.
- The MCP `memory_propose` tool takes an optional `validFrom` (an ISO 8601
  date-time with a time zone, before any `validUntil`) and returns it; a
  person still accepts the proposal, and a cloud client gets nothing it could
  not get before. The tool's description and input schema changed, so its
  `mcp.toolHashes` pin must be taken again with
  `graph-engine mcp-tools --hashes`.

### Changed

- The verification-config gate also covers `pnpm-workspace.yaml`,
  `jest-preset.*`, `.coveragerc`, `.c8rc*`, the `tool.coverage` sections of
  `pyproject.toml`, the `coverage:*` sections of `setup.cfg`, and Maven or
  Gradle build files, which are gated whole and never parsed. Scripts named through `run-s`, `run-p`, `npm-run-all` or `concurrently "npm:x"` are followed, and a script pattern or variable gates every script, as does a backslash, variable or backtick anywhere in a gated script's command line or a glob character class or extglob in a `run-s` target. Leading whitespace in `setup.cfg` lines is significant for the comparison. Fail closed on bytes the two Python readers lex differently: a `setup.cfg` that contains a bare CR, VT, FF, `\x1c`-`\x1f`, NEL, LS, PS, BOM or NUL anywhere is treated as a change (configparser and iniconfig split or strip those differently); comment lines are skipped like configparser; a header is read both as configparser does (to the last `]`) and as iniconfig does (cut at the first `#` or `;`); `[DEFAULT]` counts as a gated section. A `pyproject.toml` that contains a bare CR anywhere is treated as a change (pytest and coverage read it in text mode, where a bare CR is a line break). Not gated, on purpose: a coverage rc file named with `--rcfile`, `turbo.json`/`nx.json` task graphs, and `-x test` in a Makefile or CI file. A `pyproject.toml` date-time written with a space is now read instead of refused (#246).

### Fixed

- CI now runs five `scripts/` test files it never ran (licence allowlist,
  local Jev key loader, preflight, SBOM and verification setup), and a test
  fails when a `scripts/*.test.mjs` file is not named by a workflow step
  (#323).
- CI pulls the Docker execution-test image (`node:24-alpine`) by digest and
  tags it locally, like every other workflow image, and a test fails when a
  workflow `docker pull` names an image by tag alone (#291).
- `spec-check` no longer reads an environment switch, a test name or a brace
  written inside a string, template literal, regex literal or comment as test
  structure, so a test file that mentions a gated `describe` in text is not
  reported as gated (#319).
- `spec-check` reports a line that starts like a criterion but is not
  `- AC<n>: text`, with its file and line, instead of dropping it and giving
  its test links to the criterion above. Criterion IDs with a letter suffix
  (`AC7a`) are now read; five such criteria in this repository's own specs had
  been skipped and are now checked (#318).
- A memory proposed through MCP records `proposedBy` (`cloud` or `local`),
  which `memory-accept` and `memory-review` show, and the call log entry for
  `memory_propose` carries the new memory's ID, so a person accepting a
  requirement can see that a cloud client wrote it (#295).
- The stdio MCP server answers a malformed line instead of dropping it, so a client no longer waits until its own timeout. An unparseable line gets -32700 with id null, an invalid envelope or a batch array gets -32600, and `tools/call` with non-object `arguments` gets -32602. A line over 10 MB gets -32600 and the server keeps serving, where the transport used to close. The messages are fixed and never include validator output (#297).
- `symbol_search` and `symbols` match non-ASCII names case-insensitively too: names and queries are NFC-normalized and lowercased before matching, where SQLite folded ASCII only. Folding happens at query time, so existing snapshots need no rebuild (#298).
- `docs/mcp-clients.md` has a ready installed-package configuration (`"command": "graph-engine"`) for Claude Code, Codex and Cursor beside the source-checkout ones. The platform guide's "installed CLI" example no longer shows a checkout path (#285).
- `plan --steps`, `policy --file` and the other commands that read a JSON file name the flag or argument and the file as typed: "--steps: cannot read missing.json (no such file)" or "--steps: steps.json is not valid JSON (line 1, column 2)". They used to print a raw ENOENT with an absolute path, or a parse error with no filename (#280).
- A bad flag value names the flag instead of printing a schema error about an internal field. `memory-add --kind` and `provider-add --local-thinking` list their allowed values. `--input-cost` and `--output-cost` need a number of 0 or more, `--keep` and `--max-context` need a positive whole number, and `--local-thinking-budget` a whole number of 0 or more (#279).
- An unknown run ID now gets "No run named <id>" (was "runs: record not found") in `inspect`, `cancel`, `resume` and `accept`. An unknown memory ID gets "No memory named <id> in this project" (was "Memory is unavailable in this project"). `memory-add ""` says "Memory text is required" instead of calling empty text sensitive (#281).
- `outcomes <runId>` with an unknown run exits 1 with "No run named <runId>" instead of printing `[]`, and `init --name <other>` on an existing project exits 1 naming both names instead of silently keeping the old one (#275).
- `context --budget` with a value that is not a positive whole number (`abc`, `-5`, `1.5`) says "--budget must be a positive whole number" instead of blaming the project policy. A budget above the policy keeps the policy message (#282).
- `check-add` refuses `--id` or `--optional` after the image, which it used to store silently as part of the check's command. It says to put the flag before the image, or to start the command with `--` if the command takes that flag itself (#276).
- A verification check, scanner or OSV database download whose container
  could not be confirmed removed after a timeout or cancellation now fails
  with an error that names the container and how to remove it. Its view or
  work directory is kept while the container may still mount it, and the
  OSV freshness stamp is dropped (#273).
- `spec-check` reports a `.github/workflows` directory or workflow file it
  cannot read, naming the path and error code, instead of treating every
  workflow as absent and counting tests behind an environment switch as
  verified. Only a missing directory still means "no CI" (#274).
- A cloud-backed MCP client whose call fails because policy denies an enabled
  provider's endpoint no longer receives that endpoint's host. Local clients
  still see it (#294).
- `security-scan` says "Docker is not installed or not on PATH" when it cannot start a `docker` binary, instead of telling you to start a daemon you may not have; a daemon that does not answer still gets "Docker is not running" (#278).
- `graph-engine --help` describes every command and option; 21 commands and 10 options had no help text, and a test now fails on any new one without it (#283).
- Both packages declare top-level `main` and `types`, so TypeScript projects using CommonJS or `moduleResolution: node10` resolve their types instead of failing with TS2307 (#284).
- `graph-engine -C <path> init` with a directory that does not exist now exits 1 with "No such project directory: <path>" instead of a raw ENOENT error, and creates nothing (#288).
- Both packages export `./package.json`, so tools can read an installed
  version with `require('@agile-graph/engine/package.json')` (#287).
- A Dart `pubspec.yaml` `name` line with spaces or tabs before its colon (`name : toy_counter`) no longer aborts the Dart snapshot. An analyzer reply outside its three expected shapes leaves only its own call unresolved, reported once per file, instead of failing the whole Dart binding pass (#266). The Dart resolver identity advances to `snapshot-dart-analyzer:4`, so Dart snapshots are derived again once.
- A mutation analysis whose shared deadline passed before its baseline gave a verdict is recorded as `time-budget`, not `baseline-failed`, unless a baseline check ran and failed (#267).
- The git filter-configuration probe honours the caller's cancellation and timeout, so a cancelled run no longer waits on it (#267).
- A source request for `.` lists the workspace root for a local worker, and a leading `./` is read as the path it names, under the same export and credential rules; a cloud worker's `.` request is still refused (#267).
- The new-dependency gate reads a `package.json` with a leading BOM and treats one it cannot parse as needing approval.
- The verification-config gate no longer counts a `pyproject.toml` that
  respells the same pytest settings (a table header against an inline table or
  dotted keys) as a change, and it now tells the entries of a
  `[[tool.pytest...]]` array of tables apart, so an added, empty, reordered or
  changed entry counts. A quoted `"[0]"` key no longer reads as an array index.
- The verification-config gate now reads a `setup.cfg` header with a trailing
  `#` or `;` comment, and where a pytest section ends, the way iniconfig does,
  so `[tool:pytest] ; x]` and a `[metadata#]` line no longer hide a change; it
  also sees a `pyproject.toml` empty array (`testpaths = []`) added or removed.
- A query issued while the context database is closing is refused with a
  `Context database is closed` error instead of never settling, and a request
  whose post to the database worker throws no longer stays in the pending map
  (#264).
- A Tree-sitter parser or grammar that fails to load (for example after a
  transient read error) is no longer cached for the life of the process. The
  next parse retries it, parses that start while the load is in flight still
  share it, and a failed runtime init is reported as `parser unavailable`
  instead of rejecting `parseFile`. The Dart and Rust snapshot grammars retry
  the same way (#265).
- `graph-engine mcp` exits by itself when its client closes stdin, after writing
  the replies it still owes and waiting for any cancelled tool call to finish,
  instead of waiting for the client's SIGTERM. On
  Windows that SIGTERM is a forced kill that skips closing the context database
  and the run store.

### Internal

- The Linux x64 CI job may run for 60 minutes instead of 45: a healthy run
  takes about 35, and slower runners were cut off at 45 while tests still passed.
- Seeded property tests for the verification-config scanner (tokenizer,
  runner targets, pytest ini and TOML readers) and its public gate; replay a
  failure with `PROPERTY_SEED`.

## [0.4.0] - 2026-10-30

### Added

- `context_get`, `symbol_search` and `graph_neighbors` results now carry
  optional `evidence` (source ranges or symbols), `unknowns` and `limits`
  next to `limitations`; the fields are additive and a cloud client gets no
  path, diagnostic or count beyond what it already had. The three tool
  descriptions changed, so pins in `mcp.toolHashes` must be taken again with
  `graph-engine mcp-tools --hashes`.
- A worker patch that edits a file the required checks load as
  configuration (a test runner config, or the test script entries of
  `package.json` and the scripts they reach through `npm run`, the package-manager
  rc files `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `.pnpmfile.cjs`, or the pytest
  sections of `pyproject.toml` and `setup.cfg`) is refused and returned
  to the worker as feedback unless a person listed the path in
  `policy.approvedVerificationConfigPaths`. Scripts a test script reaches in
  another workspace package (`--workspace`, `--prefix`, `--filter`, `yarn
  workspace`) are gated too, option values such as `--script-shell` are
  skipped when finding the script, and an invocation that cannot be resolved
  gates every script of the manifests.
  The `pyproject.toml` pytest settings are read as TOML with the key path
  normalised, so spaced, quoted or escaped dotted keys and headers, inline tables and
  multi-line values all count; a `pyproject.toml` that cannot be read
  confidently is treated as a configuration change. Ordinary dependency
  bumps (`pytest-cov` or `pytest` under any dependency table) are not gated.
- A memory may carry `validFrom` (`--valid-from` on `memory-add` and
  `memory-accept`): before that instant it is absent from local and cloud context
  packets, and a successor whose `validFrom` precedes its predecessor's is
  refused at acceptance.
- A configured reviewer now rules `raised` or `dropped`, with a reason, on every
  security scan finding, baselined finding and inline suppression, each given a
  stable ID. A missing, unknown or duplicate ID or an empty reason fails the
  review as not completed, and a `dropped` ruling never clears the security
  gate (code-review-gate AC15). The review reserves output for each result
  instead of capping their number, and refuses up front, naming
  `policy.maxOutputTokens`, when the policy cannot hold the rulings.
  The review record keeps whether its findings may leave the machine; a retry
  or resume after the reviewer was reconfigured to a cloud provider never
  sends a stored finding that quotes scan results from a non-exportable path
  to that reviewer or to a cloud worker, and fails closed when the flag is
  missing.
- `graph-engine retro` reports `graphOwnedWithoutFollowUp` per run and in
  total: graph-owned terminal stops for which no `converge` follow-up plan
  names the run, read through a new read-only store accessor. Second slice
  of #163.
- `graph-engine retro` reports `deferredToPerson`, `deferredByReason`
  (`approval`, `credential`, `spending`, `owner-decision`) and
  `graphOwnedStops` per run and in total, from a closed classification of
  every stop kind; plan-approval stops now have their own `plan-approval`
  kind. First slice of #163.
- A review that rejects the same finding twice in a row now stops the run with
  the `repeated-review-finding` kind instead of repeating the same repair (#146).
  Findings get a stable signature, the next repair round is told which
  findings were already raised, and each review round records its `minutes`.
- `serve --log-requests` now writes structured JSON lines (`level`, `time`,
  `method`, `route`, `status`, `duration_ms`, `request_id`), with the error
  name and redacted message on a 5xx and no query string, header or stack.

### Fixed

- Published `@agile-graph/engine` and `@agile-graph/contracts` JavaScript no
  longer ends with `sourceMappingURL` comments naming maps the tarballs never
  carried (#247).
- `npm run preflight` now builds the engine before the script tests when one
  of them needs `packages/engine/dist`, so a fresh checkout no longer fails
  `readme-quickstart.test.mjs` (#228).

### Changed

- `AGENTS.md` no longer tells every agent to read the handover before
  working; it points to the handover by situation. A new
  `scripts/agents-md-rules.test.mjs`, run in CI, fails if a rule against
  pushing to `main`, publishing, memory export, key use, cost-cap changes or
  model downloads is dropped, or if a read-first instruction returns.
- The Linux x64 platform job collects engine coverage during the engine tests
  it already runs (`GRAPH_ENGINE_COVERAGE=1`, that matrix entry only) instead of
  running the suite a second time, and its time limit goes back to 45 minutes
  (#232).

### Documentation

- `docs/upgrading.md` explains how to upgrade from 0.2.0 and roll back: tool
  hash re-pinning, the new refusals and policy fields, and the run store.
  A docs policy test requires a heading there for every release that
  mentions hashes or breaking changes.

### Security

- A worker patch that adds a dependency name to a `package.json`,
  `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod` or
  `pubspec.yaml` is refused before anything is written, naming the new
  dependency, so a hallucinated or slopsquatted package needs a person's
  approval. Version changes and removals are allowed.

### Internal

- `npm run test:coverage -w @agile-graph/engine` measures engine line coverage
  with `@vitest/coverage-v8`, and the Linux x64 platform job fails when it
  drops below the floor in `scripts/coverage-floor.json` (85%). This replaces
  the plan in `docs/coverage.md`.
- `npm run preflight` lints changed files with `--max-warnings 0`, as CI does.

## [0.3.0] - 2026-10-26

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
- Worker, planner, reviewer and security-audit prompts now wrap all
  repository-derived text (file excerpts, memory, spec text, diffs, check
  output) in one block with a random per-prompt delimiter the content cannot
  contain, preceded by a notice that the text is data, never instructions.
  Request size estimates include the wrapper.

### Internal

- A test checks the README's Install commands and Node range against the built
  CLI and `engines.node`, and the npm smoke runs the README's `init` and
  `index --lexical` arguments, so the README cannot drift unnoticed.
- `npm run lint` now fails on any ESLint warning (`--max-warnings 0`), and the
  unused `no-control-regex` disable comment in the fatal-error sanitiser is
  removed.
- CI and the release workflow run `scripts/pack-twice.mjs`, which packs the
  contracts and engine packages twice from one build and fails with a
  file-by-file diff if the two tarballs differ; see `docs/publishing.md`.

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
