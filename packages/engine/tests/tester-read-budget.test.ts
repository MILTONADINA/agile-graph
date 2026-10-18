import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertProjectConfig,
  assertProjectPolicy,
  DEFAULT_POLICY,
  readTurnBudget,
  type ProjectConfig,
} from "@agile-graph/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, hash, writeJson } from "../src/util.js";
import {
  READ_BUDGET_NOTICE,
  READ_BUDGET_REFUSAL,
} from "../src/execution/requested-sources.js";
import type { WorkerInput, WorkerResult } from "../src/workers/api.js";
import { viewing } from "./worker-view.js";
import { ContextEngine } from "../src/context/index.js";
import { testerFocusPaths } from "../src/execution/tester-context.js";
import { DEFAULT_TEST_FILES } from "../src/tester.js";

const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

// A toy repository: a slug helper with an existing test in another
// directory under a name unrelated to it, notes that mention the helper
// often enough to fill a small budget, and a few unrelated files.
async function fixture(
  configure?: (config: ProjectConfig) => void,
  tester = true,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-read-budget-"));
  directories.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "checks"));
  await mkdir(path.join(root, "notes"));
  await writeFile(
    path.join(root, "src", "slugify.js"),
    "export function slugify(text) {\n  return text.toLowerCase().replaceAll(' ', '-');\n}\n",
  );
  await writeFile(
    path.join(root, "checks", "cases.test.js"),
    "import { slugify } from '../src/slugify.js';\ntest('lower case words', () => expect(slugify('A B')).toBe('a-b'));\n",
  );
  for (let index = 0; index < 40; index++)
    await writeFile(
      path.join(root, "notes", `slugify-trim-${index}.md`),
      `# Slugify trim note ${index}\n\n${"Slugify should trim whitespace before it joins words. ".repeat(12)}\n`,
    );
  for (let index = 1; index <= 6; index++)
    await writeFile(
      path.join(root, `part${index}.js`),
      `export const part${index} = ${index};\n`,
    );
  const config = await initializeProject(root);
  config.policy.providers = tester ? ["local", "tester"] : ["local"];
  config.verification = [{ image: "fixture", argv: ["test"] }];
  if (tester) config.tester = { providerId: "tester" };
  configure?.(config);
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  directories.push(data);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
  });
  if (tester)
    await configureProvider(data, {
      id: "tester",
      kind: "local",
      model: "tester-fixture",
    });
  return { root, config };
}
const passing: NonNullable<EngineDependencies["verify"]> = async (
  _workspace,
  checks,
  _policy,
  snapshotHash,
) =>
  checks.map((check) => ({
    ...check,
    code: 0,
    stdout: "pass",
    stderr: "",
    snapshotHash,
  }));
async function open(root: string, deps: EngineDependencies) {
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    verify: passing,
    ...deps,
  });
  engines.push(engine);
  return engine;
}
const answer = (
  proposal: Partial<WorkerResult["proposal"]> = {},
): WorkerResult => ({
  model: "fixture",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
  proposal: {
    summary: "Step",
    requests: [],
    changes: [],
    ...proposal,
  },
});
const testFile = answer({
  changes: [
    {
      path: "checks/trim.test.js",
      before: null,
      after: "test('trims', () => {});\n",
    },
  ],
});
const implementation = answer({
  changes: [
    {
      path: "src/slugify.js",
      before: "text.toLowerCase()",
      after: "text.trim().toLowerCase()",
    },
  ],
});
// The implementer edits src/slugify.js, so it must have been shown it.
const implement = viewing(["src/slugify.js"], async () => implementation);
// The budget tests spend the whole read budget on the tester, so their
// implementer creates a file instead of editing one it would have to read.
const creation = answer({
  changes: [
    { path: "src/trim.js", before: null, after: "exports.trim = 1;\n" },
  ],
});
const objective = "Make slugify trim whitespace";
async function plan(engine: GraphEngine) {
  return engine.createPlan({
    objective,
    acceptance: ["slugify trims leading and trailing whitespace"],
    providerId: "local",
    steps: [
      {
        id: "implement",
        kind: "worker",
        objective,
        dependsOn: [],
        providerId: "local",
      },
    ],
  });
}
const paths = (input: WorkerInput) =>
  new Set(input.context.items.map((item) => item.source?.path));

