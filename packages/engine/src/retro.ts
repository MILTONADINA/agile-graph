import { createHash } from "node:crypto";
import type { RunEvent, RunRecord } from "@agile-graph/contracts";
import { classifyError, type ErrorKind } from "./feedback.js";

/**
 * Where one run's time went, in minutes from its event timestamps. A phase
 * is the wall-clock time at least one of its spans (a start event paired
 * with the same step's finish) was open, so concurrent DAG steps are not
 * counted twice; `stopped` is the time between a stop and the next resume;
 * `waiting` is the time no phase was open and the run was not stopped
 * (queues, context, patching and anything not paired).
 */
export interface RetroMinutes {
  total: number;
  worker: number;
  verification: number;
  review: number;
  security: number;
  stopped: number;
  waiting: number;
}

/**
 * Why a next step needs the person: approval, credential, spending or a
 * decision only the person can make. A closed set; anything else is the
 * graph's to schedule.
 */
export const PERSON_REASONS = [
  "approval",
  "credential",
  "spending",
  "decision",
] as const;
export type PersonReason = (typeof PERSON_REASONS)[number];

export function isPersonReason(value: unknown): value is PersonReason {
  return (PERSON_REASONS as readonly unknown[]).includes(value);
}

/**
 * Who a stop belongs to: a person reason, or `graph` for a defect the graph
 * can fix itself and should schedule as its own follow-up. A new stop kind
 * fails to compile until it is classified here.
 */
export type StopOwner = PersonReason | "graph";

export const STOP_OWNERS = {
  "plan-approval": "approval",
  "policy-changed": "approval",
  "worker-unavailable": "credential",
  "cost-cap": "spending",
  "live-scan": "decision",
  "workspace-reconciliation": "decision",
  configuration: "decision",
  "worker-no-progress": "graph",
  "repeated-failure": "graph",
  "checks-failed": "graph",
  "verification-infrastructure": "graph",
  "security-gate": "graph",
  "review-gate": "graph",
  scope: "graph",
  "missing-file": "graph",
  "patch-secret": "graph",
  aborted: "graph",
  "context-budget": "graph",
  "patch-rejected": "graph",
  "index-limit": "graph",
  "repeated-review-finding": "graph",
  "provider-call": "graph",
  unknown: "graph",
} as const satisfies Record<ErrorKind, StopOwner>;

/** Events where a run waits for a person, with the reason. */
export const HUMAN_WAIT_REASONS = {
  "acceptance.pending_review": "decision",
} as const satisfies Record<string, PersonReason>;

/**
 * The gates a re-check cycle can repeat: a verification, review or security
 * scan of the same step that already ran once in this run.
 */
export type RecheckPhase = "verification" | "review" | "security";

/** One completed re-check cycle and its wall-clock minutes. */
export interface RecheckCycle {
  phase: RecheckPhase;
  minutes: number;
}

/**
 * How long one multi-step plan step was ready but not started: its kind and
 * minutes only, never its ID or content. Zero when a slot was free at once.
 */
export interface StepWait {
  kind: "worker" | "generator";
  minutes: number;
}

