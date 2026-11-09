# Multi-step plans

- ID: multi-step-plans
- Status: implemented
- Area: planning

## Problem

Larger changes are made of steps, some independent and some depending on others. An operator wants to describe those steps as a dependency graph, have independent steps run in parallel where safe, have dependent steps see their predecessors' results, verify the combined result, and repair a plan whose combined checks fail, all within the same budgets and safety guarantees as a single-step run.

## Acceptance criteria

- AC1: A plan whose steps form a cycle, depend on unknown steps, reuse an ID or lack a provider contract is rejected.
  - Test: packages/engine/tests/dag.test.ts :: rejects cycles, orphan dependencies, duplicate IDs and missing provider contracts
- AC2: Independent steps are generated concurrently and applied before dependent steps run, and the final combined result is verified.
  - Test: packages/engine/tests/dag.test.ts :: generates independent proposals concurrently and applies them before dependent generation
  - Test: packages/engine/tests/managed-dag.test.ts :: applies independent proposals then dependent work and verifies the final aggregate
- AC2a: WHEN all of a step's dependsOn steps have applied, THE engine SHALL start that step at once, without waiting for other running steps, and SHALL run no more than maxParallel generations at a time.
  - Test: packages/engine/tests/dag-streaming.test.ts :: starts a step once its own dependency applies, while an independent slower sibling still runs
  - Test: packages/engine/tests/dag-streaming.test.ts :: never runs more generations than maxParallel and refills a freed slot at once
- AC2b: WHEN generated proposals finish in any order, THE engine SHALL apply them one at a time, in the same order for the same plan and completion order, and SHALL apply each step only after every one of its dependsOn steps has applied.
  - Test: packages/engine/tests/dag-streaming.test.ts :: applies in the same order for the same plan and completion order, and dependents after their dependencies
- AC3: Sibling steps that would write the same file (including case aliases) or files they did not declare are rejected before the colliding patch is written, and a step's own preconditions are checked before its own write.
  - Test: packages/engine/tests/dag.test.ts :: rejects a sibling collision before the colliding patch is written, including case aliases
  - Test: packages/engine/tests/dag.test.ts :: validates a step's preconditions before its own write
  - Test: packages/engine/tests/dag.test.ts :: rejects undeclared writes and collisions in later independent waves
