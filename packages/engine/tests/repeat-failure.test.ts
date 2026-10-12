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
import { classifyError } from "../src/feedback.js";
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
 * A run whose worker makes one edit per attempt (`edits`, each replacing the
 * previous body of `add`) and whose checks exit with `codes(body)`.
 */
async function run(options: {
  attempts: number;
  edits: string[];
  codes: (body: string) => number;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-repeat-"));
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
  config.policy.providers = ["local"];
  config.policy.maxAttempts = options.attempts;
  config.verification = [
    { image: "node:24-alpine", argv: ["node", "--test", "math.test.cjs"] },
  ];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
  const data = projectDataDir(config.projectId);
  roots.push(data);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
    endpoint: "http://127.0.0.1:11434/v1",
  });
  const feedback: string[] = [];
  let body = "a - b";
  const verify: Verify = async (workspace, checks, _policy, snapshotHash) => {
    const source = await readFile(path.join(workspace, "math.cjs"), "utf8");
    const code = options.codes(source);
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
      const next = options.edits[feedback.length - 1] ?? body;
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
  const plan = await engine.createPlan({
    objective: "Fix addition",
    acceptance: ["2 + 3 is 5"],
  });
  const result = await engine.wait((await engine.start(plan.id)).id);
  return { result, feedback, events: engine.store.events(result.id) };
}

const fixedWhen = (body: string) => (source: string) =>
  source.includes(body) ? 0 : 1;

describe("retries that learn from the previous failure", () => {
  it("tells every retry after a check failure to change approach, and names a repeated failure", async () => {
    const { result, feedback, events } = await run({
      attempts: 3,
      edits: ["a * b", "a / b", "a + b"],
      codes: fixedWhen("a + b"),
    });
    expect(result.status).toBe("succeeded");
    expect(feedback).toHaveLength(3);
    expect(feedback[0]).not.toContain("change your approach");
    expect(feedback[1]).toContain("Attempt 1 of 3 failed its required checks");
    expect(feedback[1]).toContain("change your approach");
    expect(feedback[1]).not.toContain("failed exactly as");
    expect(feedback[2]).toContain(
      "The required checks failed exactly as they did on the previous attempt",
    );
    const repeats = events.filter(
      (event) => event.type === "attempt.repeated_failure",
    );
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.data).toMatchObject({
      attempt: 2,
      repeats: 1,
      unchanged: false,
    });
    expect(repeats[0]!.data.signature).toMatch(/^[0-9a-f]{12}$/);
  });

  it("stops when the checks fail the same way three times in a row instead of spending another attempt", async () => {
    const { result, feedback } = await run({
      attempts: 5,
      edits: ["a * b", "a / b", "a % b", "a + b"],
      codes: () => 1,
    });
    expect(result.status).toBe("failed");
    expect(feedback).toHaveLength(3);
    expect(result.error).toContain(
      "Required checks failed the same way on three attempts in a row",
    );
    expect(classifyError(result.error!)).toBe("repeated-failure");
  });

  it("starts the count again when a retry fails differently", async () => {
    const { result, feedback, events } = await run({
      attempts: 4,
      edits: ["a * b", "a / b", "a % b", "a + b"],
      // Exit 1, then 2 twice, then pass: only the third attempt repeats.
      codes: (source) =>
        source.includes("a + b") ? 0 : source.includes("a * b") ? 1 : 2,
    });
    expect(result.status).toBe("succeeded");
    expect(feedback).toHaveLength(4);
    expect(feedback[2]).not.toContain("failed exactly as");
    expect(feedback[3]).toContain("failed exactly as");
    expect(
      events.filter((event) => event.type === "attempt.repeated_failure"),
    ).toHaveLength(1);
  });

  it("tells the worker when its last change left the checked files as they were", async () => {
    const { feedback, events } = await run({
      attempts: 3,
      // The second attempt proposes no change at all.
      edits: ["a * b", "a * b", "a + b"],
      codes: fixedWhen("a + b"),
    });
    expect(feedback[2]).toContain(
      "Your last change left the checked files exactly as before",
    );
    expect(
      events.find((event) => event.type === "attempt.repeated_failure")?.data,
    ).toMatchObject({ unchanged: true });
  });
});
