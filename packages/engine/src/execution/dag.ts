import type {
  ExecutionStep,
  ProjectPolicy,
  ProviderKind,
  Usage,
} from "@agile-graph/contracts";
import path from "node:path";
import { z } from "zod";
import { hash, now } from "../util.js";
import { workerTimeoutMs } from "../workers/deadline.js";
import {
  globAllowlist,
  isAllowedPath,
  safePath,
  validGlobEntry,
} from "../policy.js";
import {
  proposalSchema,
  type WorkerProposal,
  type WorkerResult,
} from "../workers/api.js";
import {
  applyProposal,
  assertVerificationPaths,
  captureOriginals,
  pathsOverlap,
  prepareProposal,
  restoreOriginals,
  type Originals,
  workspaceFingerprint,
} from "./workspace.js";
import {
  createWorkspaceSnapshot,
  removeStaleSnapshots,
  SnapshotMismatchError,
} from "./snapshot.js";

/** The engine's repair step after a plan's combined checks fail; plans may not use its ID. */
export const DAG_REPAIR_STEP = "dag-repair";
export interface ValidatedDag {
  steps: ExecutionStep[];
  ancestors: ReadonlyMap<string, ReadonlySet<string>>;
}
export interface DagCompletedStep {
  id: string;
  proposalHash: string;
  paths: string[];
  completedAt: string;
}
export interface DagCheckpoint {
  version: "1.0.0";
  planHash: string;
  workspaceHash: string;
  completed: DagCompletedStep[];
  /** Every file an applied repair patch wrote; repairs run once every step completed. */
  repairPaths?: string[];
  pending?: {
    /** A plan step, or DAG_REPAIR_STEP for a repair patch. */
    stepId: string;
    proposalHash: string;
    beforeHash: string;
    /** Workspace fingerprint once the patch is on disk, before its checks. */
    afterHash?: string;
    paths: string[];
  };
}
export interface DagEvent {
  type: string;
  stepId?: string;
  data: Record<string, unknown>;
}
export interface DagOptions {
  steps: ExecutionStep[];
  workspace: string;
  policy: ProjectPolicy;
  maxParallel?: number;
  writeScopes?: Record<string, string[]>;
  /** Trusted dispatch binding; unknown kinds retain the ordinary deadline. */
  workerProviderKind?: (step: ExecutionStep) => ProviderKind | undefined;
  signal?: AbortSignal;
  checkpoint?: DagCheckpoint;
  /**
   * The operator acknowledged the retained state (`resume --reconciled`), so a
   * pending patch application is resolved by fingerprint: a workspace at its
   * pre-patch state re-runs the step, one at its post-patch state records it
   * as applied, and anything else still refuses.
   */
  reconcilePending?: boolean;
  /** Must durably persist before resolving; JSON writes should use atomic rename. */
  saveCheckpoint: (checkpoint: DagCheckpoint) => Promise<void>;
  /** Read/proposal only: a worker is never allowed to edit the workspace. */
  generate: (
    step: ExecutionStep,
    state: {
      snapshotHash: string;
      /**
       * Read-only frozen copy of the workspace at `snapshotHash`; never the
       * live workspace. Read sources from here: patches from sibling steps
       * may apply to the live workspace while this generation runs. The
       * scheduler removes it when the generation settles.
       */
      workspace: string;
      signal: AbortSignal;
      workerProviderKind?: ProviderKind;
    },
  ) => Promise<WorkerResult>;
  /** Recheck live authorization before each step's validation and each serialized write. */
  beforeApply?: (step: ExecutionStep) => Promise<void>;
  /** Called for every fulfilled generation, including siblings of a failed step. */
  onUsage?: (usage: Usage, step: ExecutionStep) => Promise<void> | void;
  onEvent?: (event: DagEvent) => Promise<void> | void;
}
export interface DagResult {
  checkpoint: DagCheckpoint;
  appliedStepIds: string[];
}
export class DagReconciliationError extends Error {
  /**
   * The workspace itself is in a state the scheduler did not produce (a
   * worker dirtied it, a rollback could not restore it). Such an error ends
   * the run as needing reconciliation even after an earlier plain failure.
   */
  readonly workspaceState: boolean;
  constructor(
    message: string,
    options?: ErrorOptions & { workspaceState?: boolean },
  ) {
    super(message, options);
    this.name = "DagReconciliationError";
    this.workspaceState = options?.workspaceState === true;
  }
}

const stepSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    kind: z.enum(["worker", "generator"]),
    objective: z.string().min(1).max(32000),
    dependsOn: z.array(z.string()).max(100),
    providerId: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    generatorId: z.string().min(1).optional(),
    // `!pattern` entries exclude from the positive entries; a list of only
    // exclusions would otherwise read as "everything else".
    writes: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(50)
      .refine((writes) => writes.every(validGlobEntry), {
        message: 'A writes entry must not be "!" alone or start with "!!"',
      })
      .refine((writes) => writes.some((entry) => !entry.startsWith("!")), {
        message: "writes needs at least one pattern that is not an exclusion",
      })
      .optional(),
    // Any text, not only AC IDs: an entry naming no criterion is reported as
    // unknown coverage at review rather than refusing the whole plan.
    covers: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  })
  .strict();
const completedSchema = z
  .object({
    id: z.string(),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    paths: z.array(z.string()).max(50),
    completedAt: z.string().datetime(),
  })
  .strict();
const checkpointSchema = z
  .object({
    version: z.literal("1.0.0"),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    workspaceHash: z.string().regex(/^[a-f0-9]{64}$/),
    completed: z.array(completedSchema).max(100),
    // At most policy.maxTurns (100) repair patches of 50 files each.
    repairPaths: z.array(z.string()).max(5000).optional(),
    pending: z
      .object({
        stepId: z.string(),
        proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
        beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
        afterHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        paths: z.array(z.string()).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Parse a retained checkpoint before using its completed IDs for revocation checks. */
export function parseDagCheckpoint(value: unknown): DagCheckpoint {
  return checkpointSchema.parse(value);
}

/**
 * Whether a step may write a file: its declared `writes` globs (where a
 * `!pattern` entry excludes) and any scheduler-supplied paths both apply.
 * Undefined means unrestricted.
 */
export function writeScope(
  step: ExecutionStep,
  writeScopes?: Record<string, string[]>,
): ((file: string) => boolean) | undefined {
  const declared = step.writes?.length ? globAllowlist(step.writes) : undefined;
  const supplied = writeScopes?.[step.id]?.map(exactPath);
  if (!declared && !supplied) return undefined;
  return (file) =>
    (!declared || declared(file)) &&
    (!supplied || supplied.includes(exactPath(file)));
}
// One spelling per relative path for exact-list membership, so `./a.ts`,
// `a\b.ts` and `a//b.ts` match the file listed as `a.ts` or `a/b.ts`.
// Brackets and other glob characters stay literal; case is kept.
function exactPath(file: string): string {
  return path.posix
    .normalize(file.normalize("NFC").replaceAll("\\", "/"))
    .replace(/^(\.\/)+/, "");
}
export function validateDag(input: ExecutionStep[]): ValidatedDag {
  const steps = z.array(stepSchema).min(1).max(100).parse(input);
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length)
    throw new Error("DAG step IDs must be unique");
  for (const step of steps) {
    // Reserved for the engine's repair step after failed combined checks.
    if (step.id === DAG_REPAIR_STEP)
      throw new Error(`Step ID ${DAG_REPAIR_STEP} is reserved`);
    if (step.kind === "worker" && !step.providerId)
      throw new Error(`Worker step ${step.id} requires a providerId`);
    if (step.kind === "worker" && step.generatorId !== undefined)
      throw new Error(`Worker step ${step.id} cannot set generatorId`);
    if (step.kind === "generator") {
      if (!step.generatorId)
        throw new Error(`Generator step ${step.id} requires a generatorId`);
      if (step.providerId !== undefined || step.effort !== undefined)
        throw new Error(
          `Generator step ${step.id} cannot set providerId or effort`,
        );
    }
    if (new Set(step.dependsOn).size !== step.dependsOn.length)
      throw new Error(`Duplicate dependencies for ${step.id}`);
    for (const dependency of step.dependsOn)
      if (!byId.has(dependency))
        throw new Error(`Unknown dependency ${dependency} for ${step.id}`);
  }
  const ancestors = new Map<string, Set<string>>(),
    visiting = new Set<string>();
  const visit = (id: string): Set<string> => {
    if (visiting.has(id)) throw new Error(`Dependency cycle includes ${id}`);
    if (ancestors.has(id)) return ancestors.get(id)!;
    visiting.add(id);
    const all = new Set<string>();
    for (const dependency of byId.get(id)!.dependsOn) {
      all.add(dependency);
      for (const ancestor of visit(dependency)) all.add(ancestor);
    }
    visiting.delete(id);
    ancestors.set(id, all);
    return all;
  };
  for (const step of steps) visit(step.id);
  return { steps, ancestors };
}

/**
 * Every file a checkpoint records as written: its completed steps' and its
 * applied repairs'. A crash can stop a run after a completion is saved but
 * before its event is recorded, and an acknowledged resume records an
 * interrupted patch as applied without one, so the checkpoint, not the
 * run's events, is the record of what the DAG wrote.
 */
export function checkpointPaths(checkpoint: DagCheckpoint): string[] {
  return [
    ...checkpoint.completed.flatMap((item) => item.paths),
    ...(checkpoint.repairPaths ?? []),
  ];
}

/** A step's generation settled: its proposal, or the error it failed with. */
type GenerationOutcome =
  | { step: ExecutionStep; ok: true; value: WorkerResult }
  | { step: ExecutionStep; ok: false; reason: unknown };
/** A generated proposal waiting for its serialized application. */
interface QueuedProposal {
  step: ExecutionStep;
  result: WorkerResult;
}

/** Parallelize independent proposal generation; all filesystem mutation is serialized. */
export async function runDag(options: DagOptions): Promise<DagResult> {
  const dag = validateDag(options.steps),
    { workspace, policy } = options;
  const policyHash = hash(policy);
  const maxParallel = options.maxParallel ?? policy.maxWorkers;
  if (
    !Number.isInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > policy.maxWorkers
  )
    throw new Error("DAG concurrency exceeds project worker policy");
  for (const [stepId, paths] of Object.entries(options.writeScopes ?? {})) {
    if (
      !dag.ancestors.has(stepId) ||
      !Array.isArray(paths) ||
      paths.length > 50 ||
      paths.some(
        (file) => typeof file !== "string" || !isAllowedPath(file, policy),
      )
    )
      throw new Error("Invalid DAG write scope");
  }
  const planHash = hash({
    steps: dag.steps,
    policy,
    writeScopes: options.writeScopes ?? {},
  });
  // Snapshots a crashed earlier run of this workspace left beside it.
  await removeStaleSnapshots(workspace);
  const snapshotHash = await workspaceFingerprint(workspace, policy);
  let checkpoint: DagCheckpoint = options.checkpoint
    ? checkpointSchema.parse(options.checkpoint)
    : {
        version: "1.0.0",
        planHash,
        workspaceHash: snapshotHash,
        completed: [],
      };
  if (checkpoint.planHash !== planHash)
    throw new DagReconciliationError(
      "DAG plan or policy changed since checkpoint",
    );
  const save = async () => options.saveCheckpoint(structuredClone(checkpoint));
  const event = async (
    type: string,
    stepId: string | undefined,
    data: Record<string, unknown>,
  ) => options.onEvent?.({ type, stepId, data });
  if (checkpoint.pending) {
    const pending = checkpoint.pending;
    // A repair patch follows every completed step and is recorded in
    // repairPaths, never as a completed step.
    const repair = pending.stepId === DAG_REPAIR_STEP;
    if (!options.reconcilePending)
      throw new DagReconciliationError(
        `Step ${pending.stepId} was interrupted during patch application; inspect the retained workspace, then resume with explicit reconciliation acknowledgement`,
      );
    const unresolved = (reason: string) =>
      new DagReconciliationError(
        `Step ${pending.stepId} was interrupted during patch application and ${reason}. ` +
          `Restore ${pending.paths.join(", ") || "its files"} in the retained workspace to their content before the step ` +
          `(the step then runs again)${pending.afterHash ? " or to the step's complete patch (the step is then recorded as applied)" : ""}, ` +
          `and resume with reconciliation acknowledgement again; or leave this run and create a new plan to start a fresh run.`,
      );
    const done = (id: string) =>
      checkpoint.completed.some((item) => item.id === id);
    if (
      pending.beforeHash !== checkpoint.workspaceHash ||
      (repair
        ? dag.steps.some((step) => !done(step.id))
        : !dag.ancestors.has(pending.stepId) ||
          done(pending.stepId) ||
          [...dag.ancestors.get(pending.stepId)!].some(
            (dependency) => !done(dependency),
          )) ||
      pending.paths.some((file) => !isAllowedPath(file, policy))
    )
      throw unresolved("its checkpoint record is inconsistent with the plan");
    if (snapshotHash === pending.beforeHash) {
      delete checkpoint.pending;
      await save();
      await event("dag.step.reconciled", pending.stepId, {
        outcome: "not_applied",
        paths: pending.paths,
      });
    } else if (pending.afterHash && snapshotHash === pending.afterHash) {
      try {
        await assertVerificationPaths(
          workspace,
          [...checkpointPaths(checkpoint), ...pending.paths],
          policy,
        );
      } catch (error) {
        throw unresolved(
          `its applied patch fails the verification inventory check (${(error as Error).message})`,
        );
      }
      checkpoint = repair
        ? {
            ...checkpoint,
            workspaceHash: pending.afterHash,
            repairPaths: withRepairPaths(checkpoint, pending.paths),
          }
        : {
            ...checkpoint,
            workspaceHash: pending.afterHash,
            completed: [
              ...checkpoint.completed,
              {
                id: pending.stepId,
                proposalHash: pending.proposalHash,
                paths: pending.paths,
                completedAt: now(),
              },
            ],
          };
      delete checkpoint.pending;
      await save();
      await event("dag.step.reconciled", pending.stepId, {
        outcome: "applied",
        paths: pending.paths,
        snapshotHash: checkpoint.workspaceHash,
      });
    } else
      throw unresolved(
        pending.afterHash
          ? "the retained workspace matches neither its state before the patch nor after it"
          : "the retained workspace no longer matches its state before the patch, and no complete patch was recorded",
      );
  }
  if (checkpoint.workspaceHash !== snapshotHash)
    throw new DagReconciliationError(
      "DAG workspace differs from its checkpoint",
    );
  const completed = new Set<string>();
  for (const step of checkpoint.completed) {
    if (
      completed.has(step.id) ||
      !dag.ancestors.has(step.id) ||
      [...dag.ancestors.get(step.id)!].some(
        (dependency) => !completed.has(dependency),
      ) ||
      step.paths.some((file) => !isAllowedPath(file, policy))
    )
      throw new DagReconciliationError(
        "DAG checkpoint has invalid completion ordering or paths",
      );
    completed.add(step.id);
  }
  if (
    checkpoint.repairPaths?.length &&
    (completed.size < dag.steps.length ||
      checkpoint.repairPaths.some((file) => !isAllowedPath(file, policy)))
  )
    throw new DagReconciliationError(
      "DAG checkpoint has invalid completion ordering or paths",
    );
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const checkCancelled = () => {
    if (signal.aborted) throw new Error("DAG execution cancelled");
  };
  const appliedStepIds: string[] = [];
  checkCancelled();
  await save();
  // Streaming schedule: a step starts once its own dependencies have applied,
  // with at most maxParallel generations running. Generated proposals wait in
  // `queued` and apply one at a time, the lowest plan position first, so
  // checkpoint ordering and pending-patch reconciliation are unchanged.
  // Each generation reads a frozen snapshot taken here, inside the serialized
  // loop, so no apply can run between the fingerprint check and the copy.
  const order = new Map(dag.steps.map((step, index) => [step.id, index]));
  const started = new Set<string>(completed);
  const announced = new Set<string>();
  const inflight = new Map<string, Promise<GenerationOutcome>>();
  const queued: QueuedProposal[] = [];
  // The first failure ends the run: no step starts after it, but generations
  // already running that do not depend on the failed step still finish and
  // apply. Any error during validation or application stops at once.
  let failure: { error: unknown } | undefined;
  // A workspace-state reconciliation error outranks an earlier plain failure.
  let workspaceError: DagReconciliationError | undefined;
  const snapshots = new Set<{ dispose(): Promise<void> }>();
  const launch = (
    step: ExecutionStep,
    snapshotHash: string,
    snapshot: { path: string; dispose(): Promise<void> },
  ) => {
    snapshots.add(snapshot);
    const generation = (async () => {
      try {
        await event("dag.step.started", step.id, {
          providerId: step.providerId ?? null,
        });
        // Each step's generation has its own policy timeout, so a long plan
        // is not bounded by a single step's allowance.
        const workerProviderKind =
          step.kind === "worker"
            ? options.workerProviderKind?.(step)
            : undefined;
        const timeoutMs = workerTimeoutMs(policy, workerProviderKind);
        return await options.generate(structuredClone(step), {
          snapshotHash,
          workspace: snapshot.path,
          workerProviderKind,
          signal:
            timeoutMs === null
              ? signal
              : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } finally {
        // A cleanup failure never changes the step's outcome; the snapshot
        // stays in the set and the end-of-run cleanup tries again.
        try {
          await snapshot.dispose();
          snapshots.delete(snapshot);
        } catch {}
      }
    })();
    inflight.set(
      step.id,
      generation.then(
        (value): GenerationOutcome => ({ step, ok: true, value }),
        (reason): GenerationOutcome => ({ step, ok: false, reason }),
      ),
    );
  };
  const applyQueued = async ({ step, result }: QueuedProposal) => {
    await options.beforeApply?.(structuredClone(step));
    checkCancelled();
    if (hash(policy) !== policyHash)
      throw new DagReconciliationError(
        "Project policy changed before DAG patch validation",
      );
    const proposal = proposalSchema.parse(result.proposal);
    if (proposal.requests.length)
      throw new Error(
        `Step ${step.id} still requests source; its generation callback must resolve context requests before returning`,
      );
    const paths = [...new Set(proposal.changes.map((change) => change.path))];
    const scope = writeScope(step, options.writeScopes);
    if (
      paths.some((file, index) =>
        paths.slice(0, index).some((earlier) => pathsOverlap(earlier, file)),
      )
    )
      throw new Error(`Step ${step.id} has conflicting path aliases`);
    for (const file of paths) {
      await safePath(workspace, file, policy);
      if (scope && !scope(file))
        throw new Error(
          `Step ${step.id} writes outside its declared scope: ${file}`,
        );
      // Every applied step is a completed one; a step that is not one of its
      // ancestors may not write where it overlaps.
      for (const previous of checkpoint.completed) {
        if (
          !dag.ancestors.get(step.id)!.has(previous.id) &&
          previous.paths.some((prior) => pathsOverlap(prior, file))
        )
          throw new Error(
            `Independent DAG steps ${previous.id} and ${step.id} collide at ${file}; add an explicit dependency`,
          );
      }
    }
    // Validate every exact-substring precondition before this step's patch
    // is written.
    await prepareProposal(workspace, proposal, policy);
    await options.beforeApply?.(structuredClone(step));
    checkCancelled();
    if (hash(policy) !== policyHash)
      throw new DagReconciliationError(
        "Project policy changed before DAG patch application",
      );
    if (
      (await workspaceFingerprint(workspace, policy)) !==
      checkpoint.workspaceHash
    )
      throw new DagReconciliationError(
        "Workspace changed before serialized patch application",
        { workspaceState: true },
      );
    checkpoint.pending = {
      stepId: step.id,
      proposalHash: hash(proposal),
      beforeHash: checkpoint.workspaceHash,
      paths,
    };
    // A crash from this point is reconciliation-required: a resume matches
    // the workspace against the pre-patch and post-patch fingerprints.
    await save();
    const originals = await captureOriginals(workspace, paths, policy);
    let afterHash: string;
    try {
      await applyProposal(workspace, proposal, policy);
      afterHash = await workspaceFingerprint(workspace, policy);
      checkpoint.pending = { ...checkpoint.pending, afterHash };
      await save();
      // Evaluate after application too: this patch may itself change ignore
      // rules that hide a sibling's earlier output.
      await assertVerificationPaths(
        workspace,
        [...checkpointPaths(checkpoint), ...paths],
        policy,
      );
    } catch (error) {
      // Undo it, so the run stops cleanly at its pre-step state instead
      // of leaving a pending marker.
      await rollBack(checkpoint, originals, error, {
        workspace,
        policy,
        save,
        event,
      });
      throw new Error(
        `${(error as Error)?.message ?? String(error)} Step ${step.id}'s patch was rolled back; the workspace is at its pre-step state, and resuming with reconciliation acknowledgement runs the step again.`,
        { cause: error },
      );
    }
    checkpoint = {
      ...checkpoint,
      workspaceHash: afterHash,
      completed: [
        ...checkpoint.completed,
        {
          id: step.id,
          proposalHash: hash(proposal),
          paths,
          completedAt: now(),
        },
      ],
    };
    delete checkpoint.pending;
    await save();
    completed.add(step.id);
    appliedStepIds.push(step.id);
    await event("dag.step.completed", step.id, {
      paths,
      snapshotHash: checkpoint.workspaceHash,
    });
  };
  try {
    for (;;) {
      checkCancelled();
      if (hash(policy) !== policyHash)
        throw new DagReconciliationError(
          "Project policy changed during DAG execution",
        );
      if (!failure) {
        const ready = dag.steps.filter(
          (step) =>
            !started.has(step.id) &&
            step.dependsOn.every((id) => completed.has(id)),
        );
        for (const step of ready)
          if (!announced.has(step.id)) {
            announced.add(step.id);
            await event("dag.step.ready", step.id, { kind: step.kind });
          }
        const starting = ready.slice(
          0,
          Math.max(0, maxParallel - inflight.size),
        );
        if (starting.length) {
          const before = await workspaceFingerprint(workspace, policy);
          if (before !== checkpoint.workspaceHash)
            throw new DagReconciliationError(
              "Workspace changed outside the DAG scheduler",
              { workspaceState: true },
            );
          // All copies are taken here, before any apply can run.
          const made = await Promise.allSettled(
            starting.map(() =>
              createWorkspaceSnapshot(workspace, policy, before),
            ),
          );
          const refused = made.find((item) => item.status === "rejected");
          if (refused) {
            await Promise.allSettled(
              made.flatMap((item) =>
                item.status === "fulfilled" ? [item.value.dispose()] : [],
              ),
            );
            const reason = (refused as PromiseRejectedResult).reason;
            // The workspace changed between the check and the copy.
            if (reason instanceof SnapshotMismatchError)
              throw new DagReconciliationError(reason.message, {
                cause: reason,
                workspaceState: true,
              });
            throw reason;
          }
          starting.forEach((step, index) => {
            started.add(step.id);
            launch(
              step,
              before,
              (
                made[index] as PromiseFulfilledResult<
                  Awaited<ReturnType<typeof createWorkspaceSnapshot>>
                >
              ).value,
            );
          });
        }
      }
      if (queued.length) {
        const next = queued.reduce((least, item) =>
          order.get(item.step.id)! < order.get(least.step.id)! ? item : least,
        );
        queued.splice(queued.indexOf(next), 1);
        await applyQueued(next);
        continue;
      }
      if (!inflight.size) {
        if (!failure && completed.size < dag.steps.length)
          throw new Error("DAG has no runnable steps");
        break;
      }
      const outcome = await Promise.race(inflight.values());
      inflight.delete(outcome.step.id);
      checkCancelled();
      if (!outcome.ok) {
        failure ??= { error: outcome.reason };
        continue;
      }
      // Charge every fulfilled generation before any patch, even one whose
      // step will not apply.
      await options.onUsage?.(outcome.value.usage, outcome.step);
      checkCancelled();
      if (
        (await workspaceFingerprint(workspace, policy)) !==
        checkpoint.workspaceHash
      )
        throw new DagReconciliationError(
          "A proposal worker modified the workspace",
          { workspaceState: true },
        );
      queued.push({ step: outcome.step, result: outcome.value });
    }
  } catch (error) {
    failure ??= { error };
    if (error instanceof DagReconciliationError && error.workspaceState)
      workspaceError ??= error;
    // Cancel what is still generating: nothing from it can apply now.
    controller.abort();
    await Promise.allSettled(inflight.values());
  }
  // Whatever a generation's own cleanup could not remove. A failure here is
  // reported, never a reason to fail the run.
  const leftover = [...snapshots];
  snapshots.clear();
  const undisposed = (
    await Promise.allSettled(leftover.map((item) => item.dispose()))
  ).filter((item) => item.status === "rejected").length;
  if (undisposed)
    try {
      await event("dag.snapshot.cleanup_failed", undefined, {
        count: undisposed,
      });
    } catch {}
  if (workspaceError) throw workspaceError;
  if (failure) throw failure.error;
  return { checkpoint: structuredClone(checkpoint), appliedStepIds };
}

export interface RepairOptions {
  workspace: string;
  policy: ProjectPolicy;
  /** The plan's checkpoint, with every step completed. */
  checkpoint: DagCheckpoint;
  proposal: WorkerProposal;
  /** Must durably persist before resolving; JSON writes should use atomic rename. */
  saveCheckpoint: (checkpoint: DagCheckpoint) => Promise<void>;
  onEvent?: (event: DagEvent) => Promise<void> | void;
}
/**
 * Applies a repair patch to a plan's completed result with a step's crash
 * discipline. The patch is validated first, so a precondition failure
 * records nothing. A pending marker with the pre-patch fingerprint is saved
 * before any write and the post-patch fingerprint once the patch is on disk;
 * a failed application, or a patch that leaves any file the plan or repair
 * wrote outside the verification inventory, is rolled back; completion moves
 * the checkpoint to
 * the post-patch fingerprint and records the files in `repairPaths`. An
 * acknowledged resume reconciles an interrupted repair like a step.
 */
export async function applyRepair(
  options: RepairOptions,
): Promise<{ checkpoint: DagCheckpoint; paths: string[] }> {
  const { workspace, policy, proposal } = options;
  let checkpoint: DagCheckpoint = checkpointSchema.parse(options.checkpoint);
  if (checkpoint.pending)
    throw new DagReconciliationError(
      `Step ${checkpoint.pending.stepId} still has an unresolved patch application`,
    );
  await prepareProposal(workspace, proposal, policy);
  const paths = [...new Set(proposal.changes.map((change) => change.path))];
  if (!paths.length) return { checkpoint, paths };
  if (
    (await workspaceFingerprint(workspace, policy)) !== checkpoint.workspaceHash
  )
    throw new DagReconciliationError(
      "Workspace changed before the repair patch was applied",
    );
  const save = async () => options.saveCheckpoint(structuredClone(checkpoint));
  const originals = await captureOriginals(workspace, paths, policy);
  checkpoint.pending = {
    stepId: DAG_REPAIR_STEP,
    proposalHash: hash(proposal),
    beforeHash: checkpoint.workspaceHash,
    paths,
  };
  await save();
  let afterHash: string;
  try {
    await applyProposal(workspace, proposal, policy);
    afterHash = await workspaceFingerprint(workspace, policy);
    checkpoint.pending = { ...checkpoint.pending, afterHash };
    await save();
    // As for a step, and as reconciliation checks after a crash: a repair
    // must not create a Git-ignored file or hide an earlier step's output.
    await assertVerificationPaths(
      workspace,
      [...checkpointPaths(checkpoint), ...paths],
      policy,
    );
  } catch (error) {
    await rollBack(checkpoint, originals, error, {
      workspace,
      policy,
      save,
      event: (type, stepId, data) => options.onEvent?.({ type, stepId, data }),
    });
    throw new Error(
      `${(error as Error)?.message ?? String(error)} The repair patch was rolled back; the workspace is at its state before the repair.`,
      { cause: error },
    );
  }
  checkpoint = {
    ...checkpoint,
    workspaceHash: afterHash,
    repairPaths: withRepairPaths(checkpoint, paths),
  };
  delete checkpoint.pending;
  await save();
  return { checkpoint: structuredClone(checkpoint), paths };
}
function withRepairPaths(checkpoint: DagCheckpoint, paths: string[]) {
  return [...new Set([...(checkpoint.repairPaths ?? []), ...paths])];
}

/**
 * Undoes a patch that failed during or after application: restores each
 * file it touched, removes directories it created, confirms the pre-patch
 * fingerprint, clears the pending marker and records the rollback. If the
 * workspace cannot be restored, the marker stays and the run needs
 * reconciliation.
 */
async function rollBack(
  checkpoint: DagCheckpoint,
  originals: Originals,
  cause: unknown,
  context: {
    workspace: string;
    policy: ProjectPolicy;
    save: () => Promise<void>;
    event: (
      type: string,
      stepId: string | undefined,
      data: Record<string, unknown>,
    ) => Promise<void> | void;
  },
): Promise<void> {
  const pending = checkpoint.pending!;
  const reason = (cause as Error)?.message ?? String(cause);
  try {
    await restoreOriginals(originals);
    if (
      (await workspaceFingerprint(context.workspace, context.policy)) !==
      pending.beforeHash
    )
      throw new Error("the workspace does not match its pre-patch state");
    delete checkpoint.pending;
    await context.save();
  } catch (error) {
    throw new DagReconciliationError(
      `Step ${pending.stepId} failed after patch application (${reason}) and could not be rolled back (${(error as Error).message}); inspect the retained workspace, then resume with reconciliation acknowledgement or create a new plan`,
      { workspaceState: true },
    );
  }
  await context.event("dag.step.rolled_back", pending.stepId, {
    error: reason,
    paths: pending.paths,
  });
}
