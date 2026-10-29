# Code review

A professional team does not call work done because its author says so, or
because tests pass: another engineer reviews the change against what was
asked. Agile Graph can require the same of every managed run.

```sh
graph-engine reviewer <providerId>   # require this provider's approval
graph-engine reviewer                # show the current reviewer
graph-engine reviewer --clear        # stop requiring it
```

The reviewer is a configured API or local provider (installed agents cannot
review yet, and `graph-engine reviewer` warns as soon as it is given one),
preferably a different model from the one implementing the change. It is
recorded as `review.providerId` in `.graph/project.json`.

## A tester beside the reviewer

`graph-engine tester <providerId>` adds a `tester` step to every plan that
runs first, before the implementation: a separate worker writes tests that
prove each acceptance criterion. It creates new test files only, never
editing an existing test, within the test-file globs
(`graph-engine tester --writes <glob...>` narrows them for the configured
tester, so they must leave room for new files; to set a tester and its globs
together, put the provider ID first, `graph-engine tester <providerId>
--writes <glob...>`, since `--writes` takes every argument after it and a
provider ID there is refused), and implementing steps may
not change the files it wrote. The combined result is then verified and
reviewed ([tester spec](../specs/quality/tester-role.md)).

## What the reviewer sees and decides

Only after every required check passes, the reviewer receives the change as
a unified diff of every file the run's workers wrote (and nothing else, so
the operator's own uncommitted files are not reviewed as the worker's), the
plan's objective, its acceptance criteria and a summary of the checks that
ran. Each file is compared with the commit the run's workspace was created
from, which the engine records, so a run resumed after its publication
commit (for example after a failed push) is still reviewed in full, and its
security or architecture review scope still counts every file it changed.
The diff is built from raw bytes outside the repository: each
original comes from Git's object store with no conversion and each new file
straight from disk, compared in a scratch directory with no attributes, diff
drivers or configuration. A change cannot hide itself with `.gitattributes`
(`-diff`, `working-tree-encoding`, `eol`, `ident`) or a diff driver; if any
file cannot be shown, the review does not complete. It returns a
structured review ([`workers/review.ts`](../packages/engine/src/workers/review.ts)):

