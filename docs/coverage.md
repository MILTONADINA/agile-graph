# Coverage measurement

Engine line coverage is measured with Vitest's v8 provider
(`@vitest/coverage-v8`, a root dev dependency kept at the same version as
`vitest`; the two must match).

```sh
npm run test:coverage -w @agile-graph/engine
node scripts/coverage-floor.mjs
```

The report covers `packages/engine/src` and is written to
`packages/engine/coverage/` (ignored by Git) as a text summary and
`coverage-summary.json`. `scripts/coverage-floor.mjs` fails when total line
coverage is below the whole percent in `scripts/coverage-floor.json`. The
Linux x64 platform job runs both after the build. The spec is
[coverage-floor](../specs/quality/coverage-floor.md).

## Ratchet

The floor is the measured value rounded down: 85.38% lines gives 85. It only
moves up, in the same change that raises coverage, and has no tolerance.
Branches and functions are reported but not gated.
