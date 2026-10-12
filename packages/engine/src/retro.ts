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

/** One run's delivery record: counts, minutes, kinds and its ID only. */
export interface RunRetro {
  runId: string;
  status: RunRecord["status"];
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
  // A multi-step plan's steps: open until the step's worker completes or,
  // for a generator step, until the step is applied.
  "dag.step.started": ["worker", "dag.step.completed"],
  "verification.started": ["verification", "verification.completed"],
  "review.started": ["review", "review.completed"],
  "attempt.repeat_decision_started": ["review", "attempt.repeat_decision"],
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
  // Open spans by phase and step, in the order they opened.
  const open = new Map<string, { phase: Phase; start: number }>();
  const close = (key: string, at: number) => {
    const span = open.get(key)!;
    spans[span.phase].push([span.start, at]);
    open.delete(key);
  };
  let stoppedAt: number | undefined;
  let attempts = 0;
  let verifications = 0;
  let repeatedFailures = 0;
  let unchangedReverifications = 0;
  // Per step, the snapshot and failure signature of its last verification.
  const lastSnapshot = new Map<string, string>();
  const lastSignature = new Map<string, string | null>();
  let firstVerificationPassed: boolean | null = null;
  let firstVerificationOpen = false;
  const stopKinds: ErrorKind[] = [];
  for (const event of inRun) {
    const at = Date.parse(event.at);
    const step = event.stepId ?? "";
    const opens = PHASES[event.type as keyof typeof PHASES];
    if (opens) {
      const key = `${opens[0]}\u0000${step}`;
      // A new start for a step whose span is still open ends that span.
      if (open.has(key)) close(key, at);
      open.set(key, { phase: opens[0], start: at });
    }
    const closes = CLOSERS.get(event.type);
    if (closes) {
      const key = `${closes}\u0000${step}`;
      // A finish without the start's step closes that phase's latest span.
      const latest = [...open]
        .filter(([, span]) => span.phase === closes)
        .at(-1)?.[0];
      const match = open.has(key) ? key : step ? undefined : latest;
      if (match) close(match, at);
    }
    if (event.type === "run.started" && stoppedAt !== undefined) {
      spans.stopped.push([stoppedAt, at]);
      stoppedAt = undefined;
    }
    if (event.type === "run.stopped") {
      // A stop ends every open span; time stopped is not phase time.
      for (const key of [...open.keys()]) close(key, at);
      stoppedAt = at;
      if (typeof event.data.error === "string")
        stopKinds.push(classifyError(event.data.error));
    }
    if (event.type === "attempt.started") attempts++;
    // A multi-step plan's first worker attempts start as steps.
    if (
      event.type === "dag.step.started" &&
      typeof event.data.providerId === "string"
    )
      attempts++;
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
    stopKinds,
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

/** Total run retros. */
export function summarizeRetro(retros: readonly RunRetro[]): RetroSummary {
  const perRun = [...retros];
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