- AC4: Resuming a plan skips completed steps, runs only unfinished ones and verifies the whole retained result; an interruption between applying a patch and recording it requires reconciliation. A patch that fails a check after application (such as a Git-ignored file) is rolled back so the run stays resumable. An acknowledged resume clears an interrupted patch only when the workspace matches its pre-patch fingerprint (the step runs again) or its post-patch fingerprint (the step is recorded as applied); any other state is refused with instructions to restore the files or start a new plan.
  - Test: packages/engine/tests/dag.test.ts :: resumes completed steps without regenerating or reapplying them
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resumes only unfinished dependent steps and verifies the complete retained aggregate
  - Test: packages/engine/tests/dag.test.ts :: requires reconciliation after interruption between a patch and its durable completion
  - Test: packages/engine/tests/dag.test.ts :: rolls back a patch whose ignore-rule edit hides an earlier generated file and stays resumable
  - Test: packages/engine/tests/dag.test.ts :: rolls back a Git-ignored new file and the directories its patch created
  - Test: packages/engine/tests/dag.test.ts :: records a pending step as applied when the acknowledged workspace matches its post-patch state
  - Test: packages/engine/tests/dag.test.ts :: re-runs a pending step when the acknowledged workspace is back at its pre-patch state
  - Test: packages/engine/tests/dag.test.ts :: refuses to reconcile a pending step whose workspace matches neither fingerprint
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resolves a crash-interrupted patch on an acknowledged resume when the workspace matches its post-patch state
- AC4a: WHEN a step's generation fails with a step-local error, THE engine SHALL keep starting ready steps that do not depend on the failed step, directly or through other steps, within maxParallel, SHALL apply them serially in plan order, SHALL generate no step that depends on a failed step, and SHALL end the run as failed with the first failure's error once nothing is running and nothing can start. It SHALL NOT verify or repair the partial result. Spending after a failure stays bounded by the run's cost and turn budgets (#365, #164).
  - Test: packages/engine/tests/dag-streaming.test.ts :: applies a running independent step when a sibling fails, and fails the run with the first error
  - Test: packages/engine/tests/dag-streaming.test.ts :: keeps starting independent steps after a failure when one generation runs at a time
  - Test: packages/engine/tests/dag-streaming.test.ts :: starts a step whose dependency applied after a sibling failed
  - Test: packages/engine/tests/dag-streaming.test.ts :: never generates a step that depends on a failed step, directly or through another, and records it as skipped
  - Test: packages/engine/tests/dag-streaming.test.ts :: keeps the first error when two independent steps fail
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: applies the independent step, fails the run with counts and never verifies or repairs
- AC4b: WHILE a step's generation is running, THE engine SHALL give it a read-only frozen copy of the workspace at the generation's snapshot hash, taken before any further patch applies, so that a patch from another step applying meanwhile never changes what the generation reads, and SHALL remove the copy when the generation succeeds, fails, is cancelled or times out. The copy SHALL be made in the folder that holds the run workspace, where container views are also made, never in the system temp folder; a copy an earlier crash left there SHALL be removed when the run starts; a copy that cannot be removed SHALL be reported as an event and SHALL NOT change the step's outcome or fail the run.
  - Test: packages/engine/tests/dag-streaming.test.ts :: keeps a running generation on the pre-patch content while a sibling's patch applies (#373)
  - Test: packages/engine/tests/dag-streaming.test.ts :: gives each generation an existing private copy and removes it after success, failure and abort
  - Test: packages/engine/tests/snapshot.test.ts :: equals the fingerprint, keeps executable bits and lists its files through Git
  - Test: packages/engine/tests/snapshot.test.ts :: throws on a hash mismatch and leaves no directory behind
  - Test: packages/engine/tests/snapshot.test.ts :: removes only this workspace's leftover snapshot directories, never following a symlink
  - Test: packages/engine/tests/snapshot.test.ts :: never touches a repository GIT_DIR points at
  - Test: packages/engine/tests/dag-streaming.test.ts :: keeps a step's outcome and reports, not fails, when a snapshot cannot be removed
  - Test: packages/engine/tests/dag-snapshot-mismatch.test.ts :: ends needing reconciliation, like any outside change to the workspace
- AC4c: WHEN the workspace itself is found in a state the scheduler did not produce (a worker modified it, or a patch could not be rolled back) after an earlier plain failure, THE engine SHALL end the run as needing reconciliation; WHEN the later error is a project policy change, THE engine SHALL still end the run as failed with the first failure's error.
  - Test: packages/engine/tests/dag-streaming.test.ts :: ends needs-reconciliation when a worker dirties the workspace after an earlier plain failure
  - Test: packages/engine/tests/dag-streaming.test.ts :: still ends failed, not needs-reconciliation, when a policy change follows a plain failure
- AC4d: IF a generation fails because of a policy change, run cancellation, a reconciliation error, a missing or changed provider, a failed plan-verification or live-generator check, or the run's cost or turn budget, THEN THE engine SHALL start no new step, SHALL apply each running step that does not depend on a failed step, and SHALL end the run failed. A reconciliation error keeps its precedence and status.
  - Test: packages/engine/tests/dag-streaming.test.ts :: starts no step after a run-wide stop and marks the failure as one
  - Test: packages/engine/tests/dag-streaming.test.ts :: starts no step after the policy changes during a generation
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: starts no further step once the shared turn budget is spent
- AC4e: WHEN validating or applying a step's patch fails, THE engine SHALL cancel every running generation, start no further step and end the run at once.
  - Test: packages/engine/tests/dag-streaming.test.ts :: stops at once on a validation error and never starts a later independent step
- AC4f: WHEN a step's generation fails, THE engine SHALL record dag.step.failed with {kind, setup?, runStop?} and no error text. WHEN the run ends after a failure, THE engine SHALL record dag.step.skipped {kind} for each step it did not start because it depends on a failed step. Flags SHALL be omitted when false, so plans without a setup step or a failure keep their event payloads, and the plan schema, contracts and plan hashes SHALL NOT change.
  - Test: packages/engine/tests/dag-streaming.test.ts :: labels ready, blocked and failed events without error text or extra keys
  - Test: packages/engine/tests/dag-streaming.test.ts :: keeps event payloads unchanged for a plan without a setup step
