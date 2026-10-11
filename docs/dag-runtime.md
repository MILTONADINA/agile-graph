# Dependency scheduling

`execution/dag.ts` validates up to 100 uniquely identified steps, explicit dependencies, worker provider IDs and registered generator IDs. Orphans, cycles, duplicate dependencies, and invalid step contracts fail before dispatch.

`runDag` accepts the steps, managed workspace, project policy, a durable `saveCheckpoint` callback, and a read-only `generate(step, { snapshotHash, signal })` callback returning a `WorkerResult`. The service selects each step's provider/effort and resolves missing-context requests inside that callback. The scheduler never launches a shell or provider itself.

- Ready steps generate proposals concurrently, bounded by `maxParallel <= policy.maxWorkers`.
- Every fulfilled call reports its usage through `onUsage`, even if a sibling fails. Provider retry/turn limits and cost reservation remain the caller's responsibility.
- Every member of a wave is validated before the first write. Independent steps cannot write the same file, case aliases, or parent/child paths, even across different waves. Add an explicit dependency when a later step intentionally modifies earlier output.
- Optional `writeScopes[stepId]` are exact canonical relative paths, not glob patterns. Patches outside a declared scope fail.
- Patch application is serialized. Worker filesystem changes, policy changes, stale checkpoints, unresolved source requests, and cancellation stop the run.
- This is a per-run concurrency bound. The service must also reserve project-wide worker capacity across simultaneous runs.

## Generation deadlines

Each generation normally receives a `policy.timeoutSeconds` deadline; this is
a per-step envelope, not a whole-plan timer. With the optional
`policy.installedWorkerTimeoutSeconds`, an installed Claude Code, Codex or
Cursor worker can instead use an integer `1..86400` seconds or explicit `null`
for no fixed wall-clock deadline. Absence preserves the original behavior.
The service binds the provider kind used to select that envelope and refuses a
different kind at dispatch. Unknown, API/local and generator kinds retain the
ordinary deadline. The eligible worker's context-request turns share its
envelope; installed adapter calls use the same deadline selection. This
includes installed tester steps and implementation/repair calls without
changing their write authority.

