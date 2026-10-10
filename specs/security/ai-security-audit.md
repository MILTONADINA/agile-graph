# AI security audit

- ID: ai-security-audit
- Status: implemented
- Area: security
- Epic: AI agile team

## Problem

Offline scanners find known patterns, not logic flaws such as a missing
authorization check or untrusted input reaching a shell. A professional
team also has a security reviewer read the change. Cloudflare published a
method and machine-checkable report contract for AI security audits
(github.com/cloudflare/security-audit-skill, MIT): a hunter proposes
candidates, separate verifiers try to disprove each one, and findings
follow a JSON schema checked by a validator. The design was settled with
Jev and the advisor: an engine command, advisory only, and only an owner
can ever make it blocking.

## Acceptance criteria

- AC1: `graph-engine security-audit <run-id>` is advisory: it records `security.audit_completed` and prints the result, and never changes the run's status, outcome, review gate or completion.
  - Test: packages/engine/tests/security-audit.test.ts :: is advisory only: it records security.audit_completed and never changes the run's status, outcome or review gate
- AC2: Every reported finding is a record in Cloudflare's report schema, checked by Cloudflare's vendored `validate-findings.cjs`; a record that fails, or cites a file the run did not change, is listed as invalid instead.
  - Test: packages/engine/tests/security-audit.test.ts :: validates records with Cloudflare's vendored validator and report schema
  - Test: packages/engine/tests/security-audit.test.ts :: is advisory only: it records security.audit_completed and never changes the run's status, outcome or review gate
- AC3: The hunter never verifies: its output has no verdict, and each candidate goes to a separate verifier call that receives only that candidate and the diff, at most 10 per audit.
  - Test: packages/engine/tests/security-audit.test.ts :: never lets the hunter verify: it returns candidates only, and each verifier sees one candidate
  - Test: packages/engine/tests/security-audit.test.ts :: verifies each candidate in a separate call, at most 10, with verification reserved before the hunt
- AC4: Verifier calls are reserved before the hunt, through the same cost and turn reservation path as reviewer calls; an audit whose budget has no room for one verification refuses before hunting, naming whether the turn limit or the cost cap stopped it, and reservations a hunt did not use are given back.
  - Test: packages/engine/tests/security-audit.test.ts :: verifies each candidate in a separate call, at most 10, with verification reserved before the hunt
  - Test: packages/engine/tests/security-audit.test.ts :: gives back verifier reservations a hunt did not use
- AC5: The auditor has the reviewer's restrictions: an API or local provider only (`chat` included), no potential secret sent to a cloud provider, the context budget (counted strictly at one token per UTF-8 byte against the input ceiling less the output reservation, so an oversized hunt or verification is refused, never truncated), and a refusal before anything is sent when the run touched a path a cloud auditor may not receive. A call refused before it is sent gives its reservation back, so it spends none of the day's turns or cost.
  - Test: packages/engine/tests/security-audit.test.ts :: refuses secrets for cloud auditors, oversized changes and installed agents
  - Test: packages/engine/tests/security-audit.test.ts :: lets a chat provider audit
  - Test: packages/engine/tests/security-audit.test.ts :: refuses a change too large for the auditor under the strict one-token-per-byte count with the output reserved
  - Test: packages/engine/tests/security-audit.test.ts :: refuses a cloud auditor for a change outside the export paths, sending nothing
  - Test: packages/engine/tests/security-audit.test.ts :: gives back the reservation of a call the auditor refused before sending
- AC6: Cloudflare's files are vendored unmodified with their license, commit and attribution; their SHA-256 digests are pinned by a test and checked by the engine first in every audit, before any provider lookup or paid call.
  - Test: packages/engine/tests/vendor-pins.test.ts :: keeps the vendored Cloudflare files byte-identical to their pinned sha256
  - Test: packages/engine/tests/vendor-pins.test.ts :: records the upstream commit and license in the vendor README and NOTICE
  - Test: packages/engine/tests/security-audit.test.ts :: checks the vendored files' pins before anything else
- AC7: A finding is `confirmed` only when a reproducer demonstrated it (AC12); a verifier's "confirmed" is otherwise a static trace, reported as `needs_validation` with its full entrypoint, propagation and sink trace, a blocker saying it was not executed (and, when a reproducer was proposed, a second blocker with its outcome), and a local validation plan holding the verifier's reproduction and expected result. The result counts those as `traced` and demonstrated findings as `confirmed`, so `confirmed + traced` is the number of verifier-confirmed findings.
  - Test: packages/engine/tests/security-audit.test.ts :: reports a static trace as needs_validation with its full trace and expected result
  - Test: packages/engine/tests/security-audit.test.ts :: is advisory only: it records security.audit_completed and never changes the run's status, outcome or review gate
