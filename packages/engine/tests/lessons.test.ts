import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { GraphEngine } from "../src/service.js";
import { checked, writeJson } from "../src/util.js";

const roots: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Verify = NonNullable<Parameters<typeof GraphEngine.open>[1]>["verify"];

/**
 * A project whose checks pass only once `add` returns a + b. Each `run`
 * starts a fresh plan whose worker makes one edit per attempt.
 */
async function project(options: { cloud?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-lessons-"));
  roots.push(root);
  await checked("git", ["init", "-b", "main"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "core.autocrlf", "false"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  const config = await initializeProject(root);
  config.policy.providers = ["worker"];
  config.verification = [
    { image: "node:24-alpine", argv: ["node", "--test", "math.test.cjs"] },
  ];
  if (options.cloud)
    config.policy = {
      ...config.policy,
      inference: "allowlisted",
      network: "allowlisted",
      allowedHosts: ["api.openai.com"],
      exportPaths: ["math.cjs", "math.test.cjs"],
    };
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
  const data = projectDataDir(config.projectId);
  roots.push(data);
  await configureProvider(
    data,
    options.cloud
      ? { id: "worker", kind: "openai", model: "fixture" }
      : {
          id: "worker",
          kind: "local",
          model: "fixture",
          endpoint: "http://127.0.0.1:11434/v1",
        },
  );
  let edits: string[] = [];
  let body = "a - b";
  let feedback: string[] = [];
  const verify: Verify = async (workspace, checks, _policy, snapshotHash) => {
    const source = await readFile(path.join(workspace, "math.cjs"), "utf8");
    const code = source.includes("a + b") ? 0 : 1;
    return checks.map((check) => ({
      ...check,
      code,
      stdout: code ? "not ok 1 - add" : "ok 1 - add",
      stderr: "",
      snapshotHash,
    }));
  };
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    verify,
    worker: async (input) => {
      feedback.push(input.feedback ?? "");
      const next = edits[feedback.length - 1] ?? body;
      const changes =
        next === body ? [] : [{ path: "math.cjs", before: body, after: next }];
      body = next;
      return {
        model: "fixture",
        proposal: { summary: "Change addition", requests: [], changes },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      };
    },
  });
  engines.push(engine);
  return {
    engine,
    config,
    async run(attempts: number, nextEdits: string[]) {
      config.policy.maxAttempts = attempts;
      await writeJson(path.join(root, PROJECT_FILE), config);
      await checked(
        "git",
        ["commit", "-am", "test: attempts", "--allow-empty"],
        {
          cwd: root,
        },
      );
      edits = nextEdits;
      body = "a - b";
      feedback = [];
      const plan = await engine.createPlan({
        objective: "Fix addition",
        acceptance: ["2 + 3 is 5"],
      });
      const result = await engine.wait((await engine.start(plan.id)).id);
      return { result, feedback, events: engine.store.events(result.id) };
    },
  };
}

/** A run whose checks fail the same way three times, so it stops. */
const stuck = ["a * b", "a / b", "a % b"];
const LESSON = "A lesson the team accepted for this failure:";

describe("lessons from repeated failures", () => {
  it("proposes a private lesson when a run stops on a repeated failure", async () => {
    const { engine, run } = await project();
    const { result, events } = await run(5, stuck);
    expect(result.status).toBe("failed");
    const proposed = events.find((event) => event.type === "lesson.proposed");
    expect(proposed?.data.signature).toMatch(/^[0-9a-f]{12}$/);
    const memory = (await engine.context.listMemories()).find(
      (record) => record.id === proposed?.data.memoryId,
    );
    expect(memory).toMatchObject({
      kind: "observation",
      status: "proposed",
      visibility: "private",
    });
    expect(memory?.text).toContain("node --test math.test.cjs exited 1");
    expect(memory?.text).toContain("three attempts in a row");
  });

  it("shows an accepted lesson to a later run as soon as it meets the same failure", async () => {
    const { engine, run } = await project();
    const first = await run(5, stuck);
    const memoryId = first.events.find(
      (event) => event.type === "lesson.proposed",
    )!.data.memoryId as string;
    await engine.context.acceptMemory(memoryId);
    const { result, feedback, events } = await run(3, ["a * b", "a + b"]);
    expect(result.status).toBe("succeeded");
    // The first retry already carries it; no repeat is needed.
    expect(feedback[1]).toContain(LESSON);
    expect(feedback[1]).toContain("node --test math.test.cjs exited 1");
    expect(
      events.find((event) => event.type === "lesson.applied")?.data,
    ).toMatchObject({ memoryId, attempt: 1 });
  });

  it("never shows a lesson nobody accepted, or one a person rejected", async () => {
    const { engine, run } = await project();
    const first = await run(5, stuck);
    const unaccepted = await run(3, ["a * b", "a + b"]);
    expect(unaccepted.feedback[1]).not.toContain(LESSON);
    const memoryId = first.events.find(
      (event) => event.type === "lesson.proposed",
    )!.data.memoryId as string;
    await engine.context.rejectMemory(memoryId, "Not a real lesson");
    const rejected = await run(3, ["a * b", "a + b"]);
    expect(rejected.feedback[1]).not.toContain(LESSON);
  });

  it("gives a cloud worker an accepted lesson only once its exact text is authorized for export", async () => {
    const { engine, run } = await project({ cloud: true });
    const first = await run(5, stuck);
    const memoryId = first.events.find(
      (event) => event.type === "lesson.proposed",
    )!.data.memoryId as string;
    await engine.context.acceptMemory(memoryId);
    const unauthorized = await run(3, ["a * b", "a + b"]);
    expect(unauthorized.feedback[1]).not.toContain(LESSON);
    expect(
      unauthorized.events.some((event) => event.type === "lesson.applied"),
    ).toBe(false);
  });
});
