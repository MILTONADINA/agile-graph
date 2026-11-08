import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ExecutionStep } from "@agile-graph/contracts";
import { runDag, type DagCheckpoint } from "../src/execution/dag.js";
import { checked } from "../src/util.js";
import type { WorkerResult } from "../src/workers/api.js";

// Streaming scheduler: a step starts once its own dependsOn steps have applied,
// up to maxParallel generations at once. Guards below fail a test instead of
// letting a wrong (wave-barrier) schedule hang it.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "graph-dag-stream-"));
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  await writeFile(path.join(workspace, "source.txt"), "original");
  return workspace;
}
const step = (id: string, dependsOn: string[] = []): ExecutionStep => ({
  id,
  kind: "worker",
  objective: `Implement ${id}`,
  dependsOn,
  providerId: "local",
});
const proposal = (file: string, after: string): WorkerResult => ({
  model: "fixture",
  proposal: {
    summary: `Write ${file}`,
    requests: [],
    changes: [{ path: file, before: null, after }],
  },
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const guard = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const settle = () => guard(10);

describe("streaming DAG scheduler", () => {
  it("starts a step once its own dependency applies, while an independent slower sibling still runs", async () => {
    const workspace = await fixture();
    const cStarted = deferred();
    let bDone = false;
    let cStartedWhileBRuns: boolean | undefined;
    const result = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      maxParallel: 2,
      steps: [step("a"), step("b"), step("c", ["a"])],
      saveCheckpoint: async () => {},
      generate: async (current) => {
        if (current.id === "a") return proposal("a.txt", "a");
        if (current.id === "c") {
          cStartedWhileBRuns = !bDone;
          cStarted.resolve();
          return proposal("c.txt", "c");
        }
        await Promise.race([cStarted.promise, guard(2000)]);
        bDone = true;
        return proposal("b.txt", "b");
      },
    });
    expect(cStartedWhileBRuns).toBe(true);
    expect(result.appliedStepIds.slice().sort()).toEqual(["a", "b", "c"]);
    expect(result.appliedStepIds.indexOf("a")).toBeLessThan(
      result.appliedStepIds.indexOf("c"),
    );
  });

  it("applies a running independent step when a sibling fails, and fails the run with the first error", async () => {
    const workspace = await fixture();
    const bStarted = deferred();
    const generated: string[] = [];
    let saved: DagCheckpoint | undefined;
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        maxParallel: 2,
        steps: [step("a"), step("b"), step("c", ["a"])],
        saveCheckpoint: async (value) => {
          saved = structuredClone(value);
        },
        generate: async (current) => {
          generated.push(current.id);
          if (current.id === "a") {
            await bStarted.promise;
            throw new Error("first failure");
          }
          if (current.id === "b") {
            bStarted.resolve();
            await guard(50);
            return proposal("b.txt", "b");
          }
          return proposal("c.txt", "c");
        },
      }),
    ).rejects.toThrow("first failure");
    expect(generated.sort()).toEqual(["a", "b"]);
    expect(saved?.completed.map((item) => item.id)).toEqual(["b"]);
    expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("b");
  });

  it("never runs more generations than maxParallel and refills a freed slot at once", async () => {
    const workspace = await fixture();
    const bDone = { value: false };
    const cStarted = deferred();
    let running = 0;
    let maxRunning = 0;
    let cStartedWhileBRuns: boolean | undefined;
    const result = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      maxParallel: 2,
      steps: [step("a"), step("b"), step("c"), step("d")],
      saveCheckpoint: async () => {},
      generate: async (current) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          if (current.id === "a") {
            await guard(5);
          } else if (current.id === "b") {
            await Promise.race([cStarted.promise, guard(2000)]);
            bDone.value = true;
          } else if (current.id === "c") {
            cStartedWhileBRuns = !bDone.value;
            cStarted.resolve();
            await guard(5);
          } else {
            await guard(5);
          }
          return proposal(`${current.id}.txt`, current.id);
        } finally {
          running--;
        }
      },
    });
    expect(maxRunning).toBe(2);
    expect(cStartedWhileBRuns).toBe(true);
    expect(result.appliedStepIds.slice().sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("applies in the same order for the same plan and completion order, and dependents after their dependencies", async () => {
    const runInOrder = async (completion: string[]) => {
      const workspace = await fixture();
      const gates: Record<string, ReturnType<typeof deferred>> = {};
      const started: Record<string, ReturnType<typeof deferred>> = {};
      for (const id of ["a", "b", "c", "d"]) {
        gates[id] = deferred();
        started[id] = deferred();
      }
      const run = runDag({
        workspace,
        policy: DEFAULT_POLICY,
        maxParallel: 2,
        steps: [step("a"), step("b"), step("c", ["a"]), step("d", ["b"])],
        saveCheckpoint: async () => {},
        generate: async (current) => {
          started[current.id]!.resolve();
          await gates[current.id]!.promise;
          return proposal(`${current.id}.txt`, current.id);
        },
      });
      for (const id of completion) {
        await Promise.race([started[id]!.promise, guard(1000)]);
        gates[id]!.resolve();
        await settle();
      }
      return (await run).appliedStepIds;
    };
    const order = ["b", "a", "d", "c"];
    const first = await runInOrder(order);
    const second = await runInOrder(order);
    expect(first).toEqual(order);
    expect(second).toEqual(first);
    expect(first.indexOf("a")).toBeLessThan(first.indexOf("c"));
    expect(first.indexOf("b")).toBeLessThan(first.indexOf("d"));
  });
});
