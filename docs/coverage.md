# Coverage measurement plan

Status: planned, not implemented. The engine has no coverage report today.

## Why nothing is wired up yet

Vitest's built-in v8 coverage needs the `@vitest/coverage-v8` package. In
`package-lock.json` it appears only as an optional peer dependency of
`vitest` (a version range, no resolved package entry), so it is not
installed. Adding a dependency changes the hash-pinned lockfile and is a
separate, owner-reviewed change, so this plan adds none.

## Plan once the dependency is approved

1. Add `@vitest/coverage-v8` as a dev dependency at the same version as
   `vitest` (they must match), in its own dependency PR.
2. Add `"coverage": "vitest run --coverage"` to `packages/engine/package.json`
   with the `v8` provider, a `json-summary` reporter and `src/**` included.
3. Record the first measured line and branch percentages in a committed JSON
   file (for example `docs/coverage-floor.json`). This is the ratchet floor.
4. Add a `scripts/` test that reads the summary and fails when line or branch
   coverage falls below the floor. The floor only moves up, in the same PR
   that raises coverage.
5. Run the report inside an existing CI job. Do not rename jobs: names are
   pinned by `scripts/branch-protection-policy.mjs`.

## Open choices

- Whether to gate on lines and branches only, or also functions.
- Whether the floor allows a small tolerance (suggested: none, to avoid drift).
