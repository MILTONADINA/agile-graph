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

type Deps = NonNullable<Parameters<typeof GraphEngine.open>[1]>;
type Verify = Deps["verify"];

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  costUsd: 0,
  estimated: false,
};

/**
 * A run whose worker makes one edit per attempt (`edits`, each replacing the
 * previous body of `add`) and whose checks exit with `codes(body)`.
 */
async function run(options: {
  attempts: number;
  edits: string[];
  codes: (body: string) => number;
  /** Configures a reviewer that approves every change it reviews. */
  repeatDecision?: Deps["repeatDecision"];
  /** Cloud (API) worker and reviewer instead of local ones. */
  cloud?: boolean;
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
  if (options.repeatDecision) {
    config.policy.providers = ["local", "reviewer"];
    config.review = { providerId: "reviewer" };
  }
  if (options.cloud)
    config.policy = {
      ...config.policy,
      inference: "allowlisted",
      network: "allowlisted",
      allowedHosts: ["api.openai.com"],
      exportPaths: ["math.cjs", "math.test.cjs"],
    };
  config.verification = [
    { image: "node:24-alpine", argv: ["node", "--test", "math.test.cjs"] },
  ];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
  const data = projectDataDir(config.projectId);
  roots.push(data);
  await configureProvider(
    data,
    options.cloud
      ? { id: "local", kind: "openai", model: "fixture" }
      : {
          id: "local",
          kind: "local",
          model: "fixture",
          endpoint: "http://127.0.0.1:11434/v1",
        },
  );
  if (options.repeatDecision)
    await configureProvider(
      data,
      options.cloud
        ? { id: "reviewer", kind: "openai", model: "fixture-reviewer" }
        : {
            id: "reviewer",
            kind: "local",
            model: "fixture-reviewer",
            endpoint: "http://127.0.0.1:11434/v1",
          },
    );
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
    repeatDecision: options.repeatDecision,
    review: async (input) => ({
      model: "fixture-reviewer",
      usage,
      review: {
        verdict: "approve",
        summary: "Looks right",
        criteria: input.acceptance.map((criterion) => ({
          criterion,
          met: "yes",
          evidence: "The checks pass",
        })),
        findings: [],
      },
    }),
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

  it("asks the run's reviewer to decide a repeated failure and passes its guidance to the next attempt", async () => {
    const asked: string[] = [];
    const { result, feedback, events } = await run({
      attempts: 3,
      edits: ["a * b", "a / b", "a + b"],
      codes: fixedWhen("a + b"),
      repeatDecision: async (input) => {
        asked.push(input.failure);
        return {
          model: "fixture-reviewer",
          usage,
          result: { decision: "change_approach", guidance: "Use addition." },
        };
      },
    });
    expect(result.status).toBe("succeeded");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("on attempts 1 and 2");
    expect(asked[0]).toContain("node --test math.test.cjs exited 1");
    // A local reviewer also sees the latest output.
    expect(asked[0]).toContain("not ok 1 - add");
    expect(feedback[2]).toContain(
      "The reviewer's decision after the repeated failure: change approach. Use addition.",
    );
    expect(
      events.find((event) => event.type === "attempt.repeat_decision")?.data,
    ).toMatchObject({
      attempt: 2,
      providerId: "reviewer",
      decision: "change_approach",
    });
  });

  it("stops at once when the reviewer judges a repeated failure blocked", async () => {
    const { result, feedback } = await run({
      attempts: 5,
      edits: ["a * b", "a / b", "a % b"],
      codes: () => 1,
      repeatDecision: async () => ({
        model: "fixture-reviewer",
        usage,
        result: {
          decision: "blocked",
          guidance: "The check imports a file that does not exist.",
        },
      }),
    });
    expect(result.status).toBe("failed");
    expect(feedback).toHaveLength(2);
    expect(result.error).toContain("the reviewer judged the run blocked");
    expect(classifyError(result.error!)).toBe("repeated-failure");
  });

  it("falls back to the change-approach notice when the reviewer's decision fails", async () => {
    const { result, feedback, events } = await run({
      attempts: 3,
      edits: ["a * b", "a / b", "a + b"],
      codes: fixedWhen("a + b"),
      repeatDecision: async () => {
        throw new Error("HTTP 503 from the provider");
      },
    });
    expect(result.status).toBe("succeeded");
    expect(feedback[2]).toContain("failed exactly as");
    expect(feedback[2]).not.toContain("The reviewer's decision");
    expect(
      events.find((event) => event.type === "attempt.repeat_decision")?.data,
    ).toMatchObject({ attempt: 2, failed: "provider-call" });
  });

  it("asks the reviewer only on the first repeat, and still stops at the third", async () => {
    let asked = 0;
    const { result, feedback } = await run({
      attempts: 5,
      edits: ["a * b", "a / b", "a % b", "a + b"],
      codes: () => 1,
      repeatDecision: async () => {
        asked++;
        return {
          model: "fixture-reviewer",
          usage,
          result: { decision: "narrow_scope", guidance: "Only change add." },
        };
      },
    });
    expect(asked).toBe(1);
    expect(feedback[2]).toContain(
      "The reviewer's decision after the repeated failure: narrow the scope. Only change add.",
    );
    expect(result.status).toBe("failed");
    expect(feedback).toHaveLength(3);
    expect(result.error).toContain("on three attempts in a row");
  });

  it("gives a cloud reviewer the failing checks and exit codes but never their output, and passes its guidance to a cloud worker", async () => {
    const asked: string[] = [];
    const { result, feedback } = await run({
      cloud: true,
      attempts: 3,
      edits: ["a * b", "a / b", "a + b"],
      codes: fixedWhen("a + b"),
      repeatDecision: async (input) => {
        asked.push(input.failure);
        return {
          model: "fixture-reviewer",
          usage,
          result: { decision: "change_approach", guidance: "Use addition." },
        };
      },
    });
    expect(result.status).toBe("succeeded");
    expect(asked[0]).toContain("node --test math.test.cjs exited 1");
    expect(asked[0]).not.toContain("not ok 1 - add");
    // A cloud worker gets the notices and guidance, never the output.
    expect(feedback[2]).not.toContain("not ok 1 - add");
    expect(feedback[2]).toContain("failed exactly as");
    expect(feedback[2]).toContain("change approach. Use addition.");
  });

  it("records a repeat decision refused by the cost cap as cost-cap", async () => {
    const { events } = await run({
      attempts: 3,
      edits: ["a * b", "a / b", "a + b"],
      codes: fixedWhen("a + b"),
      repeatDecision: async () => {
        throw new Error(
          "The next call exceeds the configured estimated cost budget",
        );
      },
    });
    expect(
      events.find((event) => event.type === "attempt.repeat_decision")?.data,
    ).toMatchObject({ failed: "cost-cap" });
  });
});
