# Draft pull request publication

- ID: publication
- Status: implemented
- Area: runs
- Epic: AI agile team

## Problem

A finished run can open a draft pull request for a person to review and merge.
The repository decides which branch the draft PR targets, and in a repository
whose only integration branch is `main` that target is `main`. Before #277 the
publisher refused `main` and `master` as a base, so this repository's only
integration branch could not be one. The draft PR's base must be configurable, its value
must never be read as a command-line option, and a run must still never push
to `main` or `master`.

## Acceptance criteria

- AC1: WHEN publication is `draft-pr` and `github.baseBranch` is a branch name, including `main` or `master`, the system shall open the draft pull request against that branch and push only the run's own branch. (#277)
  - Test: packages/engine/tests/publication-edges.test.ts :: opens a draft pull request against %s without pushing to it (#277)
- AC2: IF `github.baseBranch` is not a plain branch name (it uses a character outside letters, digits, `_`, `.`, `/` and `-`, starts with `-` or `refs/`, contains `..`, or has a `/`-separated part that is empty, starts with `.` or ends with `.lock`), THEN the system shall refuse before pushing or calling `gh`, and the refusal shall name `github.baseBranch` in `.graph/project.json`. (#277)
  - Test: packages/engine/tests/publication-edges.test.ts :: refuses the base branch %j and names the setting
- AC3: WHEN publication is `commit` or `draft-pr`, the system shall refuse to publish a run branch named `main` or `master`, or one that is not a plain branch name.
  - Test: packages/engine/tests/policy.test.ts :: prevents main/master publication even when publication is enabled
- AC4: IF publication is `draft-pr` and `github` is not configured, THEN the system shall refuse and name the `github` setting in `.graph/project.json`.
  - Test: packages/engine/tests/publication-edges.test.ts :: needs the GitHub repository configured

## Security considerations

The base branch comes from the project's configuration, which a cloned
repository can commit. It is passed to `gh pr create --base` as its own
argument and checked before any push or `gh` call, so it cannot add an option. A draft PR changes
nothing by itself: merging stays a person's action, and branch protection on
the target applies. Pushes go only to the run branch, through the push URL
checks that already apply to every publication.

## Non-goals

- Merging, marking a PR ready for review, or choosing reviewers.
- Checking that the base branch exists on the remote; `gh` reports that.
- Every name Git allows: `+`, `@` and `#` are refused here, as they are for run
  branches.