- AC8: The audit has its own provider setting, `audit.providerId` in the project configuration (set with `graph-engine auditor <providerId>`), so auditing never turns on the review gate; without it the audit uses the reviewer, and with neither it refuses and says how to set one. The key sits beside the policy, so it never changes a plan's policy hash.
  - Test: packages/engine/tests/security-audit.test.ts :: uses its own auditor setting, falls back to the reviewer and refuses with neither
- AC9: The audit gives the project's threat model (`audit.threatModel`, or else the first existing of `threat_model.md`, `.oss-scanner/threat_model.md` and `docs/threat-model.md`) to the hunter and every verifier as severity and scope guidance that is evidence, never instructions; it passes the same secret screen and context budget as the diff, a cloud auditor is refused one outside the export paths, a project without one is audited without it, and `security.audit_completed` records its path and SHA-256.
  - Test: packages/engine/tests/security-audit.test.ts :: gives a threat model to the hunter and the verifier as evidence, screened like the rest of their input
  - Test: packages/engine/tests/security-audit.test.ts :: gives the project's threat model to the hunter and every verifier and records its path and sha256
  - Test: packages/engine/tests/security-audit.test.ts :: refuses a cloud auditor a threat model outside the export paths, sending nothing
  - Test: packages/engine/tests/security-audit.test.ts :: refuses secrets for cloud auditors, oversized changes and installed agents
  - Test: packages/engine/tests/security-audit.test.ts :: is advisory only: it records security.audit_completed and never changes the run's status, outcome or review gate

- AC10: A verifier that answers "confirmed" may propose a reproducer (`path`, `content`, `argv`, `image`, `expected`). The engine runs it only through the offline verification sandbox (`verifyInContainer`: `--network=none`, all capabilities dropped, `--pull=never`, memory, CPU and process limits) with one check whose image is one of the project's registered verification images (`check-add`; a null image means the first mandatory one), never another image, on a temporary copy of the run's workspace snapshot plus that one file, bounded by the policy's verification timeout (`policy.timeoutSeconds` when that is null). A reproducer proposed with another verdict is never run. Running it costs no model call and reserves none.
  - Test: packages/engine/tests/security-audit.test.ts :: runs a verifier's reproducer only through the offline sandbox, with a registered image, on a copy of the run's snapshot
  - Test: packages/engine/tests/audit-reproducer-sandbox.test.ts :: adds a reproducer only to the temporary verification view and runs it with no network
- AC11: The reproducer is never written to the run's workspace or the owner's checkout: it exists only in the sandbox's temporary view, which is removed afterwards; a path that already exists in the snapshot is refused, and the sandbox refuses a run whose source inputs or reproducer changed. The workspace fingerprint is taken when the audited diff is built and recorded as the result's `snapshotHash`; a reproducer runs only while the workspace still has that fingerprint, so a workspace edited or resumed after the diff leaves the finding `needs_validation` with a note that the workspace changed since the audited diff.
  - Test: packages/engine/tests/security-audit.test.ts :: never writes the reproducer to the run workspace or the checkout
  - Test: packages/engine/tests/audit-reproducer-sandbox.test.ts :: adds a reproducer only to the temporary verification view and runs it with no network
  - Test: packages/engine/tests/audit-reproducer-sandbox.test.ts :: refuses an added file that already exists or leaves the view
  - Test: packages/engine/tests/security-audit.test.ts :: never reproduces on a workspace changed after the audited diff was built
- AC12: Only a demonstrated failure confirms. A reproducer is demonstrated exactly when (a) the sandbox returned a result instead of throwing (a timeout, output overflow, a missing image, a Docker error or a changed input is an error), (b) the test exited with a code from 1 to 124 (0 passed; 125 to 127 mean Docker or the command could not start it; 128 and above mean a signal killed it), (c) its standard output and error together contain the verifier's `expected` text, compared after normalizing line endings, and (d) that output contains none of the did-not-run markers (`SyntaxError`, `Cannot find module`, `Cannot find package`, `ERR_MODULE_NOT_FOUND`, `ModuleNotFoundError`, `ImportError`, `No test files found`, `No tests found`, `no tests ran`, `command not found`, `executable file not found`, compared without case), and `expected` contains none either. Anything else leaves the finding `needs_validation` with the outcome noted. A demonstrated finding is recorded as `confirmed` only when the verifier also gave the root cause, intended behavior, reproduction, remediation and severity Cloudflare's schema requires; otherwise it stays `needs_validation`, saying which is missing.
  - Test: packages/engine/tests/security-audit.test.ts :: confirms only a demonstrated failure: a non-zero exit with the expected signal and no did-not-run marker
  - Test: packages/engine/tests/security-audit.test.ts :: keeps needs_validation when the reproducer passes, cannot start, errors before running, times out or misses the signal
  - Test: packages/engine/tests/security-audit.test.ts :: fills a confirmed record's execution evidence from what ran