describe("tester's first packet", () => {
  it("leads the tester's first packet with a related existing test and the module it exercises", async () => {
    // A small budget, so the notes that mention the helper can fill it.
    const { root } = await fixture((value) => {
      value.policy.maxContextTokens = 8000;
    });
    const first = new Map<string, WorkerInput>();
    const worker = vi.fn(async (input: WorkerInput) => {
      if (!first.has(input.provider.id)) first.set(input.provider.id, input);
      return input.provider.id === "tester" ? testFile : implement(input, "");
    });
    const engine = await open(root, { worker });
    const run = await engine.wait(
      (await engine.start((await plan(engine)).id)).id,
    );
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("succeeded");
    const tester = paths(first.get("tester")!);
    expect(tester).toContain("checks/cases.test.js");
    expect(tester).toContain("src/slugify.js");
    // The same budget without the tester's focus is filled by the notes
    // that mention the helper, so the existing test is not retrieved.
    expect(paths(first.get("local")!)).not.toContain("checks/cases.test.js");
    expect(first.get("tester")!.context.estimatedTokens).toBeLessThanOrEqual(
      first.get("tester")!.context.budgetTokens,
    );
  });

  it("names the related test first and screens every path with the caller's export rule", async () => {
    const { root, config } = await fixture();
    const engine = new ContextEngine({
      projectId: config.projectId,
      root,
      dataDir: path.join(root, ".graph", "test-context"),
      policy: config.policy,
    });
    try {
      const snapshot = await engine.index();
      const focus = (allowed: (file: string) => boolean) =>
        testerFocusPaths({
          engine,
          files: [
            "src/slugify.js",
            "checks/cases.test.js",
            ...Array.from({ length: 6 }, (_, i) => `part${i + 1}.js`),
          ],
          testFiles: DEFAULT_TEST_FILES,
          text: [objective, "slugify trims leading and trailing whitespace"],
          snapshotId: snapshot.id,
          allowed,
        });
      expect(await focus(() => true)).toEqual([
        "checks/cases.test.js",
        "src/slugify.js",
      ]);
      // A cloud tester's rule keeps the private test out entirely.
      expect(await focus((file) => !file.startsWith("checks/"))).toEqual([
        "src/slugify.js",
      ]);
    } finally {
      await engine.close();
    }
  });
});

describe("read budget", () => {
  it("counts request-only results against the read budget, then tells the worker to propose", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 8;
      value.policy.maxReadTurns = 2;
    });
    const feedback: (string | undefined)[] = [];
    const worker = vi.fn(async (input: WorkerInput) => {
      if (input.provider.id !== "tester") return creation;
      feedback.push(input.feedback);
      return feedback.length <= 2
        ? answer({ requests: [`part${feedback.length}.js`] })
        : testFile;
    });
    const engine = await open(root, { worker });
    const run = await engine.wait(
      (await engine.start((await plan(engine)).id)).id,
    );
    expect(run.status).toBe("succeeded");
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "worker.read"),
    ).toHaveLength(2);
    expect(feedback[1] ?? "").not.toContain(READ_BUDGET_NOTICE);
    expect(feedback[2]).toContain(READ_BUDGET_NOTICE);
    // The budget is the run's: the implementer is told too.
    const implementer = worker.mock.calls
      .map(([input]) => input)
      .find((input) => input.provider.id === "local")!;
    expect(implementer.feedback).toContain(READ_BUDGET_NOTICE);
  });

  it("refuses a request after the read budget is spent with feedback, and accepts the proposal that follows", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 8;
      value.policy.maxReadTurns = 1;
    });
    const feedback: (string | undefined)[] = [];
    const worker = vi.fn(async (input: WorkerInput) => {
      if (input.provider.id !== "tester") return creation;
      feedback.push(input.feedback);
      return feedback.length <= 2
        ? answer({ requests: [`part${feedback.length}.js`] })
        : testFile;
    });
    const engine = await open(root, { worker });
    const run = await engine.wait(
      (await engine.start((await plan(engine)).id)).id,
    );
    expect(run.status).toBe("succeeded");
    expect(feedback[1]).toContain(READ_BUDGET_NOTICE);
    expect(feedback[2]).toBe(READ_BUDGET_REFUSAL);
    // The refused request sent no file: part2.js never reached the tester.
    const third = worker.mock.calls
      .map(([input]) => input)
      .filter((input) => input.provider.id === "tester")[2]!;
    expect(paths(third)).not.toContain("part2.js");
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "proposal.returned")
        .map((event) => event.data.reason),
    ).toContain("read-budget");
  });

  it("stops a worker that keeps requesting after the refusal, without a call beyond maxTurns", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 6;
      value.policy.maxReadTurns = 1;
    });
    let calls = 0;
    const worker = vi.fn(async () =>
      answer({ requests: [`part${++calls}.js`] }),
    );
    const engine = await open(root, { worker });
    const run = await engine.wait(
      (await engine.start((await plan(engine)).id)).id,
    );
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/read budget \(policy\.maxReadTurns\) was spent/);
    // One answered read, one refused with feedback, one that stops the run.
    expect(worker).toHaveBeenCalledTimes(3);
  });

  it.each([
    { maxTurns: 4, maxReadTurns: 4, tester: true },
    { maxTurns: 5, maxReadTurns: undefined, tester: true },
    { maxTurns: 3, maxReadTurns: 3, tester: false },
    { maxTurns: 1, maxReadTurns: undefined, tester: false },
  ])(
    "never makes more model calls than maxTurns ($maxTurns, read budget $maxReadTurns, tester $tester)",
    async ({ maxTurns, maxReadTurns, tester }) => {
      const { root } = await fixture((value) => {
        value.policy.maxTurns = maxTurns;
        if (maxReadTurns !== undefined)
          value.policy.maxReadTurns = maxReadTurns;
      }, tester);
      let calls = 0;
      // Always asks for a new file, and never proposes anything.
      const worker = vi.fn(async () =>
        answer({ requests: [`part${(++calls % 6) + 1}.js`] }),
      );
      const engine = await open(root, { worker });
      const run = await engine.wait(
        (await engine.start((await plan(engine)).id)).id,
      );
      expect(run.status).toBe("failed");
      expect(worker.mock.calls.length).toBeLessThanOrEqual(maxTurns);
      expect(
        engine.store
          .events(run.id)
          .filter((event) => event.type === "worker.completed"),
      ).toHaveLength(worker.mock.calls.length);
    },
  );
});

