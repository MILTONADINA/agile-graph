# Working together

`main` is the default and only integration branch. Work on focused feature branches and open pull requests against `main`; never push directly to `main`, `master`, or the retired `dev`.

The project lives at `MILTONADINA/agile-graph` (the `origin` remote) and
is led by its owner. Push feature branches to `origin` and merge reviewed,
green PRs into `main`. Under the owner's current authorization, the working
agent may author-review the actual diff and exact-tip CI, then merge those PRs
under the zero-approval `main` rule. That author review is not independent
approval or human acceptance.

```sh
npm run setup:git -- --push-remote origin
git fetch origin
git push -u origin HEAD
```

The optional push-remote guard rejects a push to any other URL, even if that
remote is specified explicitly. It does not change fetch configuration or
rewrite history.

```sh
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c feat/short-description
npm run setup:git
```

Run `npm ci` only when dependencies are absent or changed; do not repeat an
unchanged install merely because a new branch was created.

Make small, coherent commits with descriptive subjects such as `feat(context): index repository symbols` or `fix(runtime): retain failed verification evidence`. Use your own configured Git identity. Do not add AI co-author trailers or generated attribution footers.

Work is spec-driven. A new feature starts as a spec under `specs/<area>/`
(`graph-engine spec-new`, see [specs/README.md](specs/README.md)) with its
problem, acceptance criteria, security considerations and non-goals, agreed
before it is built. A change to an existing feature updates its spec. Before a
feature is marked `implemented`, every acceptance criterion links the tests
that prove it; `graph-engine spec-check` enforces this in CI.

Before a code pull request, inspect the relevant source and prove a changed
failure path with focused checks before running `npm run check` or other broad
subsystem checks when warranted. A docs-only change needs proportionate
formatting and link checks, not a repeat of an unchanged green engine suite.
`npm run preflight` runs the cheap CI steps a change can fail, chosen from the
files it changed (the format check, lint, typecheck, the related engine and
script tests, and `spec-check` when specs or tests changed), so a rejection
costs minutes locally instead of a CI cycle. CI still runs everything.
A test that passes and fails on the same commit follows the
[flaky-test policy](docs/flaky-tests.md).
The PR describes the final behavior, migration effects, and verification
actually performed. The working agent reviews the diff and exact-tip CI
results before integration into `main`; the owner may review as well.
Prefer squash merging a single-purpose PR; retain separate commits when they
are independently meaningful. Do not force-push shared `main` history.

Root workspaces are the shared contracts, the engine and the dashboard, under `packages/`.

The pre-push hook rejects direct pushes to `main`, `master`, and `dev`; it is a local safeguard, not a replacement for GitHub branch protections. The repository's protection setup requires eight checks and zero approvals on `main`. It preflights both live rules, sends no update when they already match, and preserves existing app-bound status checks in any required update. It stops if an update would discard a required check or stronger restriction, or would need to reinterpret an unbound (`app_id: null`) check; review that case manually. Repository administrators should keep passing checks and the owner-selected review workflow on `main` and protect it from direct pushes.

The repository CODEOWNERS file names the owner. Do not approve your own work through another account or present automated review as human approval. Keep a PR in draft while required checks or implementation work remain. Branch protection changes require the repository owner's administration access.

Share durable knowledge through reviewed `.graph/knowledge` changes. Keep personal provider configuration, credentials, sessions, databases, and model files outside Git.
