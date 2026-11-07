# Retro round 008: 0.5.2 and 0.6.0 published, advisories closed, dependency triage

- Date: 2026-11-07
- Change this round: the owner's held releases went out first. The rest of
  the round cleared dependency alerts and Dependabot pull requests in both
  products, and closed the advisories the releases fixed.

## Where the numbers come from

- **Repository delivery:** the pull requests merged into `main` on
  2026-11-07 after the round 007 retro (`git log origin/main`), the release
  runs for `v0.5.2` and `v0.6.0`, and `npm view` for each published version.

## What shipped

| Merge | Stories                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------- |
| #347  | `@fastify/static` and `@hono/node-server` move past the glob, minimatch and serveStatic alerts |
| #340  | every free-text MCP tool input is bounded, and SQLite text stays out of errors                 |
| #348  | a managed draft PR may target `main`; invalid base branch names are refused                    |
| #349  | release 0.6.0                                                                                  |
| #337  | `actions/download-artifact` 8.0.2 and `actions/setup-python` 7.1.0                             |

- `@agile-graph/engine` and `@agile-graph/contracts` 0.5.2 and 0.6.0 are on
  npm with SLSA provenance, and `npx @agile-graph/engine@0.6.0 --version`
  runs.
- GHSA-8v9m and GHSA-rm9j are published with their patched versions.
- Issue #326 (dependency alerts) has a triage comment: each remaining alert
  is in the evaluation sandbox, a dev-only tool or the local Laya sidecar,
  with a recommendation for each.

## What was slow

- **An outside service during publish.** The 0.5.2 publish failed on a Rekor
  (Sigstore transparency log) server error. The job was re-run once Rekor
  answered steadily for ten minutes.
- **Merges in a row make the next pull request stale.** `main` requires
  branches to be up to date, so each merge forced a rebase and a fresh CI run
  of about 25 minutes on the next one.
- **A long compatibility job.** #337 waited about 40 minutes on the Node
  22.18 run of the `platform` job, then passed.

## What review by a second model found

- In #348, the first base-branch check accepted empty, dot-led and `.lock`
  path parts. It now refuses each one, with a test per case.
- In #337, the `download-artifact` v8 notes were read against
  `release.yml`. A digest mismatch now fails the publish job instead of
  warning. The direct-download change does not apply, because the tarballs
  are uploaded zipped.

## Hypotheses for the next rounds

1. **Dry-run the exact publish command (round 007): partly confirmed.** The
   0.5.2 and 0.6.0 publishes both ran the fixed command. A local
   `--dry-run` step is still not part of a release-path change.
2. **Read every major release note against the workflows that use it
   (new).** In the DevOPs actions update, checkout v6 and later link a
   persisted token through an `includeIf` in `.git/config`. A CI step that
   refuses unknown git configuration failed on it. Neither the release-note
   review nor the second model caught it before CI. Next change: search the
   workflows for steps that read `.git/config` or credentials before merging
   a checkout major.
3. **Changelog entries go under the right heading (new).** A scripted
   changelog edit inserted under the first `### Security` heading, which was
   a released version's section when Unreleased had none. Next change: a
   script that edits the changelog creates the subsection inside Unreleased
   instead of searching past it.
4. **One changelog fragment per story (round 004): not tried.**

## Deferred

- The Laya `torch` and `transformers` upgrade, which needs a model check the
  owner runs (#326).
- Dismissing or fixing the evaluation and dev-only alerts (#326), an owner
  decision.
- The release tag ruleset (#292) and the npm environment (#289).
- The Dependabot major updates for the dashboard toolchain (`vite` 8,
  `@vitejs/plugin-react` 6) and `@connectrpc/connect-node` 2, each its own
  story.
