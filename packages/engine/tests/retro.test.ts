import { describe, expect, it } from "vitest";
import type { RunEvent, RunRecord } from "@agile-graph/contracts";
import { SCHEMA_VERSION } from "@agile-graph/contracts";
import { classifyError, ERROR_KINDS } from "../src/feedback.js";
import {
  HUMAN_WAIT_REASONS,
  STOP_OWNERS,
  outputTail,
  runRetro,
  runsCreatedSince,
  summarizeRetro,
} from "../src/retro.js";

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
    expect(
      runsCreatedSince([old, recent], "2026-09-30T00:00:00.000Z").map(
        (run) => run.id,
      ),
    ).toEqual(["recent"]);
    expect(runsCreatedSince([old, recent]).map((run) => run.id)).toEqual([
      "old",
      "recent",
    ]);
    for (const invalid of [
      "yesterday",
      "10/01/2026",
      "2026-02-30",
      "2026-10-01T25:00Z",
    ])
      expect(() => runsCreatedSince([old], invalid)).toThrow(
        "--since must be an ISO 8601 date or time",
      );
    expect(
      runsCreatedSince([old, recent], "2026-09-30T12:00:00+02:00").map(
        (run) => run.id,
      ),
    ).toEqual(["recent"]);
  });

  it("counts concurrent steps' phase time once, as wall-clock time", () => {
    const step = (event: RunEvent, stepId: string) => ({ ...event, stepId });
    const retro = runRetro(record("succeeded"), [
      step(event(0, "worker.dispatched"), "one"),
      step(event(1, "worker.dispatched"), "two"),
      step(event(5, "worker.completed"), "one"),
      step(event(10, "worker.completed"), "two"),
      // A finish without a step closes that phase's latest open span.
      event(10, "security.scan_started"),
      event(12, "security.scan_completed"),
      event(12, "run.succeeded"),
    ]);
    expect(retro.minutes).toMatchObject({
      total: 12,
      worker: 10,
      security: 2,
      waiting: 0,
    });
  });

  it("counts a first verification that never finished as reached and not passed", () => {
    const retro = runRetro(record("failed"), [
      event(0, "verification.started", { snapshotHash: "a" }),
      event(3, "run.stopped", { error: "Run cancelled" }),
    ]);
    expect(retro.firstVerificationPassed).toBe(false);
    expect(summarizeRetro([retro]).firstPassVerification).toEqual({
      passed: 0,
      reached: 1,
    });
  });

  it("prints no timestamps", () => {
    const retro = runRetro(record("succeeded"), [
      event(0, "run.started"),
      event(5, "run.succeeded"),
    ]);
    expect(JSON.stringify(summarizeRetro([retro]))).not.toMatch(
      /\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("counts a multi-step plan's worker steps as worker time and attempts", () => {
    const step = (event: RunEvent, stepId: string) => ({ ...event, stepId });
    const retro = runRetro(record("succeeded"), [
      step(event(0, "dag.step.started", { providerId: "local" }), "one"),
      step(event(0, "dag.step.started", { providerId: null }), "generate"),
      step(event(4, "worker.completed"), "one"),
      step(event(5, "dag.step.completed"), "one"),
      step(event(6, "dag.step.completed"), "generate"),
      event(10, "run.succeeded"),
    ]);
    expect(retro.attempts).toBe(1);
    expect(retro.minutes).toMatchObject({ worker: 6, waiting: 4 });
  });

  it("tells unnamed checks with the same command in different images apart", () => {
    const failingIn = (image: string) => [
      { argv: ["npm", "test"], image, code: 1, stdout: "", stderr: "" },
    ];
    const retro = runRetro(record("failed"), [
      event(0, "verification.started", { snapshotHash: "a" }),
      event(1, "verification.completed", { checks: failingIn("node:24") }),
      event(2, "verification.started", { snapshotHash: "b" }),
      event(3, "verification.completed", { checks: failingIn("node:22") }),
      event(4, "run.stopped", { error: "Required checks failed" }),
    ]);
    expect(retro.repeatedFailures).toBe(0);
  });

  it("tells two failures of the same check apart by their output, ignoring durations, timestamps and temporary paths", () => {
    const failingWith = (stdout: string) => [
      { argv: ["npm", "test"], image: "node:24", code: 1, stdout, stderr: "" },
    ];
    const verifications = (outputs: string[]) =>
      runRetro(
        record("failed"),
        outputs.flatMap((stdout, index) => [
          event(index * 2, "verification.started", {
            snapshotHash: `s${index}`,
          }),
          event(index * 2 + 1, "verification.completed", {
            checks: failingWith(stdout),
          }),
        ]),
      ).repeatedFailures;
    expect(
      verifications([
        "not ok 1 - add returns 5",
        "not ok 2 - subtract returns 1",
      ]),
    ).toBe(0);
    expect(
      verifications([
        "not ok 1 - add (12ms) at /tmp/graph-a1/x.js 2026-10-01T10:00:00Z",
        "not ok 1 - add (31ms) at /tmp/graph-b2/x.js 2026-10-01T10:05:00Z",
      ]),
    ).toBe(1);
  });

  it("reads at most 40 lines of 500 characters of a check's output, quickly", () => {
    const huge = `${"x".repeat(200_000)}\n`.repeat(50);
    const started = performance.now();
    const tail = outputTail(huge, "C:\\" + "a".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(tail.split("\n")).toHaveLength(40);
    expect(Math.max(...tail.split("\n").map((line) => line.length))).toBe(500);
  });

  it("counts a reviewer's decision on a repeated failure as review time", () => {
    const step = (event: RunEvent) => ({ ...event, stepId: "one" });
    const retro = runRetro(record("succeeded"), [
      step(event(0, "attempt.repeat_decision_started", { attempt: 2 })),
      step(
        event(3, "attempt.repeat_decision", { decision: "change_approach" }),
      ),
      event(4, "run.succeeded"),
    ]);
    expect(retro.minutes).toMatchObject({ review: 3, waiting: 1 });
  });

  it("counts lessons proposed after a repeated failure and lessons shown to a worker", () => {
    const retro = runRetro(record("failed"), [
      event(0, "lesson.applied", { memoryId: "m1", attempt: 1 }),
      event(1, "lesson.proposed", { memoryId: "m2", signature: "abc" }),
      event(2, "run.stopped", {
        error: "Required checks failed the same way on three attempts in a row",
      }),
    ]);
    expect(retro).toMatchObject({ lessonsProposed: 1, lessonsApplied: 1 });
    expect(summarizeRetro([retro, retro])).toMatchObject({
      lessonsProposed: 2,
      lessonsApplied: 2,
      stopKinds: { "repeated-failure": 2 },
    });
  });

  it("keeps a first verification a stop interrupted as failed after a resume", () => {
    const retro = runRetro(record("succeeded"), [
      event(0, "verification.started", { snapshotHash: "a" }),
      event(1, "run.stopped", { error: "Run cancelled" }),
      event(5, "run.started", { resuming: true }),
      event(6, "verification.started", { snapshotHash: "a" }),
      event(7, "verification.completed", {
        checks: [
          {
            argv: ["npm", "test"],
            image: "node:24",
            code: 0,
            stdout: "",
            stderr: "",
          },
        ],
      }),
      event(8, "run.succeeded"),
    ]);
    expect(retro.firstVerificationPassed).toBe(false);
  });

  describe("deferral to the person", () => {
    const owners = Object.entries(STOP_OWNERS);
    const PERSON = ["approval", "credential", "spending", "owner-decision"];

    it("classifies every stop kind as a person reason or the graph's own", () => {
      const kinds = [...ERROR_KINDS.map(({ kind }) => kind), "unknown"].sort();
      expect(Object.keys(STOP_OWNERS).sort()).toEqual(kinds);
      for (const [, owner] of owners)
        expect([...PERSON, "graph"]).toContain(owner);
      expect(
        Object.values(HUMAN_WAIT_REASONS).every((r) => PERSON.includes(r)),
      ).toBe(true);
    });

    it("counts a plan-approval stop as deferred with reason approval", () => {
      const message =
        "Publication needs a person's current approval of the plan this run holds, and plan p is not approved";
      expect(classifyError(message)).toBe("plan-approval");
      const retro = runRetro(record("failed"), [
        event(0, "run.started"),
        event(1, "run.stopped", { error: message }),
      ]);
      expect(retro).toMatchObject({
        deferredToPerson: 1,
        deferredByReason: { approval: 1 },
        graphOwnedStops: 0,
      });
    });

    it("counts a spending-cap stop and a human-acceptance wait as deferred", () => {
      const retro = runRetro(record("succeeded"), [
        event(0, "run.stopped", { error: "Estimated cost budget exceeded" }),
        event(1, "run.started"),
        event(2, "acceptance.pending_review", {}),
        event(3, "run.succeeded"),
      ]);
      expect(retro.deferredToPerson).toBe(2);
      expect(retro.deferredByReason).toEqual({
        spending: 1,
        "owner-decision": 1,
      });
    });

    it("counts a checks-failed stop as graph-owned, not deferred", () => {
      const retro = runRetro(record("failed"), [
        event(0, "run.stopped", { error: "Required checks failed" }),
      ]);
      expect(retro).toMatchObject({
        deferredToPerson: 0,
        deferredByReason: {},
        graphOwnedStops: 1,
      });
    });

    it("aggregates across runs and still reads an old record without the fields", () => {
      const approval = runRetro(record("failed", "a"), [
        event(0, "run.stopped", {
          error:
            "This project requires a person to approve every plan before a run of it starts",
        }),
      ]);
      const checks = runRetro(record("failed", "b"), [
        event(0, "run.stopped", { error: "Required checks failed" }),
      ]);
      const {
        deferredToPerson: _d,
        deferredByReason: _r,
        graphOwnedStops: _g,
        ...old
      } = checks;
      const summary = summarizeRetro([approval, checks, old]);
      expect(summary).toMatchObject({
        deferredToPerson: 1,
        deferredByReason: { approval: 1 },
        graphOwnedStops: 1,
      });
      expect(summarizeRetro([old])).toMatchObject({
        deferredToPerson: 0,
        deferredByReason: {},
        graphOwnedStops: 0,
      });
    });
  });
});