- AC4g: WHERE a plan includes the configured tester, THE engine SHALL NOT start a step that depends on the tester until the tester has applied, which keeps test-first: a failing tester skips its dependents, because withTester makes every step depend on it. Only steps a plan declares as independent of the tester can finish after a tester failure.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: generates no product step when the tester fails, and shows them as skipped
- AC4h: WHEN a run ends failed under AC4a, THE run error SHALL keep the first failure's redacted message and add how many steps were applied and never started out of the total, say that the applied steps are not verified, and name the `graph-engine resume RUN_ID --reconciled` command, which reruns the failed and skipped steps and then verifies the whole result. The status SHALL be failed, and overview SHALL show the failed and skipped steps of the current attempt.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: applies the independent step, fails the run with counts and never verifies or repairs
  - Test: packages/engine/tests/dag-streaming.test.ts :: tells the caller how many steps applied and never started
  - Test: packages/engine/tests/overview.test.ts :: shows a failed step, its skipped dependent and an applied independent step for the current attempt
  - Test: packages/engine/tests/overview.test.ts :: resets failed and skipped states when the run is resumed
- AC4i: WHEN such a run is resumed with reconciliation, THE engine SHALL skip every applied step, including steps that applied after the failure, SHALL generate only the failed and skipped steps, and SHALL verify the whole retained result before the run can complete.
  - Test: packages/engine/tests/dag.test.ts :: resumes a run that failed on one step by generating only that step
- AC5: When the combined checks fail, a repair step receives the failure as feedback within the attempt budget; a single-attempt plan fails without repair. A resumed plan whose unchanged combined result fails verification or review goes on to repair without checking and reviewing that same snapshot again.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: repairs a multi-step plan whose combined checks failed, with the failure as feedback
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps single-attempt plans failing without repair and reserves the repair step ID
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: verifies and reviews an unchanged repaired plan once when it resumes into repair
- AC6: Parallel steps share one turn and cost budget, and a parallel call the budget cannot afford is refused before dispatch.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shares one durable worker-turn ceiling across parallel siblings and resume attempts
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects unaffordable parallel calls before dispatch and preserves the budget on resume
- AC7: A policy change while steps are generating in parallel stops the plan without applying either sibling's patch.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects a policy change during parallel generation, retaining usage but applying neither patch
- AC8: A step may declare the files it may write (globs, where a `!` entry excludes from the others and never widens them); an edit outside them is returned to the worker as feedback and never applied, in single-step and multi-step plans. Each step has its own time limit by default; the opt-in installed-worker deadline extension is specified separately. A combined-result `dag-repair` copies the first selected non-tester worker's `writes`, including exclusions, rather than unioning other workers' scopes; an unscoped selected worker remains unscoped within project policy. This scope is reconstructed on resume and restored after a tester repair handback. The rule does not retroactively revalidate retained repairs made by older versions or establish a global literal write-allowlist schema.
  - Test: packages/engine/tests/dag.test.ts :: refuses a step's write outside its declared globs and accepts one inside
  - Test: packages/engine/tests/dag.test.ts :: treats a negated writes entry as an exclusion that never widens the step's scope
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns an out-of-scope edit to the worker as feedback
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never applies a single-step edit outside the step's scope
  - Test: packages/engine/tests/dag.test.ts :: gives each step its own timeout rather than one for the whole plan
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps a DAG repair within the selected implementer's write scope
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: preserves a DAG repair's exclusions after an acknowledged resume
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: restores the implementer's write scope after a tester repair handoff

- AC9: A step's patch that cannot apply (a before that does not match exactly once, or a new file whose name is taken) goes back to its worker as feedback with a reason code instead of failing the plan; a tester is told to use a new file name.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns a DAG patch that cannot apply to the worker instead of failing the plan
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: tells a tester whose new test file already exists to use another name

