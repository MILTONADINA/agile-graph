import { describe, expect, it } from "vitest";
import type { RunEvent, RunRecord } from "@agile-graph/contracts";
import { SCHEMA_VERSION } from "@agile-graph/contracts";
import {
  isPersonReason,
  PERSON_REASONS,
  runRetro,
  stepEstimateText,
  summarizeRetro,
  type RunRetro,
} from "../src/retro.js";

const START = Date.parse("2026-10-01T00:00:00.000Z");

/** An event `minute` minutes after the start of the day. */
function event(
  minute: number,
  type: string,
  data: Record<string, unknown> = {},
  stepId?: string,
): RunEvent {
  return {
    version: SCHEMA_VERSION,
    id: `${type}-${minute}-${stepId ?? ""}`,
    runId: "run-1",
    projectId: "project-1",
    at: new Date(START + minute * 60_000).toISOString(),
    type,
    data,
    ...(stepId !== undefined && { stepId }),
  } as RunEvent;
}

function record(status: RunRecord["status"], id = "run-1"): RunRecord {
  return {
    id,
    status,
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
  } as unknown as RunRecord;
}

const passing = [
  { argv: ["npm", "test"], image: "node:24", code: 0, stdout: "", stderr: "" },
];

describe("run-end next steps", () => {
  it("holds exactly the four person reasons, the last named decision", () => {
    expect([...PERSON_REASONS]).toEqual([
      "approval",
      "credential",
      "spending",
      "decision",
    ]);
    expect(isPersonReason("decision")).toBe(true);
    expect(isPersonReason("owner-decision")).toBe(false);
    expect(isPersonReason("graph")).toBe(false);
    expect(isPersonReason(undefined)).toBe(false);
  });

  it("keeps a stop with no reason with the graph, not the person", () => {
    const retro = runRetro(record("failed"), [
      event(0, "run.started"),
      event(1, "run.stopped", {}),
    ]);
    expect(retro).toMatchObject({
      deferredToPerson: 0,
      deferredByReason: {},
      graphOwnedStops: 1,
      stopKinds: ["unknown"],
    });
  });

  it("keeps a stop whose message names no known kind with the graph", () => {
    const retro = runRetro(record("failed"), [
      event(0, "run.stopped", { error: "Something nobody classified" }),
    ]);
    expect(retro).toMatchObject({
      deferredToPerson: 0,
      graphOwnedStops: 1,
      stopKinds: ["unknown"],
    });
  });
});

