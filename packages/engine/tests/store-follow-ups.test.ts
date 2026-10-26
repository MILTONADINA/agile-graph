import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionPlan } from "@agile-graph/contracts";
import { followedUpRunId, followUpObjective } from "../src/planning.js";
import { RunStore } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const plan = (id: string, objective: string) =>
  ({ id, objective, projectId: "p1" }) as unknown as ExecutionPlan;

it("parses the run a follow-up objective names", () => {
  expect(followedUpRunId(followUpObjective("run-7", "Fix it"))).toBe("run-7");
  expect(followedUpRunId("Fix it")).toBeUndefined();
  expect(followedUpRunId("Plan the Follow-up of run x: later")).toBeUndefined();
});

it("lists only the runs follow-up plans name, in this project", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-follow-ups-"));
  directories.push(dataDir);
  const store = new RunStore(dataDir, "p1");
  const other = new RunStore(dataDir, "p2");
  try {
    expect(store.followUpSourceRunIds()).toEqual([]);
    store.savePlan(plan("a", followUpObjective("run-1", "One")));
    store.savePlan(plan("b", "Unrelated objective"));
    store.savePlan(plan("c", followUpObjective("run-1", "Again")));
    store.savePlan(plan("d", followUpObjective("run-2", "Two")));
    other.savePlan(plan("e", followUpObjective("run-3", "Other project")));
    expect(store.followUpSourceRunIds().sort()).toEqual(["run-1", "run-2"]);
  } finally {
    store.close();
    other.close();
  }
});