- AC10: Planning from the command line, MCP or the dashboard warns when a plan's steps, reviews, checks of earlier review findings (three expected per repair attempt with a reviewer) and repair attempts are likely to need more model calls than policy.maxTurns allows for the whole run, and says a raised limit needs a fresh plan and voids resume and review-approve for a run already started.
  - Test: packages/engine/tests/execution.test.ts :: warns when a plan may need more model calls than the run-wide turn budget
  - Test: packages/engine/tests/cli.test.ts :: estimates the model calls a plan's roles need
  - Test: packages/engine/tests/planning.test.ts :: reserves expected fix checks of earlier review findings per repair attempt

- AC11: A repair patch is applied like a step: a write that fails partway, or a patch that leaves a file the plan or repair wrote outside the verification inventory, is rolled back so the run stays resumable, and an acknowledged resume after a crash records the repair as applied when the workspace matches its post-patch fingerprint, or runs it again when it matches its pre-patch fingerprint.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rolls back a repair patch that fails while its files are written, so the run resumes into repair
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resolves an interrupted repair patch on an acknowledged resume and reviews the files it wrote
  - Test: packages/engine/tests/dag.test.ts :: reconciles an interrupted repair patch by fingerprint and records the files it wrote
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rolls back a repair patch that writes a Git-ignored file, so the run resumes into repair
  - Test: packages/engine/tests/dag.test.ts :: rolls back a repair patch that leaves a file outside the verification inventory

- AC12: Every file a step or repair wrote counts as the run's change even when a crash left no completion event for it, including a patch an acknowledged resume recorded as applied: the reviewer sees it, the security gate treats it as written by the run, and later steps and repairs may not change the tests the tester wrote.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shows the reviewer a step an acknowledged resume recorded as applied
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: scans a step whose saved completion has no event as a file the run wrote
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps guarding the tester's tests when its saved completion has no event
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resolves an interrupted repair patch on an acknowledged resume and reviews the files it wrote

- AC13: WHILE a multi-step plan's step is ready but has no free slot, THE retro SHALL record the minutes it waited, by step kind, with no step ID or content.
  - Test: packages/engine/tests/retro.test.ts :: shows how many minutes each step was ready before it started, without its ID
- AC13a: WHEN a run stops while a step is ready but not started, THE retro SHALL end that wait at the stop, so the time the run was stopped is never counted as a step's wait.
  - Test: packages/engine/tests/retro.test.ts :: does not count the time a run was stopped as a step's wait
- AC13b: WHEN a step that depends, directly or through other steps, on a setup step first has an unapplied setup dependency in a scheduling segment, THE engine SHALL record dag.step.blocked {kind, waitingOnSetup}. WHEN that step becomes ready, THE retro SHALL record the minutes from blocked to ready as setup wait, by step kind, in total and as a median, per run and in the summary, with no step ID or content. The configured tester is the only setup step.
  - Test: packages/engine/tests/retro.test.ts :: measures how long a step waited on setup, from blocked to ready, without its ID
  - Test: packages/engine/tests/dag-streaming.test.ts :: labels ready, blocked and failed events without error text or extra keys
- AC13c: WHEN a run stops while a step is blocked on setup, THE retro SHALL end that wait at the stop. A resumed segment announces its blocked steps again, so stopped time is never counted, and a step blocked only on a product step is not counted.
  - Test: packages/engine/tests/retro.test.ts :: does not count a stop between blocked and ready, or a step blocked only on a product step, as setup wait
  - Test: packages/engine/tests/retro.test.ts :: drops a blocked step that failed or was skipped

## Security considerations

Parallelism multiplies spend and write risk, so all steps draw on one durable turn and cost ceiling and every step's preconditions are checked before its own write. Undeclared writes and path collisions are refused so one step cannot overwrite another's work or reach paths it was not planned for. Policy is re-read between sibling applications, so tightening policy mid-run takes effect. Cloud steps follow the same export rules as single runs, including refusal of mandatory text the run workspace imported.

## Non-goals

Plans do not invent their own steps (see decomposition); the operator or an approved proposal supplies them. Parallelism is bounded by the owner's `maxWorkers` and the repository size class and is never raised automatically.
