# Retro round 010: readiness push and the 0.7.0 release

- Date: 2026-11-08
- Change this round: the stories came from the readiness plan. Its items are
  clean-machine installs, an uninstall that cleans up, closing the open
  feedback issues, and a clean release review. They were stacked so CI ran
  once per stack.

## Where the numbers come from

- **Repository delivery:** the pull requests merged into `main` on
  2026-11-08 (`gh pr list --state merged`), and the release workflow run for
  `v0.7.0`.

## What shipped

| Merge | Stories                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------- |
| #359  | the improvement loop and the report (#146, #163, #164)                                                                      |
| #363  | the Node version gate and usage name, README Try it and Uninstall, the notice once, `.graph` not indexed (#355, #356, #357) |
| #366  | release 0.7.0                                                                                                               |

`@agile-graph/engine` and `@agile-graph/contracts` 0.7.0 are published as
`latest` with SLSA v1 provenance. Issues #146, #163, #164, #211, #355, #356
and #357 are closed. Follow-ups #364, #365 and #367 are filed.

## What was slow

- **The registry lag after publish.** The engine returned 404 for about three
  minutes after the publish job succeeded. The check after a publish has to wait for the version to appear, not run once.
- **A stack rebase replayed old commits.** Rebasing a stack onto a new `main`
  needs `git rebase --onto <new> <old-tip>`, or commits that were already
  merged come back.
- **A usage-name change broke the README check.** The quickstart checker
  matched one command name. It now accepts both names.

## What to keep

- One CI run per stack, merged from the top.
- A different model reviews every story, with a re-review until it answers
  NONE.

## What to change

- Run the automated reviewer on story pull requests before the release pull
  request, so a finding does not open a second fix cycle on the release.
