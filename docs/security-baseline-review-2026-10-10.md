# Security baseline review, 2026-10-10

> **Update, 2026-10-11:** the app generator, template kit and reference app
> were removed from the repository, together with the engine's template
> runtime and the evaluation replays of that code. The 49 baseline entries for
> the removed files and code went with them, taking the baseline from 259 to
> 210 entries. No entry was added and no other entry changed.

The committed baseline (`.graph/security-baseline.json`, last updated
2026-09-27) was missing 66 findings from a full `security-scan`. The owner
approved triaging all 66: review each finding, fix any real issue and accept
only the reviewed false positives, each listed here with its reason. The
agent-config hook finding was accepted on the owner's explicit approval.

## Outcome

| Result                                       | Count |
| -------------------------------------------- | ----: |
| Findings missing from the baseline           |    66 |
| Findings that disappeared after the fixes    |     4 |
| False positives accepted into the baseline   |    62 |
| True positives fixed (see below)             |     5 |
| Files semgrep could not fully parse (listed) |    15 |

The fixed ReDoS regular expression is used at two sites that semgrep still
flags after the fix, so those two sites are among the 62 accepted findings as
post-fix false positives. The other three fixes removed their findings.

## True positives fixed

| Tool     | Rule              | Location                                                      | Fix                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| semgrep  | detect-redos      | `packages/engine/src/context/dart-snapshot.ts` (`sourcePath`) | `_` and `-` were both name characters and file-name separators, so a portable repository file name such as `lib/a_a_..._a..dart` backtracked exponentially (about 11 s for 30 parts) before being refused. Only `.` now separates file-name parts; the accepted paths are unchanged (2.1 million generated paths compared). A regression test bounds the refusal time. |
| semgrep  | gcm-no-tag-length | `scripts/promotion-key.mjs`                                   | The backup envelope's AES-256-GCM cipher and decipher now state `authTagLength: 16`, the full 128-bit tag. The envelope parser already refused a tag that is not 16 bytes, so this hardens the requirement at the cipher itself.                                                                                                                                       |
| semgrep  | gcm-no-tag-length | `scripts/promotion-key.test.mjs`                              | The test's independent decipher also states `authTagLength: 16`.                                                                                                                                                                                                                                                                                                       |
| gitleaks | generic-api-key   | `packages/engine/tests/managed-dag-safety.test.ts`            | The synthetic API-key-shaped fixture is built by concatenation, so the source holds no credential shape.                                                                                                                                                                                                                                                               |
| gitleaks | generic-api-key   | `packages/engine/tests/security-scan-redaction.test.ts`       | The synthetic PKCS8 body is renamed and built by concatenation, so the source holds no credential shape.                                                                                                                                                                                                                                                               |

The two gitleaks fixtures were synthetic and never credentials; they are
listed here because they were changed rather than accepted.

## Accepted false positives

Line numbers are those of the scan that wrote the baseline.

### gitleaks

| Rule               | Location                                          | Reason                                                                                                                         |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| cloudflare-api-key | `packages/engine/src/security/audit.ts:36`        | The vendored audit repository's Git commit SHA, a public 40-character hex identifier pinned for the vendored files, not a key. |
| generic-api-key    | `specs/providers/installed-worker-identity.md:64` | Acceptance-criterion prose in a spec; the keyword-plus-word heuristic matched an English sentence, not a value.                |

### semgrep `html-in-template-string` (22)

Every one is CLI help, an error message or a test expectation containing
`<placeholder>` tokens such as `<path>` or `<id>`. The text goes to stderr,
stdout or a JSON response. The engine server sends JSON with `nosniff`, the
dashboard renders through React's escaping, and the repository has no
`innerHTML`, `dangerouslySetInnerHTML` or `text/html` response sink.

| Location                                               | Reason                                         |
| ------------------------------------------------------ | ---------------------------------------------- |
| `packages/engine/src/cli.ts:939`                       | Reviewer-role error printed to stderr.         |
| `packages/engine/src/cli.ts:943`                       | Auditor-role error printed to stderr.          |
| `packages/engine/src/cli.ts:1034`                      | `--writes` usage error.                        |
| `packages/engine/src/cli.ts:1618`                      | Next-step text in CLI JSON output.             |
| `packages/engine/src/context/index.ts:213`             | Source-citation format error.                  |
| `packages/engine/src/context/index.ts:1203`            | Context warning text in JSON.                  |
| `packages/engine/src/context/index.ts:1568`            | Line-range error.                              |
| `packages/engine/src/context/index.ts:1742`            | Memory-export refusal text.                    |
| `packages/engine/src/context/index.ts:1883`            | Memory-expiry error.                           |
| `packages/engine/src/policy.ts:791`                    | Mandatory-memory export refusal text.          |
| `packages/engine/src/policy.ts:806`                    | Mandatory-memory export refusal text.          |
| `packages/engine/src/project.ts:28`                    | Missing-project error.                         |
| `packages/engine/src/service.ts:1911`                  | Missing verification image error.              |
| `packages/engine/src/service.ts:1981`                  | OSV database warning text.                     |
| `packages/engine/tests/cli.test.ts:1750`               | Test expectation of the missing-project error. |
| `packages/engine/tests/mcp.test.ts:698`                | Test expectation of a context warning.         |
| `packages/engine/tests/memory-export-flow.test.ts:144` | Test expectation of refusal text.              |
| `packages/engine/tests/memory-export-flow.test.ts:310` | Test expectation of refusal text.              |
| `packages/engine/tests/policy-export.test.ts:279`      | Test expectation of refusal text.              |
| `scripts/promotion-key.mjs:67`                         | CLI usage text.                                |
| `scripts/promotion-key.mjs:954`                        | Terminal note after storing a key.             |
| `scripts/promotion-key.test.mjs:152`                   | Test regular expression over usage text.       |

