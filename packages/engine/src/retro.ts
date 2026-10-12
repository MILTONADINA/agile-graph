import { createHash } from "node:crypto";
import type { RunEvent, RunRecord } from "@agile-graph/contracts";
import { classifyError, type ErrorKind } from "./feedback.js";

/**
 * Where one run's time went, in minutes from its event timestamps. Active
 * phases are paired start and finish events; `stopped` is the time between
 * a stop and the next resume; `waiting` is the rest (queues, context,
 * patching and anything not yet paired).
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

/** One run's delivery record: counts, minutes, kinds and its ID only. */
export interface RunRetro {
  runId: string;
  status: RunRecord["status"];
  createdAt: string;
  minutes: RetroMinutes;
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
  stopKinds: ErrorKind[];
}

export interface RetroSummary {
  runs: number;
  byStatus: Record<string, number>;
  minutes: RetroMinutes & { medianPerRun: number };
  attempts: number;
  verifications: number;
  repeatedFailures: number;
  unchangedReverifications: number;
  firstPassVerification: { passed: number; reached: number };
  stopKinds: Record<string, number>;
  perRun: RunRetro[];
}

const PHASES = {
  "worker.dispatched": ["worker", "worker.completed"],
  "verification.started": ["verification", "verification.completed"],
  "review.started": ["review", "review.completed"],
  "security.scan_started": ["security", "security.scan_completed"],
} as const;
type Phase = (typeof PHASES)[keyof typeof PHASES][0];
const CLOSERS = new Map<string, Phase>(
  Object.values(PHASES).map(([phase, closer]) => [closer, phase]),
);
const ENDS = new Set(["run.succeeded", "run.stopped"]);

const minutesBetween = (from: string, to: string) =>
  Math.max(0, Date.parse(to) - Date.parse(from)) / 60_000;
const round = (minutes: number) => Math.round(minutes * 10) / 10;

interface CheckResult {
  checkId?: unknown;
  argv?: unknown;
  code?: unknown;
}

/**
 * A verification's failure signature: its failing checks and their exit
 * codes, hashed. Output is never part of it. Null when every check passed.
 */
function failureSignature(checks: unknown): string | null {
  if (!Array.isArray(checks)) return null;
  const failed = (checks as CheckResult[])
    .filter((check) => check.code !== 0)
    .map((check) => [
      typeof check.checkId === "string"
        ? check.checkId
        : JSON.stringify(check.argv ?? null),
      check.code,
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
): RunRetro {
  const ordered = [...events].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  const lastEnd = ordered.findLastIndex((event) => ENDS.has(event.type));
  const inRun = lastEnd < 0 ? ordered : ordered.slice(0, lastEnd + 1);
  const minutes: RetroMinutes = {
    total: 0,
    worker: 0,
    verification: 0,
    review: 0,
    security: 0,
    stopped: 0,
    waiting: 0,
  };
  const open = new Map<Phase, string>();
  let stoppedAt: string | undefined;
  let attempts = 0;
  let verifications = 0;
  let repeatedFailures = 0;
  let unchangedReverifications = 0;
  // Per step, the snapshot and failure signature of its last verification.
  const lastSnapshot = new Map<string, string>();
  const lastSignature = new Map<string, string | null>();
  let firstVerificationPassed: boolean | null = null;
  const stopKinds: ErrorKind[] = [];
  for (const event of inRun) {
    const opens = PHASES[event.type as keyof typeof PHASES];
    if (opens) open.set(opens[0], event.at);
    const closes = CLOSERS.get(event.type);
    if (closes && open.has(closes)) {
      minutes[closes] += minutesBetween(open.get(closes)!, event.at);
      open.delete(closes);
    }
    if (event.type === "run.started" && stoppedAt) {
      minutes.stopped += minutesBetween(stoppedAt, event.at);
      stoppedAt = undefined;
    }
    if (event.type === "run.stopped") {
      // A stop ends every open phase; time stopped is not phase time.
      for (const [phase, since] of open)
        minutes[phase] += minutesBetween(since, event.at);
      open.clear();
      stoppedAt = event.at;
      if (typeof event.data.error === "string")
        stopKinds.push(classifyError(event.data.error));
    }
    if (event.type === "attempt.started") attempts++;
    const step = event.stepId ?? "";
    if (event.type === "verification.started") {
      verifications++;
      const snapshot = event.data.snapshotHash;
      if (typeof snapshot === "string") {
        if (lastSnapshot.get(step) === snapshot) unchangedReverifications++;
        lastSnapshot.set(step, snapshot);
      }
    }
    if (event.type === "verification.completed") {
      const signature = failureSignature(event.data.checks);
      if (firstVerificationPassed === null)
        firstVerificationPassed = signature === null;
      if (signature && lastSignature.get(step) === signature)
        repeatedFailures++;
      lastSignature.set(step, signature);
    }
  }
  if (inRun.length > 1)
    minutes.total = minutesBetween(inRun[0]!.at, inRun.at(-1)!.at);
  const active =
    minutes.worker +
    minutes.verification +
    minutes.review +
    minutes.security +
    minutes.stopped;
  minutes.waiting = Math.max(0, minutes.total - active);
  return {
    runId: run.id,
    status: run.status,
    createdAt: run.createdAt,
    minutes: Object.fromEntries(
      Object.entries(minutes).map(([key, value]) => [key, round(value)]),
    ) as unknown as RetroMinutes,
    attempts,
    verifications,
    repeatedFailures,
    unchangedReverifications,
    firstVerificationPassed,
    stopKinds,
  };
}

/** Total run retros, optionally only runs created on or after `since`. */
export function summarizeRetro(
  retros: readonly RunRetro[],
  options: { since?: string } = {},
): RetroSummary {
  const since = options.since ? Date.parse(options.since) : undefined;
  if (since !== undefined && Number.isNaN(since))
    throw new Error("--since must be an ISO 8601 date or time");
  const perRun = retros.filter(
    (retro) => since === undefined || Date.parse(retro.createdAt) >= since,
  );
  const sum = (pick: (retro: RunRetro) => number) =>
    round(perRun.reduce((total, retro) => total + pick(retro), 0));
  const totals = perRun
    .map((retro) => retro.minutes.total)
    .sort((a, b) => a - b);
  const middle = Math.floor(totals.length / 2);
  const median = !totals.length
    ? 0
    : totals.length % 2
      ? totals[middle]!
      : (totals[middle - 1]! + totals[middle]!) / 2;
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
    firstPassVerification: {
      passed: perRun.filter((retro) => retro.firstVerificationPassed === true)
        .length,
      reached: perRun.filter((retro) => retro.firstVerificationPassed !== null)
        .length,
    },
    stopKinds: count(perRun.flatMap((retro) => retro.stopKinds)),
    perRun,
  };
}
