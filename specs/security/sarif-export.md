# SARIF export of security findings

- ID: sarif-export
- Status: ready
- Area: security

## Problem

Security findings are only available in Graph Engineering's own JSON. Code hosts, editors and other
review tools read SARIF 2.1.0, the standard static-analysis format. Teams using any AI client or CI
system should be able to load Graph Engineering's findings without a custom converter.

## Acceptance criteria

- AC1: A new pure function `toSarif(findings, version)` in `packages/engine/src/security/sarif.ts` returns a SARIF 2.1.0 log object with `version: "2.1.0"` and `$schema` `https://json.schemastore.org/sarif-2.1.0.json`, exactly one run whose `tool.driver` has `name: "graph-engineering"` and the given `version`, one rule per distinct finding `tool` and `rule` pair with id `"<tool>/<rule>"` in first-seen order, and one result per finding with `ruleId` `"<tool>/<rule>"`, `level: "warning"` and `message.text` set to the finding's message.
- AC2: Each result has one location whose `physicalLocation.artifactLocation.uri` is the finding's repository-relative path with forward slashes, whose `region.startLine` is set only when the finding's line is a positive integer, and each result's `partialFingerprints` has the key `"graphEngineering/v1"` set to the finding's fingerprint; an empty findings list gives a run with an empty `results` array.
- AC3: `graph-engineering security-scan --sarif <file>` writes the SARIF for the scan's findings to `<file>` as JSON with two-space indentation, in addition to its normal output.

## Security considerations

The export holds only what the scan already reports: rule identifiers, repository-relative paths,
line numbers, fingerprints and messages that have already been redacted. It must not add file
contents, environment data or absolute paths.

## Non-goals

Importing SARIF from other tools, and SARIF for code-review findings, are separate work.
