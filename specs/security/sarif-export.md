# SARIF export of security findings

- ID: sarif-export
- Status: implemented
- Area: security

## Problem

Security findings are only available in Agile Graph's own JSON. Code hosts, editors and other
review tools read SARIF 2.1.0, the standard static-analysis format. Teams using any AI client or CI
system should be able to load Agile Graph's findings without a custom converter.

## Acceptance criteria

- AC1: A new pure function `toSarif(findings, version)` in `packages/engine/src/security/sarif.ts` returns a SARIF 2.1.0 log object with `version: "2.1.0"` and `$schema` `https://json.schemastore.org/sarif-2.1.0.json`, exactly one run whose `tool.driver` has `name: "agile-graph"` and the given `version`, one rule per distinct finding `tool` and `rule` pair with id `"<tool>/<rule>"` in first-seen order, and one result per finding with `ruleId` `"<tool>/<rule>"`, `level: "warning"` and `message.text` set to the finding's message.
  - Test: packages/engine/tests/security-sarif.test.ts :: writes one run with a rule per tool and rule pair and a warning per finding
- AC2: Each result has one location whose `physicalLocation.artifactLocation.uri` is the finding's repository-relative path with forward slashes and each segment percent-encoded (spaces, `#`, `%` and non-ASCII characters included), with `uriBaseId` `%SRCROOT%`, whose `region.startLine` is set only when the finding's line is a positive integer, and each result's `partialFingerprints` has the key `"graphEngineering/v1"` set to the finding's fingerprint; an empty findings list gives a run with an empty `results` array.
  - Test: packages/engine/tests/security-sarif.test.ts :: locates each result by repository-relative path, a positive line and the finding's fingerprint
  - Test: packages/engine/tests/security-sarif.test.ts :: percent-encodes each path segment of a result's URI and keeps the separators
- AC3: `graph-engine security-scan --sarif <file>` also writes every finding of the scan to `<file>` as SARIF, with tool-quoted text redacted as for display and each result's `baselineState` set to `new` or `unchanged` against the reviewed baseline.
  - Test: packages/engine/tests/security-sarif.test.ts :: redacts a scan's findings and marks each new or unchanged against the baseline
  - Test: packages/engine/tests/cli.test.ts :: writes the scan's redacted findings, their baseline state and an incomplete scan's errors as SARIF
- AC4: The run has one invocation whose `executionSuccessful` is false when the scan reported errors or unscanned files, with a `toolExecutionNotifications` entry for each: level `error` with the redacted error text, and level `warning` naming each unscanned path and its reason, located at that path. A complete scan's invocation is `{ executionSuccessful: true }`.
  - Test: packages/engine/tests/security-sarif.test.ts :: marks an incomplete scan's invocation unsuccessful with its redacted errors and unscanned files
  - Test: packages/engine/tests/cli.test.ts :: writes the scan's redacted findings, their baseline state and an incomplete scan's errors as SARIF

## Security considerations

The export holds only what the scan already reports: rule identifiers, repository-relative paths,
line numbers, fingerprints and messages that have already been redacted. It must not add file
contents, environment data or absolute paths.

## Non-goals

Importing SARIF from other tools, and SARIF for code-review findings, are separate work.