/** One run's delivery record: counts, minutes, kinds and its ID only. */
export interface RunRetro {
  runId: string;
  status: RunRecord["status"];
  minutes: RetroMinutes;
  /**
   * Re-check cycles started: a verification, review or security scan of a
   * step that an earlier scan of the same phase in this run already covered
   * (the same gate, run again after a change or a repeated decision). Absent
   * in records made before these fields existed.
   */
  recheckCycles?: number;
  /**
   * Each re-check cycle that finished, in order, with its minutes. A cycle
   * a stop or a resume cut short is counted above but has no minutes here.
   */
  recheckMinutes?: RecheckCycle[];
  /** Minutes of this run's finished re-check cycles, summed. */
  recheckTotalMinutes?: number;
  /** Median minutes per finished re-check cycle of this run; zero for none. */
  recheckMedianMinutes?: number;
  /**
   * Each multi-step plan step's wait, from becoming ready (its dependencies
   * applied) to starting, in start order. Empty for runs without steps.
   */
  stepWaits?: StepWait[];
  /**
   * Each step that waited on a setup step (the configured tester), from its
   * blocked announcement to becoming ready, in ready order: kind and minutes
   * only. A stop ends a wait without counting it.
   */
  setupWaits?: StepWait[];
  /** Minutes of this run's setup waits, summed. */
  setupWaitTotalMinutes?: number;
  /** Median minutes per setup wait of this run; zero for none. */
  setupWaitMedianMinutes?: number;
  /** Minutes of this run's step waits, summed. */
  stepWaitTotalMinutes?: number;
  /** Median minutes per step wait of this run; zero for none. */
  stepWaitMedianMinutes?: number;
  /** Worker attempts started, counting the attempts of each resume. */
  attempts: number;
  verifications: number;
  /**
   * Verifications whose checks failed exactly as the step's previous
   * verification did: the change in between did not fix the failure.
   */
  repeatedFailures: number;
  /**
   * Verifications of the same snapshot as the step's previous verification:
   * checks run again on unchanged work.
   */
  unchangedReverifications: number;
  /** Whether the run's first verification passed; null when it had none. */
  firstVerificationPassed: boolean | null;
  /** Lessons this run proposed after a repeated failure. */
  lessonsProposed: number;
  /** Times an accepted lesson was shown to this run's worker. */
  lessonsApplied: number;
  stopKinds: ErrorKind[];
  /**
   * Stops and human-acceptance waits routed to the person, and their count
   * per reason. Absent in records made before these fields existed.
   */
  deferredToPerson?: number;
  deferredByReason?: Partial<Record<PersonReason, number>>;
  /** Stops the graph could have scheduled as its own follow-up work. */
  graphOwnedStops?: number;
  /**
   * 1 when the run's terminal stop is graph-owned and no follow-up plan
   * names the run, else 0. Absent in records made before this field existed
   * and when no follow-up set was given.
   */
  graphOwnedWithoutFollowUp?: number;
}

export interface RetroSummary {
  runs: number;
  byStatus: Record<string, number>;
  minutes: RetroMinutes & { medianPerRun: number };
  attempts: number;
  verifications: number;
  repeatedFailures: number;
  unchangedReverifications: number;
  lessonsProposed: number;
  lessonsApplied: number;
  firstPassVerification: { passed: number; reached: number };
  stopKinds: Record<string, number>;
  deferredToPerson: number;
  deferredByReason: Partial<Record<PersonReason, number>>;
  graphOwnedStops: number;
  graphOwnedWithoutFollowUp: number;
  recheck: {
    cycles: number;
    /** Minutes of the re-check cycles that finished. */
    minutes: number;
    medianPerCycle: number;
  };
  /** Multi-step plan steps' waits to start, across the runs. */
  stepWait: { steps: number; minutes: number; medianPerStep: number };
  /** Product steps' waits on a setup step, across the runs. */
  setupWait: { steps: number; minutes: number; medianPerStep: number };
  /** The estimates the caller supplied, each stated as its text. */
  estimates: string[];
  perRun: RunRetro[];
}

/**
 * A time or effort estimate, stated as what is true once its step elapses.
 * It never reads as readiness while steps remain: the text always names the
 * steps still left before the goal.
 */
export interface StepEstimate {
  /** What is true when the step this estimate covers has elapsed. */
  stateAfterStep: string;
  /** Steps still needed after that step; a whole number, zero or more. */
  stepsRemaining: number;
  /** The goal those steps lead to, named in the text. */
  goal: string;
}

/** The estimate as the report prints it; refuses an estimate it cannot state. */
export function stepEstimateText(estimate: StepEstimate): string {
  const { stateAfterStep, stepsRemaining, goal } = estimate;
  if (!stateAfterStep.trim() || !goal.trim())
    throw new Error("An estimate needs its state and its goal");
  if (!Number.isInteger(stepsRemaining) || stepsRemaining < 0)
    throw new Error("An estimate's remaining steps must be a whole number");
  return `${stateAfterStep.trim()}. after this step: ${stepsRemaining} steps remain before ${goal.trim()}`;
}

