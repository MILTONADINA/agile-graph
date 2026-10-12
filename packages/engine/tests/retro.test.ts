import { describe, expect, it } from "vitest";
import type { RunEvent, RunRecord } from "@agile-graph/contracts";
import { SCHEMA_VERSION } from "@agile-graph/contracts";
import { classifyError } from "../src/feedback.js";
import { runRetro, summarizeRetro } from "../src/retro.js";

const SENTINEL = "zq-private-marker";
const START = Date.parse("2026-10-01T00:00:00.000Z");

/** An event `minute` minutes after the start of the day. */
function event(
  minute: number,
  type: string,
  data: Record<string, unknown> = {},
): RunEvent {
  return {
    version: SCHEMA_VERSION,
    id: `${type}-${minute}`,
    runId: "run-1",
    projectId: "project-1",
    at: new Date(START + minute * 60_000).toISOString(),
    type,
    data,
  };
}

function record(status: RunRecord["status"], id = "run-1"): RunRecord {
  return {
    id,
    status,
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
  } as unknown as RunRecord;
}

const failing = (code = 1) => [
  {
    argv: ["npm", "test"],
    image: "node:24",
    code,
    stdout: SENTINEL,
    stderr: SENTINEL,
  },
];
const passing = [
  { argv: ["npm", "test"], image: "node:24", code: 0, stdout: "", stderr: "" },
];