`null` is not an idle/progress timeout: cancellation and existing output, turn
and safety guards still apply, but a hung installed client needs operator
cancellation. Native clients/providers can retain their own limits. Slot
acquisition, capability probes and security scans remain bounded independently.
Verification keeps its ordinary deadline unless its separate
[`verificationTimeoutSeconds`](verification-images.md#execution-deadlines)
override is explicitly configured; the installed-worker field never changes it.
The field is part of the policy hash, so changing it requires a
fresh plan and its required approval, not a resume of an old policy-bound run.
Defaults and monetary caps are unchanged. See
[operator setup and limits](installed-workers.md#execution-deadlines) and the
[ready deadline spec](../specs/providers/installed-worker-deadlines.md). This
narrow release has 42 distinct focused local cases and its dependency/engine
builds passing. Final-head CI and merge are still pending; these checks did not
invoke live providers.

## Managed-plan write-scope limits

The public planning contract exposes `steps[].writes` as allowlist globs,
not the scheduler's internal exact `writeScopes` map. A configured tester
receives `tester.writes` (or its default test globs), independently of worker
scopes. To predeclare a new test filename, set
`graph-engine tester <providerId> --writes <path>` before planning and inspect
the injected tester step in the full plan before approving its hash. A path
without glob metacharacters is a restrictive literal pattern; arbitrary
filenames containing glob syntax are not automatically literal. The initial
tester must create at least one new file, never edit an existing test. Both
tester and worker initial proposals are checked against their own scopes.

For combined check failures, `dag-repair` copies `writes` from the first
selected non-tester worker, including any `!` exclusions. It does not take the
union of other workers' scopes. Its out-of-scope proposals are returned as
feedback before application; when the selected worker has no `writes`, the
repair remains unscoped within project policy as before. A resumed repair
reconstructs that same selected-worker scope. If an implementer disputes a
test, the tester's repair is limited to the exact files that tester created,
and a subsequent handback restores the implementer's copied scope. This does
not create a public, plan-wide literal write-allowlist schema, nor does it
retroactively revalidate or authorize retained repairs made by older engine
versions. `policy.workingSet` is not an exact write-only substitute: it also
limits indexing and reads, uses path-root rather than exact-file semantics,
and retains the documented public-context exceptions. The scope follow-up's
focused narrow-release cases pass locally; final-head CI remains pending.

## Offline generator steps

A generator step runs an operator-registered, image-pinned argv in a disposable
Docker view of the run workspace. It is not a host command, an MCP-registered
tool or a model worker. An operator manages registrations with the
`generator-add`, `generator-remove` and `generators` CLI commands; a plan
freezes the complete registration and exposes it to `plan-approve`. Every add
or replacement gets a fresh revision. A plan's pending generator work is
refused if that revision or any canonical registration field no longer
matches the live project configuration, even when plan approval is off.

The container has no network, a read-only root, a writable temporary view and
bounded time, processes, memory, CPU and output. The engine checks the entire
view after exit, refuses unsafe or undeclared changes, then turns allowed text
changes into an ordinary proposal. Write scopes, secrets, tester-file
protection, checkpoint recovery, required checks, security and review still
apply. A generator cannot edit an existing empty file until the proposal
format supports that case. A cloud-authored plan counts a generator as a local
role and cannot mix it with non-local model roles. See the
[generator spec](../specs/runs/generator-steps.md) for exact criteria and
evidence limits.

## Resume and crash handling

Checkpoints bind the complete plan, policy, write scopes, completed steps, and exact workspace fingerprint. A matching checkpoint skips completed steps; it never blindly replays their substring replacements.

Before each patch, the scheduler durably records a pending application with the workspace's pre-patch fingerprint. Once the patch is on disk it adds the post-patch fingerprint, then checks that every proposed file reaches the verification inventory, and finally records completion. If applying the patch or a post-apply check fails (for example, a step created a Git-ignored file or changed ignore rules so an earlier step's output disappears), the scheduler restores each file the patch touched, removes directories it created, confirms the workspace is back at its pre-patch fingerprint, clears the pending marker and records a `dag.step.rolled_back` event with the error. The run then stops as `failed`, and resuming it generates that step again. If the rollback itself cannot restore the pre-patch state, the pending marker stays and the run needs reconciliation.

A crash between recording the pending application and recording completion leaves the marker in place. A plain restart refuses to continue. After you inspect the retained workspace and resume with explicit acknowledgement (`graph-engine resume RUN_ID --reconciled`), the scheduler compares the workspace with both recorded fingerprints. If it matches the pre-patch fingerprint, it clears the marker and runs the step again. If it matches the post-patch fingerprint and every proposed file still reaches the verification inventory, it records the step as applied without regenerating it. Both outcomes record a `dag.step.reconciled` event (`not_applied` or `applied`). Any other state, including a partial write or a marker with no post-patch fingerprint when the workspace has changed, is refused with a message naming the step's files. To recover, either restore those files to their pre-step content (or the complete patch, when one was recorded) and resume again, or leave the run and create a new plan to start a fresh run. The acknowledgement alone never erases the pending state; only a fingerprint match does. Durable JSON checkpoint writers should use atomic rename.

The checkpoint, not the run's events, is the record of which files the DAG wrote. A step recorded as applied by reconciliation has no `dag.step.completed` event, and a crash can stop a run after a step's completion is saved but before its event is recorded. The service therefore takes a DAG's written files from its latest checkpoint as well as from events: the reviewer's diff, the security gate's list of files the run wrote (used to refuse a changed lockfile when no OSV database is downloaded, to decide which dependency advisories hold the run back, and to refuse files no scanner could read), the verification inventory and the tester's guards (implementers and repairs may not change the tests the tester wrote) all include them.

The scheduler does not claim tests passed. The service must verify the resulting source in its restricted container before publication.

## Repairing failed combined checks

When the combined result of a multi-step plan fails verification, the service repairs it the way a single-step run retries: a `dag-repair` worker step (a reserved step ID) gets the combined workspace, fresh context, the check failures as feedback (generic feedback for cloud workers) and an objective that includes the plan's objective, using the provider, effort and copied write scope of the plan's first non-tester worker step. Repair attempts run from attempt 2 up to `policy.maxAttempts`, sharing the run's turn budget and recovery controller; the controller escalates a failing repair only to another provider the plan already uses. Each repair patch is applied with a step's crash discipline (`applyRepair`). It is validated first, so a patch that does not apply goes back to the worker with nothing recorded. The scheduler then saves a pending marker under the reserved `dag-repair` ID with the pre-patch fingerprint, adds the post-patch fingerprint once the patch is on disk, checks that every file the plan and its repairs wrote still reaches the verification inventory, and on completion moves the checkpoint to the post-patch fingerprint and records the repair's files in its `repairPaths`. A write that fails partway (for example a full disk), or a repair that creates a Git-ignored file or changes ignore rules so an earlier step's output disappears, is rolled back and recorded as `dag.step.rolled_back`, so the run stops at its pre-repair state and resuming it repairs again. A crash while the marker is pending is reconciled on an acknowledged resume like a step's: at the pre-patch fingerprint the repair runs again, and at the post-patch fingerprint it is recorded as applied, its files counted as the run's. A run stopped during repair (for example by a verifier failure) resumes into verification and further repair rather than reconciliation: when verification of the unchanged combined result fails, repair continues without checking and reviewing that snapshot a second time. Publication still requires every check to pass on the exact verified snapshot. A plan with only generator steps, or a policy with `maxAttempts: 1`, stops as before and asks for a repair plan.

The existing recovery controller may escalate the repair provider, but that
does not widen the selected first worker's copied write scope. Tester repair
uses its own exact created-file boundary instead.

Every completed proposal path must remain in the Git-based verification inventory.
A new ignored file, or a later `.gitignore` edit hiding an earlier generated file,
stops acceptance. The scheduler rolls back the step or repair patch that caused it
and records `dag.step.rolled_back`; only a rollback that cannot restore the
pre-patch state leaves its pending marker for reconciliation.
Sequential and cached proposals undergo the same inventory check before verification.
Legacy cache-replay events without a recorded path inventory require explicit source
review and cannot silently establish acceptance during resume.
