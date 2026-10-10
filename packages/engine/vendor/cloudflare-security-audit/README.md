# Cloudflare security-audit contracts (vendored)

Source: <https://github.com/cloudflare/security-audit-skill>, directory
`skills/security-audit/`, at commit
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`. License: MIT (`LICENSE`, copied
from the repository root at the same commit).

| File | Upstream path |
| --- | --- |
| `report-schema.json` | `skills/security-audit/report-schema.json` |
| `validate-findings.cjs` | `skills/security-audit/validate-findings.cjs` |
| `validate-coverage-ledger.cjs` | `skills/security-audit/validate-coverage-ledger.cjs` |
| `LICENSE` | `LICENSE` |

The files are unmodified. Their SHA-256 digests are pinned in
`packages/engine/tests/vendor-pins.test.ts` and checked again by
`packages/engine/src/security/audit.ts` before it uses them, so a byte
change fails the tests and refuses `graph-engine security-audit`.

`graph-engine security-audit` validates its findings with
`validateDocument` from `validate-findings.cjs` against `report-schema.json`.
`validate-coverage-ledger.cjs` is kept for reference only: the audit does
not produce a coverage ledger. Prettier and ESLint skip this directory so the
bytes stay as published.

To update, fetch the files at a new commit, replace them unmodified, and
update the commit above and the pinned digests.