### semgrep `mcp-ssrf-typescript` (18)

`packages/engine/src/mcp.ts` lines 245, 246, 297, 304, 374, 380 (two), 381,
382, 384 (two), 385, 386, 479, 483, 484, 554 and 555. These are MCP tool
handlers that call local engine methods (memory proposal, plan creation, run
start, status, events and cancel). No tool's argument schema has a URL field,
`mcp.ts` makes no outbound request, and provider endpoints come only from
project configuration. Most of these are the re-fingerprinted successors of
13 accepted entries that went stale when `mcp.ts` changed after 2026-09-27.

### semgrep `detect-redos` (7)

Each expression was timed with adversarial input of up to 20,000 characters
and stays linear (under 15 ms).

| Location                                           | Reason                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/context/dart-snapshot.ts:143` | `portablePath`: segments split by `/`, which the segment class excludes; unambiguous and measured linear.                        |
| `packages/engine/src/context/dart-snapshot.ts:147` | The rewritten `sourcePath` (fixed above); semgrep still flags the nested-quantifier shape, but it is now unambiguous and linear. |
| `packages/engine/src/context/dart-snapshot.ts:155` | The same rewritten `sourcePath`.                                                                                                 |
| `packages/engine/src/policy.ts:334`                | Code-value test: anchored, and its member separators are not word characters; measured linear.                                   |
| `packages/engine/src/policy.ts:348`                | Own-line prefix test over at most 256 characters; `[\w-]+\.` repetitions are unambiguous.                                        |
| `packages/engine/src/policy.ts:363`                | `keyPath`: separators are not in the segment class; measured linear.                                                             |
| `packages/engine/src/security/files.ts:23`         | Agent settings file name: `(\.[a-z0-9_-]+)*` is unambiguous; measured linear.                                                    |

### semgrep `detect-non-literal-regexp` (6)

| Location                                                                     | Reason                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/engine/src/specs.ts:290`                                           | The test name is escaped for every regular-expression metacharacter before it is interpolated.   |
| `packages/engine/tests/cli.test.ts:2491`                                     | Test assertion built from a container name the test generated.                                   |
| `packages/engine/tests/cli.test.ts:2492`                                     | Test assertion built from a container name the test generated.                                   |
| `packages/engine/tests/verification-selection.test.ts:69`                    | Test assertion built from a fixed word in the test table.                                        |
| `packages/engine/vendor/cloudflare-security-audit/validate-findings.cjs:321` | Vendored validator, pinned byte-identical by `vendor-pins.test.ts`; schema patterns are its own. |
| `packages/engine/vendor/cloudflare-security-audit/validate-findings.cjs:451` | Vendored validator, pinned byte-identical; schema patterns are its own.                          |

### semgrep `detect-non-literal-fs-filename` (5)

`packages/engine/vendor/cloudflare-security-audit/validate-findings.cjs`
lines 598, 613, 621, 633 and 647. The vendored validator reads its schema and
the findings file it is given, opening it read-only without following
symbolic links. The vendored files must stay byte-identical
(`vendor-pins.test.ts`), so they are accepted as they are.

### hadolint

| Rule   | Location                                                   | Reason                                                                                                      |
| ------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| DL3029 | `packages/engine/tests/fixtures/dart-runtime/Dockerfile:5` | The test fixture pins `--platform=linux/amd64` on purpose: the Dart analyzer image is built for amd64 only. |

### agent-config

| Rule         | Location                  | Reason                                                                                                                            |
| ------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| hook-command | `.claude/settings.json:9` | The project's PostToolUse hook runs the repository's own Prettier on files it formats; accepted on the owner's explicit approval. |

## Baseline entries removed

`security-scan --update-baseline` rebuilds the baseline from the current scan
instead of merging into it, so an entry whose fingerprint matches no current
finding is dropped. This update removed 14 such stale entries: 13
`mcp-ssrf-typescript` entries in `packages/engine/src/mcp.ts` and one
`detect-non-literal-regexp` entry in `packages/engine/src/specs.ts`. The code
they described changed after 2026-09-27, and their current findings were
reviewed above under new fingerprints. No current finding lost its
acceptance. The update added exactly the 62 reviewed fingerprints and nothing
else, taking the baseline from 211 to 259 entries.

## Files semgrep could not fully scan

semgrep reported `PartialParsing` for 15 files, so parts of them were not
analysed. Five of them were in the template kit removed on 2026-10-11; these
are the ten that remain. A baseline does not cover an unscanned file. The run gate
fails only when a run's worker writes one of them, and a person must then
review that file.

- `packages/dashboard/src/ContextPage.test.tsx`
- `packages/engine/tests/context-dart-runtime.test.ts`
- `packages/engine/tests/context-python.test.ts`
- `packages/engine/tests/context-rust.test.ts`
- `packages/engine/tests/installed-identity.test.ts`
- `packages/engine/tests/installed.test.ts`
- `packages/engine/tests/security-agent-config.test.ts`
- `packages/engine/tests/security-audit.test.ts`
- `packages/engine/tests/security-osv-argv.test.ts`
- `packages/engine/tests/security-scan-redaction.test.ts`
