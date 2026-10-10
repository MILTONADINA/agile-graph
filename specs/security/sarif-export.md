# SARIF export of security findings

- ID: sarif-export
- Status: implemented
- Area: security

## Problem

Security findings are only available in Graph Engineering's own JSON. Code hosts, editors and other
review tools read SARIF 2.1.0, the standard static-analysis format. Teams using any AI client or CI
system should be able to load Graph Engineering's findings without a custom converter.

## Acceptance criteria

- AC1: A new pure function `toSarif(findings, version)` in `packages/engine/src/security/sarif.ts` returns a SARIF 2.1.0 log object with `version: "2.1.0"` and `$schema` `https://json.schemastore.org/sarif-2.1.0.json`, exactly one run whose `tool.driver` has `name: "graph-engineering"` and the given `version`, one rule per distinct finding `tool` and `rule` pair with id `"<tool>/<rule>"` in first-seen order, and one result per finding with `ruleId` `"<tool>/<rule>"`, `level: "warning"` and `message.text` set to the finding's message.
  - Test: packages/engine/tests/security-sarif.test.ts :: writes one run with a rule per tool and rule pair and a warning per finding
- AC2: Each result has one location whose `physicalLocation.artifactLocation.uri` is the finding's repository-relative path with forward slashes, whose `region.startLine` is set only when the finding's line is a positive integer, and each result's `partialFingerprints` has the key `"graphEngineering/v1"` set to the finding's fingerprint; an empty findings list gives a run with an empty `results` array.
  - Test: packages/engine/tests/security-sarif.test.ts :: locates each result by repository-relative path, a positive line and the finding's fingerprint
- AC3: `graph-engineering security-scan --sarif <file>` also writes every finding of the scan to `<file>` as SARIF, with tool-quoted text redacted as for display and each result's `baselineState` set to `new` or `unchanged` against the reviewed baseline.
  - Test: packages/engine/tests/security-sarif.test.ts :: redacts a scan's findings and marks each new or unchanged against the baseline

## Security considerations

The export holds only what the scan already reports: rule identifiers, repository-relative paths,
line numbers, fingerprints and messages that have already been redacted. It must not add file
contents, environment data or absolute paths.

## Non-goals

Importing SARIF from other tools, and SARIF for code-review findings, are separate work.