- one answer per acceptance criterion, in the plan's order, as met `yes`,
  `no` or `unknown`, with evidence (the engine keeps the criteria's wording);
- findings, each `blocking` or `advisory`;
- a verdict, `approve` or `request-changes`.

A change passes review only when the verdict is `approve`, every criterion
is answered and `yes`, and there are no blocking findings: an approval that
skips or could not confirm a criterion is not an approval. Otherwise the unmet criteria and
blocking findings become the next attempt's feedback, within
`policy.maxAttempts`, exactly as failed checks do; a run that still does not
pass fails with a message naming code review, never "checks failed".

Each finding gets an engine-assigned ID, `R` and the first 10 hex characters
of the SHA-256 of its path, line and whitespace-normalized message, recorded
with it and named in the feedback. A failing review's feedback also lists its
advisory findings, under a section marked optional; a passing review sends
nothing back.

When the project has a committed security baseline, the run's scan runs once
for the verified snapshot before the review, and the reviewer is given every
result in it (new, already in the baseline, and inline scanner suppressions)
as text with a stable ID. It must rule `raised` or `dropped`, with a reason,
on each ID and on no other; an omitted, unknown or repeated ID, or an empty
reason, fails the review as not completed, and a review has room for at most
100 results. The rulings are recorded in `review.completed`. A `dropped`
ruling is the reviewer's opinion only: the security gate still decides on the
scan and the baseline alone.

On a retry, when the run's latest AI review asked for changes with blocking
findings, the next review first checks each of them (at most 20; any more
count as inconclusive) in a fresh, separate call to the reviewer that carries
only that finding, the task and the current diff, and answers `fixed`,
`still_present` or `inconclusive` with evidence. These calls have the same
refusals, worker slots and cost reservations as a review, and each is
recorded as a `review.verify_fix` event. If any finding is not shown fixed,
the review fails without a full review: a failed `review.completed` (with
`stage: "verify-fix"`) lists the unfixed findings, which are what the next
retry checks, and the feedback names each by ID with its evidence. The full
review runs only once all are fixed, so the reviewer never confirms its own
finding inside a review looking for new ones. A person's approval of the
snapshot still stands in for all of this. Each fix check is a paid call, so
a retry with many findings can reach `maxCostUsd` sooner, and each counts
against the run's shared `policy.maxTurns`. The warning a new plan gets when
its model calls may exceed `maxTurns` counts three fix checks per repair
attempt with a reviewer (a review that holds a change back usually names a
handful of findings); a review with more spends more of the budget.

Each `review.verify_fix` event records the snapshot it judged. A review that
did not complete at a snapshot (a fix check or the full review failed) and is
resumed at that same snapshot keeps the findings already shown `fixed` there:
it records the verdict again with `reused: true` instead of paying for the
check. A verdict is never reused at another snapshot, and `still_present` or
`inconclusive` is always checked again.

### Repeated findings

Each blocking finding gets a signature: a short hash of its file path and its
text with case, numbers (line numbers included) and whitespace ignored, so the
same finding keeps its signature when the code moves. A failing review's
feedback lists the signatures and short texts of every finding raised so far
and tells the worker not to repeat the same fix. If the next rejection raises
a finding with the same signature, the run records `review.repeated_finding`
and stops with the `repeated-review-finding` kind instead of spending another
attempt on the same repair; change the approach (narrow the scope, make a
structural fix, or mark it blocked) before resuming. A stop is never an
acceptance. Each `review.completed` event records the round's `minutes`.

## Limits

- **A reviewer can only hold a change back.** It cannot accept a change,
  skip a check or the security gate, or stand in for human acceptance, which
  stays pending on every run.
- **Cloud reviewers get only exportable changes.** A diff touching a path
  outside `exportPaths`, or containing a potential secret, is not sent, and
  the review fails as not completed. A change touching a path outside
  `exportPaths` is recorded as `review.blocked` rather than
  `review.started`, since nothing reached the reviewer. In each case the
  run stopped at code review, so when its checks passed a person can
  [review it instead](#a-persons-review). A blocked review stays blocked
  on resume, since the run's reviewer and export policy are fixed, so a
  person's review is then the only way on. Cloud implementers get the
  review's details only when every changed path is exportable.
- **Reviews are paid calls.** They share the run's worker slots, turn budget
  and cost reservations, and a change too large for the reviewer's context
  budget fails the review rather than being truncated.
- A review that errors or returns output outside the schema fails the run as
  "Code review did not complete".

The reviewer is recorded as a `review.configured` event when a run first
executes, and a resume uses that record, so changing the configuration does
not add or remove the gate for a run in progress.

A single-step worker's file list comes from its `patch.applying` event,
recorded before the patch's first write, and its `patch.applied` event. If
the engine stops while the patch is being written, or cannot roll back a
write that failed partway, a resumed run still shows the reviewer every file
the patch left in the workspace. Only a rollback that restores the
workspace's pre-patch fingerprint records `patch.rolled_back` and takes the
patch's files off the list; a rollback that cannot needs reconciliation. A
patch that leaves any of the run's files outside the verification inventory
(a new Git-ignored file, say) is rolled back the same way before it is
recorded as applied.
Every review is recorded as `review.completed` with the verdict, criteria,
findings with their IDs (evidence and messages redacted) and the snapshot it
reviewed. `graph-engine run-receipt` projects an `evidence` ledger from these
events: the final snapshot, the snapshot the latest verification, review and
security-gate results each ran against, whether each is `current`, and
`complete`, true only when every gate that ran is current. It reads the
events and never changes a gate.

## A person's review

A reviewer can hold a change back, and a run can also stop at review
because its turn budget ran out or because a cloud reviewer may not
receive the change (a path outside `exportPaths`, a potential secret, a
change too large for its context budget). When the required checks
passed, you can review the change yourself and approve it in place of the
reviewer, as a senior reviewer would:

```sh
graph-engine review-approve <run-id> --note "What you reviewed"
```

The command refuses unless the run's latest attempt stopped at code
review after that attempt's required checks passed, and its retained
workspace still matches the snapshot those checks ran on. A resume that
stopped before reaching review again cannot be approved: fix what stopped
it and resume, and approve once it stops at review again. The command
records your approval for that snapshot only and resumes the run, which
then completes without calling the reviewer again. The outcome records
the review as `approved-by-person`, shown separately from the reviewer's
approvals on the board and in `outcomes --summary`. Accepting the result
is still a separate step (`graph-engine accept`). Connected AI clients
cannot approve a review.

The [project board](project-overview.md) lists this command first for a
run in that state. Approve it rather than raise `policy.maxTurns`: a
policy change refuses both `review-approve` and `resume` for a run planned
before it, so the run would have to be planned again.