const PHASES = {
  "worker.dispatched": ["worker", "worker.completed"],
  // A multi-step plan's steps: open until the step's worker completes or,
  // for a generator step, until the step is applied.
  "dag.step.started": ["worker", "dag.step.completed"],
  "verification.started": ["verification", "verification.completed"],
  "review.started": ["review", "review.completed"],
  "attempt.repeat_decision_started": ["review", "attempt.repeat_decision"],
  "security.scan_started": ["security", "security.scan_completed"],
} as const;
type Phase = (typeof PHASES)[keyof typeof PHASES][0];
// Spans are keyed by their opening event, so a repeat decision (which shares
// the review phase's minutes) never closes or re-opens a review re-check.
const CLOSERS = new Map<string, keyof typeof PHASES>(
  Object.entries(PHASES).map(([opener, [, closer]]) => [
    closer,
    opener as keyof typeof PHASES,
  ]),
);
const ENDS = new Set(["run.succeeded", "run.stopped"]);

// The scans a re-check cycle can repeat. A repeat decision is not one.
const RECHECK_OPENERS = new Set<string>([
  "verification.started",
  "review.started",
  "security.scan_started",
]);

const isRecheckPhase = (phase: Phase): phase is RecheckPhase =>
  phase === "verification" || phase === "review" || phase === "security";

/**
 * The owner a stop kind routes to. A kind the table does not classify, or a
 * value that is neither a person reason nor `graph`, is the graph's.
 */
function ownerOf(kind: string): StopOwner {
  const owner: unknown = Object.hasOwn(STOP_OWNERS, kind)
    ? (STOP_OWNERS as Record<string, unknown>)[kind]
    : undefined;
  return isPersonReason(owner) || owner === "graph" ? owner : "graph";
}

/** The median of the values; zero for none. Shared by runs and totals. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return 0;
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Total and median minutes of re-check cycles; the same for a run or all runs. */
function recheckTotals(minutes: readonly number[]): {
  total: number;
  median: number;
} {
  return {
    total: minutes.reduce((total, value) => total + value, 0),
    median: medianOf(minutes),
  };
}

const minutesBetween = (from: string, to: string) =>
  Math.max(0, Date.parse(to) - Date.parse(from)) / 60_000;
const round = (minutes: number) => Math.round(minutes * 10) / 10;

type Span = [start: number, end: number];
/** Minutes covered by at least one span. */
function unionMinutes(spans: readonly Span[]): number {
  let covered = 0;
  let end = -Infinity;
  for (const [start, stop] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (stop <= end) continue;
    covered += stop - Math.max(start, end);
    end = stop;
  }
  return covered / 60_000;
}