describe("maxReadTurns policy", () => {
  const config = (policy: unknown) => ({
    version: "1.0.0",
    projectId: "read-budget-toy",
    name: "Toy read budget",
    policy,
    verification: [],
  });

  it("keeps the hash of every policy without maxReadTurns", () => {
    expect(DEFAULT_POLICY).not.toHaveProperty("maxReadTurns");
    const set = { ...DEFAULT_POLICY, maxReadTurns: 3 };
    expect(hash(set)).not.toBe(hash(DEFAULT_POLICY));
    const removed: Partial<typeof set> = { ...set };
    delete removed.maxReadTurns;
    expect(hash(removed)).toBe(hash(DEFAULT_POLICY));
    // Hashes of policies already in use do not move.
    const existing = {
      ...DEFAULT_POLICY,
      maxTurns: 30,
      requirePlanApproval: true,
    };
    expect(hash(JSON.parse(JSON.stringify(existing)))).toBe(hash(existing));
  });

  it("defaults to half of maxTurns and accepts only a budget within maxTurns", () => {
    expect(readTurnBudget({ maxTurns: 12 })).toBe(6);
    expect(readTurnBudget({ maxTurns: 1 })).toBe(0);
    expect(readTurnBudget({ maxTurns: 12, maxReadTurns: 12 })).toBe(12);
    for (const maxReadTurns of [0, 1, 12]) {
      const policy = { ...DEFAULT_POLICY, maxReadTurns };
      expect(() => assertProjectPolicy(policy)).not.toThrow();
      expect(() => assertProjectConfig(config(policy))).not.toThrow();
    }
    expect(() =>
      assertProjectPolicy({ ...DEFAULT_POLICY, maxReadTurns: 13 }),
    ).toThrow("maxReadTurns (13) must be at most maxTurns (12)");
    expect(() =>
      assertProjectConfig(config({ ...DEFAULT_POLICY, maxReadTurns: 13 })),
    ).toThrow("Invalid project configuration: maxReadTurns (13)");
    for (const maxReadTurns of [-1, 0.5, 101, "6", null, true])
      expect(() =>
        assertProjectConfig(config({ ...DEFAULT_POLICY, maxReadTurns })),
      ).toThrow("Invalid project configuration");
  });
});