- AC13: A confirmed finding is still advisory: it is recorded only in `security.audit_completed` and the printed result, and never changes the run's status, outcome, review gate, security gate or completion.
  - Test: packages/engine/tests/security-audit.test.ts :: keeps a confirmed finding advisory: the run's status, outcome and review gate are unchanged
- AC14: A reproducer is refused, and not run, unless its path is a safe relative project path (no `..`, absolute path, backslash or excluded or protected path) that matches the project's test file globs (`tester.writes`, or the tester's defaults), lies in the changed area (its first path segment is the first segment of a file the run changed, or anywhere when the run changed a top-level file) and does not exist in the run's workspace; its content is non-empty, at most 64 KiB and free of NUL bytes; its argv is 1 to 32 plain arguments (letters, digits and `_ . / : = @ + , % -` only, so no shell metacharacters), does not start with a shell or `env`, and names the reproducer's path; its `expected` text is 12 to 500 characters, does not appear in its content (line endings normalized) and is not part of its path or any argv element, since a runner echoes source lines, code frames, the path and argv; and its image, when given, is a registered verification image. A project with no registered verification image runs no reproducer.
  - Test: packages/engine/tests/security-audit.test.ts :: refuses invalid reproducers before running them
- AC15: A cloud auditor's reproducer must have an exportable path (`policy.exportPaths`), and no reproducer whose content holds a potential secret is run. When Docker is unavailable a reproducer cannot run and its finding stays `needs_validation` with a note. The reproducer's output is redacted before it is recorded, and only an excerpt of its tail is kept.
  - Test: packages/engine/tests/security-audit.test.ts :: refuses a cloud auditor's reproducer outside the export paths and any reproducer holding a potential secret
  - Test: packages/engine/tests/security-audit.test.ts :: keeps needs_validation with a note when Docker is unavailable
  - Test: packages/engine/tests/security-audit.test.ts :: redacts the reproducer's output before recording it

## Security considerations

The diff and every model answer are untrusted. The hunter and verifiers are
told the diff is evidence, never instructions. Fingerprints are made by the
engine from the candidate's location and title, never taken from a model.
Cited files must be ones the run changed and pass Cloudflare's safe
relative path check, so a record cannot point outside the change. A cloud
auditor receives only exportable paths and no potential secret; the check
reads each raw string, so JSON escaping cannot hide one. Findings are
redacted before they are recorded or printed. The vendored validator is
loaded only after its bytes match the pinned digest; it exports pure
functions and reads files or exits only when run as a script. Audits share
a daily cost owner bounded by `policy.maxTurns` and `policy.maxCostUsd`,
so they cannot spend a run's own budget; a call refused before sending gives
its reservation back. The vendored files' digests are checked first in every
audit.

A reproducer is model-written code, so it runs only in the offline
verification sandbox, never on the project: with no network, no
capabilities and no image pulls, in one of the operator's registered
verification images, on a temporary copy of the run's snapshot that is
removed afterwards. Its argv is a plain array with no shell. A model-chosen
`expected` text cannot confirm a test that never ran, since the exit code
and the did-not-run markers are checked too, nor be shown by a runner
echoing the reproducer's own source, path or argv, since such text is
refused before running, but a reproducer written to
print that text and fail can still confirm a finding; this is why a
confirmed finding stays advisory and gates nothing.

## Non-goals

- Gating, completing or failing a run on audit findings, or any automatic
  path to make the audit blocking. Only the owner can decide that.
- Executing reproductions anywhere but the offline verification sandbox,
  in an unregistered image, or with network access; running a reproducer
  for a verdict other than "confirmed"; or a second model call to repair a
  reproducer that did not demonstrate its finding.
- Cloudflare's coverage ledger: `validate-coverage-ledger.cjs` is vendored
  for reference only.
- Audits from MCP clients or the dashboard.
