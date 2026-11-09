import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ExecutionStep } from "@agile-graph/contracts";
import { DagReconciliationError, runDag } from "../src/execution/dag.js";
import { checked } from "../src/util.js";

// An outside edit between the scheduler's fingerprint check and the copy is
// caught by the snapshot's own hash check. It cannot be timed from a test, so
// the snapshot module reports it directly.
vi.mock("../src/execution/snapshot.js", async (original) => {
  const real = await original<typeof import("../src/execution/snapshot.js")>();
  return {
    ...real,
    createWorkspaceSnapshot: async () => {
      throw new real.SnapshotMismatchError("Workspace snapshot hash mismatch");
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("snapshot hash mismatch", () => {
  it("ends needing reconciliation, like any outside change to the workspace", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "graph-dag-mismatch-"));
    roots.push(parent);
    const workspace = path.join(parent, "ws");
    await mkdir(workspace);
    await checked("git", ["init", "-b", "dev"], { cwd: workspace });
    await writeFile(path.join(workspace, "source.txt"), "original");
    const step: ExecutionStep = {
      id: "a",
      kind: "worker",
      objective: "Implement a",
      dependsOn: [],
      providerId: "local",
    };
    let generated = false;
    const error = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step],
      saveCheckpoint: async () => {},
      generate: async () => {
        generated = true;
        throw new Error("never starts");
      },
    }).catch((caught: unknown) => caught);
    expect(generated).toBe(false);
    expect(error).toBeInstanceOf(DagReconciliationError);
    expect((error as DagReconciliationError).workspaceState).toBe(true);
  });
});
