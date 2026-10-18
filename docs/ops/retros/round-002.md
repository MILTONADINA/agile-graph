# Retro round 002: Sprint 2

- Date: 2026-10-18
- Change this round: reviews by a second model finish before a branch is
  pushed, and the hypotheses from round 001.

## Where the numbers come from

- **Repository delivery:** GitHub Actions history of the `Platform checks`
  pull-request runs created from the opening of #187 to the merge of #208,
  read with `gh api`, and the pull requests that reached `main` in the same
  window. Dependabot's own pull requests are counted separately.

## What shipped

| Merge | Stories                                                                               |
| ----- | ------------------------------------------------------------------------------------- |
| #187  | count overlapping matches in the patch precondition, the round 001 retro              |
| #189  | RSS sample tests independent of the runner's real `ps`                                |
| #191  | non-root verification container, production dependency audit, weekly update bot       |
| #192  | GitHub Actions updates from the update bot                                            |
| #200  | base images pinned by digest, jittered SQLite busy retry, opt-in redacted request log |
| #203  | Laya sidecar pinned by digest, flaky test policy, Dart coverage errors surfaced       |
| #204  | release 0.2.0, with npm provenance                                                    |
| #205  | run events read a bounded page at a time                                              |
| #207  | test data kept out of the user's data directory, disk space reclaimed after a prune   |
| #208  | run store lookups indexed by project, orphan rows reported on backup and restore      |

Seventeen pull requests reached `main` through ten merges, including the
lower PRs of stacks closed after their train merged.

## What was slow

| Repository CI (26 PR runs) | Value                                   |
| -------------------------- | --------------------------------------- |
| Passed                     | 12, median 36 minutes (26 to 60)        |
| Failed                     | 2, 21 and 33 minutes before the failure |
| Cancelled                  | 12, lower PRs of stacks, by design      |

Leaving out the update bot's #192, whose runs are counted separately below,
fourteen completed CI runs for sixteen pull requests is about 0.9 runs per
story, against round 001's 0.7. Both failures were platform-specific again:

- The non-root verification image broke the derived fixture images, which
  compile as their own user, on Linux. They now switch back to root.
- A digest test built paths with `path.join` and failed on Windows only.

Neither failure was the Linux Dart indexing test (#185) or the RSS sample
test (#188); both now print their diagnostics if they fail again.

The update bot opened twelve CI runs of its own and ten failed: every npm
update changes the hash-pinned lockfile, which CI refuses by design.

## What review by a second model found

Every story was reviewed by a different model, and the reviews found
defects in seven stories before merge.

Found before the push, at no CI cost:

- the test data teardown trusted an inherited variable and could delete a
  folder the caller chose;
- `VACUUM` writes through the WAL, so a prune could report space reclaimed
  while the file grew;
- restoring an archive from before schema version 5 failed on a missing
  table;
- a schema version bump for indexes alone would have made an older engine
  refuse the database (found in the orchestrator's review).

Found by the review bot after the push, each costing a CI cycle:

- the non-root check refused group 0, which is not root;
- the request log left paths with spaces partly unredacted and missed the
  event stream's responses;
- a test injected a fault that only re-tested the catch path.

The last three stories (#176, #177 and the run store indexes) finished
review before the push and merged in one CI run each; three of the first stories did, against one in round 001.

## Hypotheses for the next rounds

1. **Review before the push saves cycles.** Confirmed: the stories reviewed
   before the push merged in one CI run. Keep it.
2. **Platform-only failures still cost full cycles.** Confirmed again:
   both failures were platform-specific. Next change: run the Windows and
   Linux path and permission cases in the local preflight where they can be
   simulated (path separators, uid).
3. **Lockfile updates need a person.** The update bot cannot pass CI on its
   own: it already groups minor and patch updates, but any npm update
   changes the pinned lockfile, and majors arrive one per package. Next
   change: document how the owner re-pins an accepted update.
4. **Trains trade CI runs for waiting** (from round 001). Not measured this
   round; still open.

## Deferred

- Root causes of the Dart (#185) and RSS (#188) flakes.
- Automatic snapshot retention and a size warning in `doctor` (after #177).
- Per-check durations on `verification.completed` (from round 000).
