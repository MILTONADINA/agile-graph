import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ExecutionStep } from "@agile-graph/contracts";
import {
  DagReconciliationError,
  runDag,
  type DagCheckpoint,
} from "../src/execution/dag.js";
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
  // A per-test parent: snapshots are created beside the workspace.
  const parent = await mkdtemp(path.join(os.tmpdir(), "graph-dag-stream-"));
  roots.push(parent);
  const workspace = path.join(parent, "ws");
  await mkdir(workspace);
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
      const applied: Record<string, ReturnType<typeof deferred>> = {};
      for (const id of ["a", "b", "c", "d"]) {
        gates[id] = deferred();
        started[id] = deferred();
        applied[id] = deferred();
      }
      const run = runDag({
        workspace,
        policy: DEFAULT_POLICY,
        maxParallel: 2,
        steps: [step("a"), step("b"), step("c", ["a"]), step("d", ["b"])],
        saveCheckpoint: async () => {},
        onEvent: (current) => {
          if (current.type === "dag.step.completed" && current.stepId)
            applied[current.stepId]?.resolve();
        },
        generate: async (current) => {
          started[current.id]!.resolve();
          await gates[current.id]!.promise;
          return proposal(`${current.id}.txt`, current.id);
        },
      });
      // Release each generation only once it has started, and the next one
      // only once this one has applied: a slow runner (snapshot copies,
      // fingerprints) must not let two finished proposals queue together.
      for (const id of completion) {
        await started[id]!.promise;
        gates[id]!.resolve();
        await applied[id]!.promise;
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

describe("frozen generation snapshots", () => {
  const exists = (target: string) =>
    stat(target).then(
      () => true,
      () => false,
    );

  it("keeps a running generation on the pre-patch content while a sibling's patch applies (#373)", async () => {
    const workspace = await fixture();
    const oldOne = "old-one\n".repeat(300_000);
    const oldTwo = "old-two\n".repeat(300_000);
    const newOne = "new-one\n".repeat(300_000);
    const newTwo = "new-two\n".repeat(300_000);
    await writeFile(path.join(workspace, "big1.txt"), oldOne);
    await writeFile(path.join(workspace, "big2.txt"), oldTwo);
    const applied = deferred();
    const observed = new Set<string>();
    let rounds = 0;
    const result = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      maxParallel: 2,
      steps: [step("a"), step("b")],
      saveCheckpoint: async () => {},
      onEvent: (current) => {
        if (current.type === "dag.step.completed" && current.stepId === "b")
          applied.resolve();
      },
      generate: async (current, state) => {
        if (current.id === "b")
          return {
            ...proposal("big1.txt", newOne),
            proposal: {
              summary: "rewrite both",
              requests: [],
              changes: [
                { path: "big1.txt", before: oldOne, after: newOne },
                { path: "big2.txt", before: oldTwo, after: newTwo },
              ],
            },
          };
        const read = async () => {
          const one = await readFile(
            path.join(state.workspace, "big1.txt"),
            "utf8",
          );
          const two = await readFile(
            path.join(state.workspace, "big2.txt"),
            "utf8",
          );
          observed.add(
            `${one === oldOne ? "old" : one === newOne ? "new" : "mixed"}/${two === oldTwo ? "old" : two === newTwo ? "new" : "mixed"}`,
          );
          rounds++;
        };
        let after = false;
        void applied.promise.then(() => {
          after = true;
        });
        const deadline = Date.now() + 5000;
        while (!after && Date.now() < deadline) await read();
        await read();
        await read();
        return proposal("a.txt", "a");
      },
    });
    expect(result.appliedStepIds.slice().sort()).toEqual(["a", "b"]);
    expect(await readFile(path.join(workspace, "big1.txt"), "utf8")).toBe(
      newOne,
    );
    expect(rounds).toBeGreaterThan(2);
    expect([...observed]).toEqual(["old/old"]);
  });

  it("gives each generation an existing private copy and removes it after success, failure and abort", async () => {
    const paths: string[] = [];
    const insideExisted: boolean[] = [];
    const run = async (
      generate: (
        current: ExecutionStep,
        state: { workspace: string; signal: AbortSignal },
      ) => Promise<WorkerResult>,
      options: { signal?: AbortSignal } = {},
    ) => {
      const workspace = await fixture();
      return runDag({
        workspace,
        policy: DEFAULT_POLICY,
        maxParallel: 2,
        steps: [step("a"), step("b")],
        signal: options.signal,
        saveCheckpoint: async () => {},
        generate: async (current, state) => {
          paths.push(state.workspace);
          insideExisted.push(await exists(state.workspace));
          expect(state.workspace).not.toBe(workspace);
          return generate(current, state);
        },
      });
    };
    await run(async (current) => proposal(`${current.id}.txt`, current.id));
    await expect(
      run(async (current) => {
        if (current.id === "a") throw new Error("boom");
        await guard(20);
        return proposal("b.txt", "b");
      }),
    ).rejects.toThrow("boom");
    const controller = new AbortController();
    await expect(
      run(
        async (_current, state) => {
          controller.abort();
          await new Promise((_, reject) => {
            if (state.signal.aborted) reject(new Error("aborted"));
            else
              state.signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
          });
          return proposal("x.txt", "x");
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(paths.length).toBeGreaterThanOrEqual(6);
    expect(insideExisted.every(Boolean)).toBe(true);
    for (const target of paths) expect(await exists(target)).toBe(false);
  });

  it("ends needs-reconciliation when a worker dirties the workspace after an earlier plain failure", async () => {
    const workspace = await fixture();
    const failed = deferred();
    let firstCopy = "";
    const error = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      maxParallel: 2,
      steps: [step("a"), step("b")],
      saveCheckpoint: async () => {},
      generate: async (current, state) => {
        if (current.id === "a") {
          firstCopy = state.workspace;
          setTimeout(failed.resolve, 0);
          throw new Error("first failure");
        }
        await failed.promise;
        // a's rejection reaches the scheduler only after its snapshot is
        // removed; wait for that, so a slow runner cannot reorder them.
        while (await exists(firstCopy)) await guard(5);
        await guard(20);
        await writeFile(path.join(workspace, "dirty.txt"), "worker wrote me");
        return proposal("b.txt", "b");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DagReconciliationError);
    expect((error as DagReconciliationError).workspaceState).toBe(true);
    // Caught after a's failure or after b's generation: both are the same
    // workspace-state condition.
    expect((error as Error).message).toMatch(
      /modified the workspace|workspace changed while a step was generating/,
    );
  });

  it("ends needs-reconciliation when the workspace changes while the last generation fails", async () => {
    const workspace = await fixture();
    const error = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step("a")],
      saveCheckpoint: async () => {},
      generate: async () => {
        // An outside edit lands, then the only generation fails.
        await writeFile(path.join(workspace, "outside.txt"), "edited");
        throw new Error("generation failed");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DagReconciliationError);
    expect((error as DagReconciliationError).workspaceState).toBe(true);
  });

  it("still ends failed, not needs-reconciliation, when a policy change follows a plain failure", async () => {
    const workspace = await fixture();
    const policy = structuredClone(DEFAULT_POLICY);
    const failed = deferred();
    let firstCopy = "";
    const error = await runDag({
      workspace,
      policy,
      maxParallel: 2,
      steps: [step("a"), step("b")],
      saveCheckpoint: async () => {},
      generate: async (current, state) => {
        if (current.id === "a") {
          firstCopy = state.workspace;
          setTimeout(failed.resolve, 0);
          throw new Error("first failure");
        }
        await failed.promise;
        // a's rejection reaches the scheduler only after its snapshot is
        // removed; wait for that, so a slow runner cannot reorder them.
        while (await exists(firstCopy)) await guard(5);
        await guard(20);
        policy.maxTurns = policy.maxTurns + 1;
        return proposal("b.txt", "b");
      },
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("first failure");
    expect(error).not.toBeInstanceOf(DagReconciliationError);
  });

  it("reports a lone policy change as a reconciliation error that is not workspace state", async () => {
    const workspace = await fixture();
    const policy = structuredClone(DEFAULT_POLICY);
    const error = await runDag({
      workspace,
      policy,
      steps: [step("a")],
      saveCheckpoint: async () => {},
      generate: async () => {
        policy.maxTurns = policy.maxTurns + 1;
        return proposal("a.txt", "a");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DagReconciliationError);
    expect((error as DagReconciliationError).workspaceState).toBe(false);
  });

  // A read-only folder blocks removal only on POSIX; Windows removes it.
  it.skipIf(process.platform === "win32")(
    "keeps a step's outcome and reports, not fails, when a snapshot cannot be removed",
    async () => {
      const workspace = await fixture();
      const events: string[] = [];
      let snapshot = "";
      const locked = () => path.join(snapshot, "locked");
      try {
        const result = await runDag({
          workspace,
          policy: DEFAULT_POLICY,
          steps: [step("a")],
          saveCheckpoint: async () => {},
          onEvent: (current) => {
            events.push(current.type);
          },
          generate: async (_current, state) => {
            snapshot = state.workspace;
            // A read-only folder with a file in it makes removal fail.
            await mkdir(locked());
            await writeFile(path.join(locked(), "f"), "x");
            await chmod(locked(), 0o500);
            return proposal("a.txt", "a");
          },
        });
        expect(result.appliedStepIds).toEqual(["a"]);
        expect(events).toContain("dag.snapshot.cleanup_failed");
        expect(await exists(snapshot)).toBe(true);
        // A leftover that still cannot be removed is reported by the next
        // run, which goes on and applies its step.
        const next: string[] = [];
        const again = await runDag({
          workspace,
          policy: DEFAULT_POLICY,
          steps: [step("c")],
          saveCheckpoint: async () => {},
          onEvent: (current) => {
            next.push(current.type);
          },
          generate: async () => proposal("c.txt", "c"),
        });
        expect(again.appliedStepIds).toEqual(["c"]);
        expect(next).toContain("dag.snapshot.cleanup_failed");
      } finally {
        if (snapshot) await chmod(locked(), 0o700).catch(() => {});
      }
      // The next run of this workspace clears what a failed cleanup left.
      await runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("b")],
        saveCheckpoint: async () => {},
        generate: async () => proposal("b.txt", "b"),
      });
      expect(await exists(snapshot)).toBe(false);
      expect(
        (await readdir(path.dirname(workspace))).filter((name) =>
          name.startsWith("ws-snapshot-"),
        ),
      ).toEqual([]);
    },
  );
});