describe("delivery retro", () => {
  it("splits a run's minutes into worker, verification, review, security, stopped and waiting time", () => {
    const retro = runRetro(record("succeeded"), [
      event(0, "run.started"),
      event(1, "attempt.started", { attempt: 1 }),
      event(1, "worker.dispatched", { attempt: 1 }),
      event(4, "worker.completed"),
      event(5, "verification.started", { snapshotHash: "a" }),
      event(15, "verification.completed", { checks: passing }),
      event(16, "run.stopped", { error: "Docker daemon is not running" }),
      event(76, "run.started", { resuming: true }),
      event(77, "review.started"),
      event(80, "review.completed", { passed: true }),
      event(80, "security.scan_started"),
      event(82, "security.scan_completed", { new: 0 }),
      event(90, "run.succeeded"),
      // After the run ended: a person's acceptance is not delivery time.
      event(600, "acceptance.recorded"),
    ]);
    expect(retro.minutes).toEqual({
      total: 90,
      worker: 3,
      verification: 10,
      review: 3,
      security: 2,
      stopped: 60,
      waiting: 12,
    });
  });

  it("counts verifications that repeated the step's previous failure or re-checked an unchanged snapshot", () => {
    const retro = runRetro(record("succeeded"), [
      event(0, "run.started"),
      event(1, "attempt.started", { attempt: 1 }),
      event(2, "verification.started", { snapshotHash: "a" }),
      event(3, "verification.completed", { checks: failing(1) }),
      event(4, "attempt.started", { attempt: 2 }),
      event(5, "verification.started", { snapshotHash: "b" }),
      event(6, "verification.completed", { checks: failing(1) }),
      event(7, "attempt.started", { attempt: 3 }),
      event(8, "verification.started", { snapshotHash: "b" }),
      event(9, "verification.completed", { checks: failing(2) }),
      event(10, "attempt.started", { attempt: 4 }),
      event(11, "verification.started", { snapshotHash: "c" }),
      event(12, "verification.completed", { checks: passing }),
      event(13, "run.succeeded"),
    ]);
    expect(retro).toMatchObject({
      attempts: 4,
      verifications: 4,
      repeatedFailures: 1,
      unchangedReverifications: 1,
      firstVerificationPassed: false,
    });
  });

  it("compares each verification with the previous one of the same step, across a stop and resume", () => {
    // A resumed run re-verifies its workspace and restarts attempt numbers.
    const retro = runRetro(record("succeeded"), [
      event(0, "attempt.started", { attempt: 1 }),
      {
        ...event(1, "verification.started", { snapshotHash: "a" }),
        stepId: "one",
      },
      {
        ...event(2, "verification.completed", { checks: failing() }),
        stepId: "one",
      },
      {
        ...event(3, "verification.started", { snapshotHash: "x" }),
        stepId: "two",
      },
      {
        ...event(4, "verification.completed", { checks: failing() }),
        stepId: "two",
      },
      event(5, "run.stopped", { error: "Required checks failed" }),
      event(10, "run.started", { resuming: true }),
      {
        ...event(11, "verification.started", { snapshotHash: "a" }),
        stepId: "one",
      },
      {
        ...event(12, "verification.completed", { checks: failing() }),
        stepId: "one",
      },
      event(12, "attempt.started", { attempt: 1 }),
      {
        ...event(13, "verification.started", { snapshotHash: "b" }),
        stepId: "one",
      },
      {
        ...event(14, "verification.completed", { checks: passing }),
        stepId: "one",
      },
      event(15, "run.succeeded"),
    ]);
    expect(retro).toMatchObject({
      attempts: 2,
      verifications: 4,
      repeatedFailures: 1,
      unchangedReverifications: 1,
    });
    expect(retro.minutes.stopped).toBe(5);
  });

  it("ends open phases at a stop, so stopped time is never also phase time", () => {
    const retro = runRetro(record("succeeded"), [
      event(0, "review.started"),
      event(10, "run.stopped", { error: "Code review did not complete" }),
      event(70, "run.started", { resuming: true }),
      event(72, "review.started"),
      event(75, "review.completed", { passed: true }),
      event(76, "run.succeeded"),
    ]);
    expect(retro.minutes).toMatchObject({ review: 13, stopped: 60, total: 76 });
  });

  it("reports stop reasons as kinds only, never the message", () => {
    const messages = [
      `Resolved path is outside allowed project scope: /Users/${SENTINEL}/a.ts`,
      `ENOENT: no such file or directory, open '/tmp/${SENTINEL}'`,
      `Patch includes a potential secret in src/${SENTINEL}.ts`,
      "The operation was aborted due to timeout",
      `Requested file is too large for the context budget: ${SENTINEL}.ts`,
    ];
    expect(messages.map(classifyError)).toEqual([
      "scope",
      "missing-file",
      "patch-secret",
      "aborted",
      "context-budget",
    ]);
    const retro = runRetro(
      record("failed"),
      messages.map((error, minute) => event(minute, "run.stopped", { error })),
    );
    expect(retro.stopKinds).toEqual([
      "scope",
      "missing-file",
      "patch-secret",
      "aborted",
      "context-budget",
    ]);
    expect(JSON.stringify(summarizeRetro([retro]))).not.toContain(SENTINEL);
  });

  it("totals runs, the first-pass verification rate and stop kinds, keeping only counts, minutes, kinds and run IDs", () => {
    const passedFirst = runRetro(record("succeeded", "run-a"), [
      event(0, "attempt.started", { attempt: 1 }),
      event(1, "verification.started", { snapshotHash: "a" }),
      event(2, "verification.completed", { checks: passing }),
      event(4, "run.succeeded"),
    ]);
    const failedFirst = runRetro(record("failed", "run-b"), [
      event(0, "attempt.started", { attempt: 1 }),
      event(1, "verification.started", { snapshotHash: "a" }),
      event(3, "verification.completed", { checks: failing() }),
      event(5, "run.stopped", {
        error: `Required checks failed in ${SENTINEL}`,
      }),
    ]);
    const neverVerified = runRetro(record("failed", "run-c"), [
      event(0, "run.started"),
      event(2, "run.stopped", {
        error: "Worker request exceeds configured context budget",
      }),
    ]);
    const summary = summarizeRetro([passedFirst, failedFirst, neverVerified]);
    expect(summary).toMatchObject({
      runs: 3,
      byStatus: { succeeded: 1, failed: 2 },
      firstPassVerification: { passed: 1, reached: 2 },
      stopKinds: { "checks-failed": 1, "context-budget": 1 },
      minutes: { total: 11, verification: 3, medianPerRun: 4 },
    });
    expect(summary.perRun.map((run) => run.runId)).toEqual([
      "run-a",
      "run-b",
      "run-c",
    ]);
    expect(JSON.stringify(summary)).not.toContain(SENTINEL);
  });

  it("limits the retro to runs created on or after --since", () => {
    const old = {
      ...record("failed", "old"),
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const recent = record("succeeded", "recent");
    const retros = [old, recent].map((run) => runRetro(run, []));
    expect(
      summarizeRetro(retros, { since: "2026-09-30T00:00:00.000Z" }).perRun.map(
        (run) => run.runId,
      ),
    ).toEqual(["recent"]);
  });
});