interface CheckResult {
  checkId?: unknown;
  argv?: unknown;
  image?: unknown;
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

/**
 * The part of a check's output that says how it failed: its last 40
 * non-empty lines, without colour codes, durations, timestamps, temporary
 * paths or long hexadecimal IDs, which differ between identical failures.
 */
export function outputTail(stdout: unknown, stderr: unknown): string {
  // Lines are cut before any pattern runs, so no pattern ever sees more
  // than 40 lines of 500 characters, whatever the check printed.
  return [stdout, stderr]
    .map((text) => (typeof text === "string" ? text : ""))
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean)
    .slice(-40)
    .map((line) =>
      line
        .slice(0, 500)
        .replace(
          /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g,
          "<time>",
        )
        .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds|m|min)\b/g, "<duration>")
        .replace(
          /(\/private)?\/(tmp|var\/folders)\/[^\s'"`]+|[A-Za-z]:\\[^\s'"`]*\\Temp\\[^\s'"`]+/g,
          "<tmp>",
        )
        .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>"),
    )
    .join("\n");
}

/**
 * A verification's failure signature: each failing check, its exit code and
 * its output tail (see outputTail), hashed and truncated so the output can
 * never be read back from it. Most test runners exit 1 for any failure, so
 * the tail is what tells two failures apart. Null when every check passed.
 */
export function failureSignature(checks: unknown): string | null {
  if (!Array.isArray(checks)) return null;
  const failed = (checks as CheckResult[])
    .filter((check) => check.code !== 0)
    .map((check) => [
      // An unnamed check is its command in its image.
      typeof check.checkId === "string"
        ? check.checkId
        : JSON.stringify([check.argv ?? null, check.image ?? null]),
      check.code,
      outputTail(check.stdout, check.stderr),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!failed.length) return null;
  return createHash("sha256")
    .update(JSON.stringify(failed))
    .digest("hex")
    .slice(0, 12);
}

/** Read one run's events into its retro record, oldest event first. */
export function runRetro(
  run: RunRecord,
  events: readonly RunEvent[],
  options: {
    /** IDs of runs that follow-up plans name; keeps this function pure. */
    followUps?: ReadonlySet<string>;
  } = {},
): RunRetro {
  const ordered = [...events].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  const lastEnd = ordered.findLastIndex((event) => ENDS.has(event.type));
  const inRun = lastEnd < 0 ? ordered : ordered.slice(0, lastEnd + 1);
  const spans: Record<Phase | "stopped", Span[]> = {
    worker: [],
    verification: [],
    review: [],
    security: [],
    stopped: [],
  };
  // Open spans by opening event and step, in the order they opened.
  const open = new Map<
    string,
    {
      opener: keyof typeof PHASES;
      phase: Phase;
      start: number;
      recheck: boolean;
    }
  >();
  // Opening event and step keys a span has already opened in this run.
  const opened = new Set<string>();
  const recheckMinutes: RecheckCycle[] = [];
  // Steps ready and not yet started, by ID, with their kind and when they became ready.
  const readySteps = new Map<string, { kind: StepWait["kind"]; at: number }>();
  const stepWaits: StepWait[] = [];
  // Steps blocked on an unapplied setup step, by ID and in memory only.
  const blockedSteps = new Map<
    string,
    { kind: StepWait["kind"]; at: number }
  >();
  const setupWaits: StepWait[] = [];
  let recheckCycles = 0;
  // Only a span its finish event closed counts as a finished cycle.
  const close = (key: string, at: number, completed: boolean) => {
    const span = open.get(key)!;
    spans[span.phase].push([span.start, at]);
    if (completed && span.recheck && isRecheckPhase(span.phase))
      recheckMinutes.push({
        phase: span.phase,
        minutes: (at - span.start) / 60_000,
      });
    open.delete(key);
  };
  let stoppedAt: number | undefined;
  let attempts = 0;
  let lessonsProposed = 0;
  let lessonsApplied = 0;
  let verifications = 0;
  let repeatedFailures = 0;
  let unchangedReverifications = 0;
  // Per step, the snapshot and failure signature of its last verification.
  const lastSnapshot = new Map<string, string>();
  const lastSignature = new Map<string, string | null>();
  let firstVerificationPassed: boolean | null = null;
  let firstVerificationOpen = false;
  const stopKinds: ErrorKind[] = [];
  const deferredByReason: Partial<Record<PersonReason, number>> = {};
  let graphOwnedStops = 0;
  let terminalOwner: StopOwner | undefined;
  let humanWait: StopOwner | undefined;
  const route = (owner: StopOwner) => {
    if (owner === "graph") graphOwnedStops++;
    else deferredByReason[owner] = (deferredByReason[owner] ?? 0) + 1;
  };
  for (const event of inRun) {
    const at = Date.parse(event.at);
    const step = event.stepId ?? "";
    const opens = PHASES[event.type as keyof typeof PHASES];
    if (opens) {
      const key = `${event.type}\u0000${step}`;
      // A new start for a step whose span is still open ends that span.
      if (open.has(key)) close(key, at, false);
      const recheck = RECHECK_OPENERS.has(event.type) && opened.has(key);
      opened.add(key);
      if (recheck) recheckCycles++;
      open.set(key, {
        opener: event.type as keyof typeof PHASES,
        phase: opens[0],
        start: at,
        recheck,
      });
    }
    const closes = CLOSERS.get(event.type);
    if (closes) {
      const key = `${closes}\u0000${step}`;
      // A finish without the start's step closes that opener's latest span.
      const latest = [...open]
        .filter(([, span]) => span.opener === closes)
        .at(-1)?.[0];
      const match = open.has(key) ? key : step ? undefined : latest;
      if (match) close(match, at, true);
    }
    if (event.type === "run.started" && stoppedAt !== undefined) {
      spans.stopped.push([stoppedAt, at]);
      stoppedAt = undefined;
    }
    if (event.type === "run.stopped") {
      // A stop ends every open span; time stopped is not phase time.
      for (const key of [...open.keys()]) close(key, at, false);
      // A first verification the stop interrupted stays reached and failed.
      firstVerificationOpen = false;
      stoppedAt = at;
      // A stop with no reason is the graph's to explain and schedule.
      const kind =
        typeof event.data.error === "string"
          ? classifyError(event.data.error)
          : "unknown";
      stopKinds.push(kind);
      const owner = ownerOf(kind);
      route(owner);
      terminalOwner = owner;
    }
    // The wait is recorded before the final gates and publication, so it
    // only counts once the run went on to succeed (below), and once.
    const waitReason =
      HUMAN_WAIT_REASONS[event.type as keyof typeof HUMAN_WAIT_REASONS];
    if (waitReason)
      humanWait = isPersonReason(waitReason) ? waitReason : "graph";
    if (event.type === "attempt.started") attempts++;
    // A step is ready once its dependencies applied; its wait ends when it
    // starts. Only the step's kind and minutes are kept. A stop ends every
    // open wait, and a resumed run announces its ready steps again, so time
    // stopped is never counted as wait.
    if (event.type === "run.stopped") {
      readySteps.clear();
      blockedSteps.clear();
    }
    if (
      event.type === "dag.step.blocked" &&
      step &&
      event.data.waitingOnSetup === true &&
      (event.data.kind === "worker" || event.data.kind === "generator")
    )
      blockedSteps.set(step, { kind: event.data.kind, at });
    if (event.type === "dag.step.ready" && blockedSteps.has(step)) {
      const blocked = blockedSteps.get(step)!;
      blockedSteps.delete(step);
      setupWaits.push({
        kind: blocked.kind,
        minutes: round(Math.max(0, at - blocked.at) / 60_000),
      });
    }
    if (event.type === "dag.step.failed" || event.type === "dag.step.skipped") {
      readySteps.delete(step);
      blockedSteps.delete(step);
    }
    if (
      event.type === "dag.step.ready" &&
      step &&
      (event.data.kind === "worker" || event.data.kind === "generator")
    )
      readySteps.set(step, { kind: event.data.kind, at });
    if (event.type === "dag.step.started" && readySteps.has(step)) {
      const ready = readySteps.get(step)!;
      readySteps.delete(step);
      stepWaits.push({
        kind: ready.kind,
        minutes: round(Math.max(0, at - ready.at) / 60_000),
      });
    }
    // A multi-step plan's first worker attempts start as steps.
    if (
      event.type === "dag.step.started" &&
      typeof event.data.providerId === "string"
    )
      attempts++;
    if (event.type === "lesson.proposed") lessonsProposed++;
    if (event.type === "lesson.applied") lessonsApplied++;
    if (event.type === "verification.started") {
      verifications++;
      // Reaching a first verification counts even if it never finishes.
      if (firstVerificationPassed === null) {
        firstVerificationPassed = false;
        firstVerificationOpen = true;
      }
      const snapshot = event.data.snapshotHash;
      if (typeof snapshot === "string") {
        if (lastSnapshot.get(step) === snapshot) unchangedReverifications++;
        lastSnapshot.set(step, snapshot);
      }
    }
    if (event.type === "verification.completed") {
      const signature = failureSignature(event.data.checks);
      if (firstVerificationOpen) {
        firstVerificationPassed = signature === null;
        firstVerificationOpen = false;
      }
      if (signature && lastSignature.get(step) === signature)
        repeatedFailures++;
      lastSignature.set(step, signature);
    }
  }
  // Only a stop the run ended on is terminal; a resumed run's was not.
  // A resume after it, even one still running, means the run moved on.
  const endedStopped =
    inRun.at(-1)?.type === "run.stopped" &&
    !ordered.slice(inRun.length).some((e) => e.type === "run.started");
  if (humanWait && inRun.at(-1)?.type === "run.succeeded") route(humanWait);
  const cycles: RecheckCycle[] = recheckMinutes.map(({ phase, minutes }) => ({
    phase,
    minutes: round(minutes),
  }));
  const minutes: RetroMinutes = {
    total:
      inRun.length > 1 ? minutesBetween(inRun[0]!.at, inRun.at(-1)!.at) : 0,
    worker: unionMinutes(spans.worker),
    verification: unionMinutes(spans.verification),
    review: unionMinutes(spans.review),
    security: unionMinutes(spans.security),
    stopped: unionMinutes(spans.stopped),
    waiting: 0,
  };
  minutes.waiting = Math.max(
    0,
    minutes.total - unionMinutes(Object.values(spans).flat()),
  );
  const cycleTotals = recheckTotals(cycles.map((cycle) => cycle.minutes));
  return {
    runId: run.id,
    status: run.status,
    minutes: Object.fromEntries(
      Object.entries(minutes).map(([key, value]) => [key, round(value)]),
    ) as unknown as RetroMinutes,
    attempts,
    verifications,
    repeatedFailures,
    unchangedReverifications,
    firstVerificationPassed,
    lessonsProposed,
    lessonsApplied,
    stopKinds,
    recheckCycles,
    recheckMinutes: cycles,
    recheckTotalMinutes: round(cycleTotals.total),
    recheckMedianMinutes: round(cycleTotals.median),
    stepWaits,
    stepWaitTotalMinutes: round(
      stepWaits.reduce((total, wait) => total + wait.minutes, 0),
    ),
    stepWaitMedianMinutes: round(
      medianOf(stepWaits.map((wait) => wait.minutes)),
    ),
    setupWaits,
    setupWaitTotalMinutes: round(
      setupWaits.reduce((total, wait) => total + wait.minutes, 0),
    ),
    setupWaitMedianMinutes: round(
      medianOf(setupWaits.map((wait) => wait.minutes)),
    ),
    deferredToPerson: Object.values(deferredByReason).reduce(
      (total, n) => total + n,
      0,
    ),
    deferredByReason,
    graphOwnedStops,
    ...(options.followUps && {
      graphOwnedWithoutFollowUp:
        endedStopped &&
        terminalOwner === "graph" &&
        !options.followUps.has(run.id)
          ? 1
          : 0,
    }),
  };
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
/** The instant an ISO 8601 date or date-time names; undefined for any other
 * text or an impossible calendar date such as 2026-02-30. */
function isoInstant(text: string): number | undefined {
  const match = ISO.exec(text);
  if (!match) return undefined;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const calendar = new Date(Date.UTC(+year!, +month! - 1, +day!));
  if (
    calendar.getUTCFullYear() !== +year! ||
    calendar.getUTCMonth() !== +month! - 1 ||
    calendar.getUTCDate() !== +day! ||
    +hour > 23 ||
    +minute > 59 ||
    +second > 59
  )
    return undefined;
  const instant = Date.parse(text);
  return Number.isNaN(instant) ? undefined : instant;
}

/** Runs created on or after `since` (every run without it). */
export function runsCreatedSince<Run extends { createdAt: string }>(
  runs: readonly Run[],
  since?: string,
): Run[] {
  if (since === undefined) return [...runs];
  const from = isoInstant(since);
  if (from === undefined)
    throw new Error("--since must be an ISO 8601 date or time");
  return runs.filter((run) => Date.parse(run.createdAt) >= from);
}

/** Total run retros; `estimates` are stated, checked and printed as given. */
export function summarizeRetro(
  retros: readonly RunRetro[],
  options: { estimates?: readonly StepEstimate[] } = {},
): RetroSummary {
  const perRun = [...retros];
  const sum = (pick: (retro: RunRetro) => number) =>
    round(perRun.reduce((total, retro) => total + pick(retro), 0));
  const median = medianOf(perRun.map((retro) => retro.minutes.total));
  const cycleTotals = recheckTotals(
    perRun.flatMap((retro) => retro.recheckMinutes ?? []).map((c) => c.minutes),
  );
  const count = (values: string[]) =>
    values.reduce<Record<string, number>>(
      (counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }),
      {},
    );
  return {
    runs: perRun.length,
    byStatus: count(perRun.map((retro) => retro.status)),
    minutes: {
      total: sum((retro) => retro.minutes.total),
      worker: sum((retro) => retro.minutes.worker),
      verification: sum((retro) => retro.minutes.verification),
      review: sum((retro) => retro.minutes.review),
      security: sum((retro) => retro.minutes.security),
      stopped: sum((retro) => retro.minutes.stopped),
      waiting: sum((retro) => retro.minutes.waiting),
      medianPerRun: round(median),
    },
    attempts: sum((retro) => retro.attempts),
    verifications: sum((retro) => retro.verifications),
    repeatedFailures: sum((retro) => retro.repeatedFailures),
    unchangedReverifications: sum((retro) => retro.unchangedReverifications),
    lessonsProposed: sum((retro) => retro.lessonsProposed),
    lessonsApplied: sum((retro) => retro.lessonsApplied),
    firstPassVerification: {
      passed: perRun.filter((retro) => retro.firstVerificationPassed === true)
        .length,
      reached: perRun.filter((retro) => retro.firstVerificationPassed !== null)
        .length,
    },
    stopKinds: count(perRun.flatMap((retro) => retro.stopKinds)),
    deferredToPerson: sum((retro) => retro.deferredToPerson ?? 0),
    deferredByReason: perRun.reduce<Partial<Record<PersonReason, number>>>(
      (counts, retro) => {
        for (const [reason, n] of Object.entries(
          retro.deferredByReason ?? {},
        ) as [PersonReason, number][])
          counts[reason] = (counts[reason] ?? 0) + n;
        return counts;
      },
      {},
    ),
    graphOwnedStops: sum((retro) => retro.graphOwnedStops ?? 0),
    graphOwnedWithoutFollowUp: sum(
      (retro) => retro.graphOwnedWithoutFollowUp ?? 0,
    ),
    recheck: {
      cycles: sum((retro) => retro.recheckCycles ?? 0),
      minutes: round(cycleTotals.total),
      medianPerCycle: round(cycleTotals.median),
    },
    stepWait: {
      steps: perRun.reduce(
        (total, retro) => total + (retro.stepWaits?.length ?? 0),
        0,
      ),
      minutes: sum((retro) => retro.stepWaitTotalMinutes ?? 0),
      medianPerStep: round(
        medianOf(
          perRun.flatMap((retro) =>
            (retro.stepWaits ?? []).map((wait) => wait.minutes),
          ),
        ),
      ),
    },
    setupWait: {
      steps: perRun.reduce(
        (total, retro) => total + (retro.setupWaits?.length ?? 0),
        0,
      ),
      minutes: sum((retro) => retro.setupWaitTotalMinutes ?? 0),
      medianPerStep: round(
        medianOf(
          perRun.flatMap((retro) =>
            (retro.setupWaits ?? []).map((wait) => wait.minutes),
          ),
        ),
      ),
    },
    estimates: (options.estimates ?? []).map(stepEstimateText),
    perRun,
  };
}
