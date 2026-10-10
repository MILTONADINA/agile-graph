import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  SCHEMA_VERSION,
  type ExecutionPlan,
  type RunRecord,
} from "@graph-engineering/contracts";
import { readRunReceipt, RunStore } from "../src/store.js";
import { runEvidence } from "../src/overview.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("reads a project-scoped run and ordered events without recovering an active run", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-run-receipt-"));
  directories.push(dataDir);
  const projectId = "receipt-project";
  const plan: ExecutionPlan = {
    version: SCHEMA_VERSION,
    id: "plan-1",
    projectId,
    snapshotId: "a".repeat(64),
    policyHash: "b".repeat(64),
    createdAt: "2026-09-23T00:00:00.000Z",
    objective: "Review selected task",
    acceptance: ["reviewed"],
    steps: [],
    verification: [],
    publication: "none",
  };
  const run: RunRecord = {
    id: "run-1",
    plan,
    status: "running",
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    workspace: "/private/worktree",
    branch: "graph/run-1",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
  };
  const store = new RunStore(dataDir, projectId);
  store.savePlan(plan);
  store.saveRun(run);
  const first = store.event(run.id, "worker.dispatched", { step: 1 });
  const second = store.event(run.id, "worker.completed", { step: 1 });
  store.close();
  expect(readRunReceipt(dataDir, projectId, run.id)).toEqual({
    run,
    events: [first, second],
    evidence: {
      finalSnapshotHash: null,
      verification: null,
      review: null,
      security: null,
      unfinished: [],
      complete: false,
    },
  });
  expect(() => readRunReceipt(dataDir, "other-project", run.id)).toThrow(
    /does not exist for this project/,
  );
  const db = new Database(path.join(dataDir, "runs.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = db.prepare("SELECT json FROM runs WHERE id=?").get(run.id) as {
      json: string;
    };
    expect(JSON.parse(row.json).status).toBe("running");
  } finally {
    db.close();
  }
});

it("refuses a missing run database without creating it", async () => {
  const dataDir = path.join(
    await mkdtemp(path.join(tmpdir(), "graph-run-receipt-missing-")),
    "absent",
  );
  directories.push(path.dirname(dataDir));
  expect(() => readRunReceipt(dataDir, "project", "run")).toThrow(
    "Run receipt database does not exist",
  );
  expect(existsSync(dataDir)).toBe(false);
});

it("refuses a run database written by a newer engine", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-run-receipt-new-"));
  directories.push(dataDir);
  new RunStore(dataDir, "project").close();
  const db = new Database(path.join(dataDir, "runs.sqlite"));
  db.pragma("user_version = 5");
  db.close();
  expect(() => readRunReceipt(dataDir, "project", "run")).toThrow(
    "newer than this engine",
  );
});

it("projects an evidence ledger of the snapshot each gate last ran against", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-run-evidence-"));
  directories.push(dataDir);
  const projectId = "receipt-project";
  const plan: ExecutionPlan = {
    version: SCHEMA_VERSION,
    id: "plan-1",
    projectId,
    snapshotId: "a".repeat(64),
    policyHash: "b".repeat(64),
    createdAt: "2026-10-10T00:00:00.000Z",
    objective: "Review selected task",
    acceptance: ["reviewed"],
    steps: [],
    verification: [],
    publication: "none",
  };
  const run: RunRecord = {
    id: "run-1",
    plan,
    status: "failed",
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
  };
  const first = "1".repeat(64);
  const second = "2".repeat(64);
  const store = new RunStore(dataDir, projectId);
  store.savePlan(plan);
  store.saveRun(run);
  const verified = (snapshotHash: string) =>
    store.event(run.id, "verification.completed", {
      checks: [{ argv: ["npm", "test"], code: 0 }],
      snapshotHash,
    });
  verified(first);
  const review = store.event(run.id, "review.completed", {
    passed: true,
    verdict: "approve",
    snapshotHash: first,
  });
  store.event(run.id, "security.scan_completed", { snapshotHash: first });
  const gate = store.event(run.id, "security.gate_passed", {
    snapshotHash: first,
  });
  const ledger = () => readRunReceipt(dataDir, projectId, run.id).evidence;
  expect(ledger()).toMatchObject({
    finalSnapshotHash: first,
    verification: { snapshotHash: first, current: true, passed: true },
    review: {
      eventId: review.id,
      snapshotHash: first,
      current: true,
      passed: true,
      by: "reviewer",
    },
    security: { eventId: gate.id, current: true, passed: true },
    complete: true,
  });
  // A later snapshot's checks leave the review and the security gate about
  // the earlier one, so the ledger is no longer complete.
  const later = verified(second);
  expect(ledger()).toMatchObject({
    finalSnapshotHash: second,
    verification: { eventId: later.id, current: true },
    review: { snapshotHash: first, current: false },
    security: { snapshotHash: first, current: false },
    complete: false,
  });
  // A gate event from an older engine names no snapshot and is not current.
  store.event(run.id, "review.completed", { passed: true, by: "person" });
  store.event(run.id, "security.gate_passed", { snapshotHash: second });
  expect(ledger()).toMatchObject({
    review: { snapshotHash: null, current: false, by: "person" },
    security: { snapshotHash: second, current: true },
    complete: false,
  });
  store.close();
});

it("leaves the evidence incomplete when a gate's latest attempt never recorded a result", () => {
  let n = 0;
  const event = (type: string, data: Record<string, unknown> = {}) => ({
    id: `e${++n}`,
    runId: "r",
    type,
    at: new Date(n * 1000).toISOString(),
    data,
  });
  const passedChecks = { snapshotHash: "H", checks: [{ code: 0 }] };
  const settled = [
    event("verification.started", { snapshotHash: "H" }),
    event("verification.completed", passedChecks),
    event("review.started", { snapshotHash: "H" }),
    event("review.completed", { snapshotHash: "H", passed: true }),
    event("security.scan_started", { snapshotHash: "H" }),
    event("security.gate_passed", { snapshotHash: "H" }),
  ];
  expect(runEvidence(settled as never)).toMatchObject({
    unfinished: [],
    complete: true,
  });
  // A repair moved the run on and its verification crashed before a result.
  const crashed = [
    ...settled,
    event("verification.started", { snapshotHash: "X" }),
  ];
  expect(runEvidence(crashed as never)).toMatchObject({
    finalSnapshotHash: "H",
    unfinished: ["verification"],
    complete: false,
  });
  const reviewCrashed = [
    ...settled,
    event("review.started", { snapshotHash: "H" }),
  ];
  expect(runEvidence(reviewCrashed as never).unfinished).toEqual(["review"]);
});
