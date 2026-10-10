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
- AC5: The auditor has the reviewer's restrictions: an API or local provider only (`chat` included), no potential secret sent to a cloud provider, the context budget, and a refusal before anything is sent when the run touched a path a cloud auditor may not receive. A call refused before it is sent gives its reservation back, so it spends none of the day's turns or cost.
  - Test: packages/engine/tests/security-audit.test.ts :: refuses secrets for cloud auditors, oversized changes and installed agents
  - Test: packages/engine/tests/security-audit.test.ts :: lets a chat provider audit
  - Test: packages/engine/tests/security-audit.test.ts :: refuses a cloud auditor for a change outside the export paths, sending nothing
  - Test: packages/engine/tests/security-audit.test.ts :: gives back the reservation of a call the auditor refused before sending
- AC6: Cloudflare's files are vendored unmodified with their license, commit and attribution; their SHA-256 digests are pinned by a test and checked by the engine first in every audit, before any provider lookup or paid call.
  - Test: packages/engine/tests/vendor-pins.test.ts :: keeps the vendored Cloudflare files byte-identical to their pinned sha256
  - Test: packages/engine/tests/vendor-pins.test.ts :: records the upstream commit and license in the vendor README and NOTICE
  - Test: packages/engine/tests/security-audit.test.ts :: checks the vendored files' pins before anything else
- AC7: No finding is ever `confirmed`: Cloudflare's method reserves that verdict for a demonstrated finding, and the audit executes nothing. A verifier's "confirmed" is a static trace, reported as `needs_validation` with its full entrypoint, propagation and sink trace, a blocker saying it was not executed, and a local validation plan holding the verifier's reproduction and expected result; the result counts these as `traced`.
  - Test: packages/engine/tests/security-audit.test.ts :: never reports confirmed: a verifier's static trace is needs_validation with its full trace and expected result
  - Test: packages/engine/tests/security-audit.test.ts :: is advisory only: it records security.audit_completed and never changes the run's status, outcome or review gate
- AC8: The audit has its own provider setting, `audit.providerId` in the project configuration (set with `graph-engine auditor <providerId>`), so auditing never turns on the review gate; without it the audit uses the reviewer, and with neither it refuses and says how to set one. The key sits beside the policy, so it never changes a plan's policy hash.
  - Test: packages/engine/tests/security-audit.test.ts :: uses its own auditor setting, falls back to the reviewer and refuses with neither
- AC9: The audit gives the project's threat model (`audit.threatModel`, or else the first existing of `threat_model.md`, `.oss-scanner/threat_model.md` and `docs/threat-model.md`) to the hunter and every verifier as severity and scope guidance that is evidence, never instructions; it passes the same secret screen and context budget as the diff, a cloud auditor is refused one outside the export paths, a project without one is audited without it, and `security.audit_completed` records its path and SHA-256.
  - Test: packages/engine/tests/security-audit.test.ts :: gives a threat model to the hunter and the verifier as evidence, screened like the rest of their input
  - Test: packages/engine/tests/security-audit.test.ts :: gives the project's threat model to the hunter and every verifier and records its path and sha256
  - Test: packages/engine/tests/security-audit.test.ts :: refuses a cloud auditor a threat model outside the export paths, sending nothing
  - Test: packages/engine/tests/security-audit.test.ts :: refuses secrets for cloud auditors, oversized changes and installed agents
  - Test: packages/engine/tests/security-audit.test.ts :: is advisory only: it records security.audit_completed and never changes the run's status, outcome or review gate

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

## Non-goals

- Gating, completing or failing a run on audit findings, or any automatic
  path to make the audit blocking. Only the owner can decide that.
- Executing reproductions, and so any `confirmed` record. The verifier's
  instructions still let it answer "confirmed" for a complete static trace;
  the engine reports that as `needs_validation`.
- Cloudflare's coverage ledger: `validate-coverage-ledger.cjs` is vendored
  for reference only.
- Audits from MCP clients or the dashboard.