describe("re-check cycles", () => {
  it("records each re-check cycle's minutes, per phase, in order", () => {
    const retro = runRetro(record("succeeded"), [
      event(0, "run.started"),
      event(1, "verification.started", { snapshotHash: "a" }),
      event(3, "verification.completed", { checks: passing }),
      event(4, "verification.started", { snapshotHash: "b" }),
      event(9, "verification.completed", { checks: passing }),
      event(10, "review.started"),
      event(12, "review.completed"),
      event(13, "review.started"),
      event(14, "review.completed"),
      event(15, "run.succeeded"),
    ]);
    expect(retro.recheckCycles).toBe(2);
    expect(retro.recheckMinutes).toEqual([
      { phase: "verification", minutes: 5 },
      { phase: "review", minutes: 1 },
    ]);
  });

  it("does not count a worker's repeated attempts or a step's first scan as re-checks", () => {
    const retro = runRetro(record("succeeded"), [
      event(0, "run.started"),
      event(1, "worker.dispatched"),
      event(2, "worker.completed"),
      event(3, "worker.dispatched"),
      event(4, "worker.completed"),
      event(5, "verification.started", {}, "step-a"),
      event(6, "verification.completed", { checks: passing }, "step-a"),
      event(7, "verification.started", {}, "step-b"),
      event(8, "verification.completed", { checks: passing }, "step-b"),
      event(9, "run.succeeded"),
    ]);
    expect(retro.recheckCycles).toBe(0);
    expect(retro.recheckMinutes).toEqual([]);
  });

  it("does not count a reviewer's retry decision as a review re-check", () => {
    const step = (event: RunEvent) => ({ ...event, stepId: "one" });
    const retro = runRetro(record("succeeded"), [
      event(0, "run.started"),
      step(event(1, "review.started")),
      step(event(2, "review.completed", { passed: true })),
      step(event(3, "attempt.repeat_decision_started", { attempt: 2 })),
      step(event(4, "attempt.repeat_decision", { decision: "retry" })),
      // The one real re-check of the step's review.
      step(event(5, "review.started")),
      step(event(6, "review.completed", { passed: true })),
      event(7, "run.succeeded"),
    ]);
    expect(retro.recheckCycles).toBe(1);
    expect(retro.recheckMinutes).toEqual([{ phase: "review", minutes: 1 }]);
    // The retry decision still counts as review time, just not as a cycle.
    expect(retro.minutes.review).toBe(3);
  });

  it("counts a cycle a stop cut short, with no minutes", () => {
    const retro = runRetro(record("failed"), [
      event(0, "run.started"),
      event(1, "verification.started"),
      event(3, "verification.completed", { checks: passing }),
      event(4, "verification.started"),
      event(6, "run.stopped", { error: "Required checks failed" }),
    ]);
    expect(retro.recheckCycles).toBe(1);
    expect(retro.recheckMinutes).toEqual([]);
  });

  it("totals cycles, minutes and the median minutes per cycle across runs", () => {
    const cycles = (id: string, minutes: number[]): [RunRecord, RunEvent[]] => {
      const events: RunEvent[] = [event(0, "run.started")];
      let at = 1;
      for (const [index, length] of minutes.entries()) {
        events.push(event(at, "verification.started", { n: index }));
        events.push(
          event(at + length, "verification.completed", { checks: passing }),
        );
        at += length + 1;
      }
      events.push(event(at, "run.succeeded"));
      return [record("succeeded", id), events];
    };
    const [runA, eventsA] = cycles("a", [1, 5, 4]);
    const [runB, eventsB] = cycles("b", [3, 2]);
    const summary = summarizeRetro([
      runRetro(runA, eventsA),
      runRetro(runB, eventsB),
    ]);
    // Each run's first scan is not a cycle: run A's re-checks take 5 and 4
    // minutes, run B's take 2.
    expect(summary.recheck).toEqual({
      cycles: 3,
      minutes: 11,
      medianPerCycle: 4,
    });
  });

  it("gives each run's retro its own re-check total and median minutes", () => {
    const cycles = (id: string, minutes: number[]): [RunRecord, RunEvent[]] => {
      const events: RunEvent[] = [event(0, "run.started")];
      let at = 1;
      for (const [index, length] of minutes.entries()) {
        events.push(event(at, "verification.started", { n: index }));
        events.push(
          event(at + length, "verification.completed", { checks: passing }),
        );
        at += length + 1;
      }
      events.push(event(at, "run.succeeded"));
      return [record("succeeded", id), events];
    };
    const [runA, eventsA] = cycles("a", [1, 5, 4]);
    const [runB, eventsB] = cycles("b", [3, 2]);
    const retros = [runRetro(runA, eventsA), runRetro(runB, eventsB)];
    // Run A's re-checks take 5 and 4 minutes; run B's take 2.
    expect(retros[0]).toMatchObject({
      recheckTotalMinutes: 9,
      recheckMedianMinutes: 4.5,
    });
    expect(retros[1]).toMatchObject({
      recheckTotalMinutes: 2,
      recheckMedianMinutes: 2,
    });
    // The totals are the same figures over both runs' cycles.
    const summary = summarizeRetro(retros);
    expect(summary.recheck).toEqual({
      cycles: 3,
      minutes: 11,
      medianPerCycle: 4,
    });
    expect(summary.perRun.map((run) => run.recheckMedianMinutes)).toEqual([
      4.5, 2,
    ]);
  });

  it("reads a record made before the field existed as zero", () => {
    const {
      recheckCycles: _c,
      recheckMinutes: _m,
      ...old
    } = runRetro(record("succeeded"), [
      event(0, "run.started"),
      event(1, "run.succeeded"),
    ]);
    const summary = summarizeRetro([old as RunRetro]);
    expect(summary.recheck).toEqual({
      cycles: 0,
      minutes: 0,
      medianPerCycle: 0,
    });
  });
});

describe("honest step estimates", () => {
  it("states what is true after the step and the steps that remain before the goal", () => {
    expect(
      stepEstimateText({
        stateAfterStep: "The harness fix is merged and its checks pass",
        stepsRemaining: 2,
        goal: "a run that passes review",
      }),
    ).toBe(
      "The harness fix is merged and its checks pass. after this step: 2 steps remain before a run that passes review",
    );
  });

  it("never reads as readiness: zero is printed as zero steps remaining", () => {
    expect(
      stepEstimateText({
        stateAfterStep: "The last check passed",
        stepsRemaining: 0,
        goal: "the product feature",
      }),
    ).toContain("after this step: 0 steps remain before the product feature");
  });

  it("refuses an estimate with no state, no goal, or a count that is not a whole number", () => {
    const base = { stateAfterStep: "x", stepsRemaining: 1, goal: "g" };
    // The valid form must work, so the refusals below are not vacuous.
    expect(stepEstimateText(base)).toBe(
      "x. after this step: 1 steps remain before g",
    );
    expect(() => stepEstimateText({ ...base, stateAfterStep: " " })).toThrow(
      "state and its goal",
    );
    expect(() => stepEstimateText({ ...base, goal: "" })).toThrow(
      "state and its goal",
    );
    expect(() => stepEstimateText({ ...base, stepsRemaining: -1 })).toThrow(
      "whole number",
    );
    expect(() => stepEstimateText({ ...base, stepsRemaining: 1.5 })).toThrow(
      "whole number",
    );
  });

  it("prints the estimates the report is given, and none by default", () => {
    const estimate = {
      stateAfterStep: "The setup check passes",
      stepsRemaining: 3,
      goal: "a ready project",
    };
    expect(summarizeRetro([]).estimates).toEqual([]);
    expect(summarizeRetro([], { estimates: [estimate] }).estimates).toEqual([
      "The setup check passes. after this step: 3 steps remain before a ready project",
    ]);
  });
});
