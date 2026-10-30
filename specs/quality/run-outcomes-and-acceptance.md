# Run outcomes and human acceptance

- ID: run-outcomes-and-acceptance
- Status: implemented
- Area: quality

## Problem

A team learns by looking back at what it decided and how that turned out. Operators need every managed run's ending recorded as facts, linked to the decisions and memories that shaped it, and a person's acceptance or rejection of the result recorded as a separate decision, so that "the automated gates passed" is never confused with "a person accepted this".

## Acceptance criteria

- AC1: A succeeded run records an outcome linked to its decision records, with human acceptance pending.
  - Test: packages/engine/tests/outcomes.test.ts :: records a succeeded run with its decisions, pending human acceptance
- AC2: A resumed run keeps one outcome per terminal transition.
  - Test: packages/engine/tests/outcomes.test.ts :: keeps every terminal transition of a resumed run
- AC3: An outcome reports gates from its own attempt only; checks that passed in an earlier attempt are not carried into a later outcome.
  - Test: packages/engine/tests/outcomes.test.ts :: never carries an earlier attempt's passed checks into a later outcome
- AC4: An outcome links the memories present in the context the run's workers received, and records the security gate.
  - Test: packages/engine/tests/outcomes.test.ts :: links the memories present in the run's context
  - Test: packages/engine/tests/execution.test.ts :: records the security gate in each run's outcome
- AC5: A person can accept or reject a result once, and only a succeeded result; a decision recorded from another process while the run finishes is never reverted to pending. Only a run whose publication succeeded carries a pending acceptance: a run that fails, is cancelled or needs reconciliation after its checks passed records no completion awaiting a person. That includes a run whose process dies after publication while it captures the run's memory: the pending acceptance is saved only with the succeeded status, and recovery drops one that an older engine saved earlier from the run it records as needing reconciliation.
  - Test: packages/engine/tests/outcomes.test.ts :: records a person's acceptance once, only for a succeeded result
  - Test: packages/engine/tests/outcomes.test.ts :: never reverts a person's decision recorded while the run finishes
  - Test: packages/engine/tests/execution.test.ts :: records a pending acceptance only on a run whose publication succeeded
  - Test: packages/engine/tests/execution.test.ts :: leaves no pending acceptance on a run whose process dies while it captures memory after publication
  - Test: packages/engine/tests/ledger.test.ts :: drops a pending acceptance from a run it records as needing reconciliation
- AC6: A rejection's note becomes a proposed, private memory that needs a second human decision to take effect.
  - Test: packages/engine/tests/outcomes.test.ts :: turns a rejection's note into a proposed memory
- AC7: If a worker's patch changes a file the required checks load as configuration (the project's test runner config or test script entries, including scripts they reach through `npm run`, `pnpm` or `yarn` (also in another workspace package, after value-taking options read per runner so `-w` takes a value for npm but not for pnpm, inside quoted commands such as `concurrently "npm run a"` or `sh -c`, and through `node --run`), and every script of a manifest whose invocation cannot be resolved, and scripts reached through `run-s`, `run-p`, `npm-run-all` or `concurrently "npm:x"` (a pattern, a variable or an option that cannot be resolved counts as unresolved), and the package-manager rc files `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `.pnpmfile.cjs`, `pnpm-workspace.yaml`, `jest-preset.*`, `.coveragerc` and `.c8rc*`, and the pytest and coverage sections of `pyproject.toml` (`tool.pytest`, `tool.coverage`) and `setup.cfg` (`coverage:*`) however their keys are spelled (leading whitespace in `setup.cfg` lines is significant, as a continuation line, for the comparison), and the Maven and Gradle build files `pom.xml`, `mvnw`, `gradlew`, `gradle.properties`, `*.gradle[.kts]`, `.mvn/`, `buildSrc/` and `gradle/wrapper/`, gated whole without parsing), then the system shall refuse the patch and return it as feedback unless a person approved that path in `policy.approvedVerificationConfigPaths`.
  - Test: packages/engine/tests/verification-config-gate.test.ts :: refuses a patch that edits the test runner config
  - Test: packages/engine/tests/verification-config-gate.test.ts :: refuses a patch that edits a test script entry
  - Test: packages/engine/tests/verification-config-gate.test.ts :: refuses an edit to a script a test or check script runs
  - Test: packages/engine/tests/verification-config-gate.test.ts :: decodes escapes in double-quoted keys
  - Test: packages/engine/tests/verification-config-gate.test.ts :: sees inline tables at any depth
  - Test: packages/engine/tests/verification-config-gate.test.ts :: follows npm run, pnpm and yarn with option flags before the script
  - Test: packages/engine/tests/verification-config-gate.test.ts :: refuses a weakened script in a workspace a root test script delegates to
  - Test: packages/engine/tests/verification-config-gate.test.ts :: resolves the script after value-taking options, else gates every script
  - Test: packages/engine/tests/verification-config-gate.test.ts :: reads a setup.cfg section header with a semicolon comment
  - Test: packages/engine/tests/verification-config-gate.test.ts :: gates jest-preset, coverage rc, c8 rc and pnpm-workspace files by name
  - Test: packages/engine/tests/verification-config-gate.test.ts :: gates Maven and Gradle build files whole, without reading them
  - Test: packages/engine/tests/verification-config-gate.test.ts :: refuses a pom.xml edit with the approval message unless approved
  - Test: packages/engine/tests/verification-config-gate.test.ts :: gates tool.coverage in pyproject.toml, however spelled
  - Test: packages/engine/tests/verification-config-gate.test.ts :: gates coverage sections in setup.cfg, however the header is spelled
  - Test: packages/engine/tests/verification-config-gate.test.ts :: follows scripts reached through run-s, npm-run-all and concurrently npm:x
  - Test: packages/engine/tests/verification-config-gate.test.ts :: accepts a source-only patch and a non-test package.json edit
  - Test: packages/engine/tests/verification-config-gate.test.ts :: accepts a path a person approved in the policy
- AC8: When a `pyproject.toml` or `setup.cfg` patch only respells the pytest settings (table headers, dotted keys, inline tables, header spacing, comments, key order, line endings), the system shall not count it as a verification-configuration change, and any change to a value under `tool.pytest` shall be refused.
  - Test: packages/engine/tests/verification-config-gate.test.ts :: reads a table header and an inline table as the same settings
  - Test: packages/engine/tests/verification-config-gate.test.ts :: sees an added entry of an array of tables, even an empty one
  - Test: packages/engine/tests/verification-config-gate.test.ts :: reads a setup.cfg pytest header the same however it is spaced
  - Test: packages/engine/tests/property-verification-config.test.ts :: reads every spelling of the same settings as the same settings
  - Test: packages/engine/tests/property-verification-config.test.ts :: sees any changed, added or removed setting under tool.pytest, in any spelling
  - Test: packages/engine/tests/property-verification-config.test.ts :: ignores line endings, padding and header spacing

## Security considerations

Acceptance is a person's decision, offered only on the command line and never over MCP, because a connected AI client accepting its own run would be approving its own work. The acceptance is bound to the verified snapshot and commit. Outcomes stay local and are not exposed over MCP. Engine-recorded outcomes and acceptances are self-produced, so they must never count as evidence for promoting a decision provider. A rejection note becomes only a proposed memory, so a lesson cannot enter mandatory context without a second human decision.

## Non-goals

Outcomes are recorded facts, not judgments: they change no score, weight or decision baseline. Acceptance is a person's command-line decision, never offered over MCP (the dashboard shows the command), and runs finished before the feature have no outcomes.
