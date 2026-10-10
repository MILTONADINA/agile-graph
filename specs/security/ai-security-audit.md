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
- AC4: Verifier calls are reserved before the hunt, through the same cost and turn reservation path as reviewer calls; an audit whose budget has no room for one verification refuses before hunting, and reservations a hunt did not use are given back.
  - Test: packages/engine/tests/security-audit.test.ts :: verifies each candidate in a separate call, at most 10, with verification reserved before the hunt
  - Test: packages/engine/tests/security-audit.test.ts :: gives back verifier reservations a hunt did not use
- AC5: The auditor has the reviewer's restrictions: an API or local provider only, no potential secret sent to a cloud provider, the context budget, and a refusal before anything is sent when the run touched a path a cloud auditor may not receive.
  - Test: packages/engine/tests/security-audit.test.ts :: refuses secrets for cloud auditors, oversized changes and installed agents
  - Test: packages/engine/tests/security-audit.test.ts :: refuses a cloud auditor for a change outside the export paths, sending nothing
- AC6: Cloudflare's files are vendored unmodified with their license, commit and attribution; their SHA-256 digests are pinned by a test and checked by the engine before use.
  - Test: packages/engine/tests/vendor-pins.test.ts :: keeps the vendored Cloudflare files byte-identical to their pinned sha256
  - Test: packages/engine/tests/vendor-pins.test.ts :: records the upstream commit and license in the vendor README and NOTICE

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
so they cannot spend a run's own budget.

## Non-goals

- Gating, completing or failing a run on audit findings, or any automatic
  path to make the audit blocking. Only the owner can decide that.
- Executing reproductions. A `confirmed` record is confirmed statically and
  says so in its observed result.
- Cloudflare's coverage ledger: `validate-coverage-ledger.cjs` is vendored
  for reference only.
- Audits from MCP clients or the dashboard.
