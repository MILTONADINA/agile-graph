import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertProjectPolicy,
  DEFAULT_POLICY,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, hash, writeJson } from "../src/util.js";
import type { WorkerInput, WorkerResult } from "../src/workers/api.js";
import { generateMutants, notExecutable } from "../src/execution/mutants.js";
import { runEvidence } from "../src/overview.js";

const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const CLAMP =
  "// Clamp a number to a maximum.\nexport function clamp(n, max) {\n  if (n > max) {\n    return max;\n  }\n  return n;\n}\n";

describe("mutant generation", () => {
  it("mutates operators, conditions and returns on executable lines only", () => {
    const mutants = generateMutants("src/clamp.js", CLAMP);
    expect(
      mutants.map(({ line, description }) => `${line}: ${description}`),
    ).toEqual([
      "3: replaced > with >=",
      "3: negated the condition",
      "4: returned a constant 0",
      "6: returned a constant 0",
    ]);
    expect(mutants[0]!.content).toContain("if (n >= max) {");
    expect(mutants[1]!.content).toContain("if (!(n > max)) {");
    // Deterministic: the same input gives the same mutants.
    expect(generateMutants("src/clamp.js", CLAMP)).toEqual(mutants);
  });

  it("leaves arrows, strings, comments and imports alone and works on Python", () => {
    expect(
      generateMutants(
        "a.ts",
        "import { x } from './x';\n// a > b\nconst f = (a) => a;\nconst s = 'a < b';\n",
      ),
    ).toEqual([]);
    for (const line of ["", "  # note", " * doc", "import os", "  }"])
      expect(notExecutable(line)).toBe(true);
    expect(
      generateMutants(
        "m.py",
        "def total(a, b):\n    if a == b and a <= 3:\n        return a + b\n",
      ).map(({ line, description }) => `${line}: ${description}`),
    ).toEqual([
      "2: replaced == with !=",
      "2: replaced <= with <",
      "3: replaced + with -",
      "3: returned a constant 0",
    ]);
  });
});

async function fixture(configure?: (config: ProjectConfig) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mutation-"));
  directories.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "clamp.js"), CLAMP);
  for (let index = 1; index <= 3; index++)
    await writeFile(
      path.join(root, `part${index}.js`),
      `export const part${index} = ${index};\n`,
    );
  const config = await initializeProject(root);
  config.policy.providers = ["local", "tester"];
  config.policy.maxTurns = 8;
  config.verification = [{ image: "fixture", argv: ["test"] }];
  config.tester = { providerId: "tester" };
  configure?.(config);
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  directories.push(data);
  await configureProvider(data, { id: "local", kind: "local", model: "m" });
  await configureProvider(data, { id: "tester", kind: "local", model: "t" });
  return { root, config, data };
}

type Overlay = { path: string; content: string }[];
// A sandbox fake: a check fails when the tests in the view say "strict" and
// clamp.js is mutated, or when the baseline is told to fail.
function sandbox(baselinePasses = true) {
  const calls: { replaced: Overlay; added: Overlay }[] = [];
  const verify: NonNullable<EngineDependencies["verify"]> = async (
    _workspace,
    checks,
    _policy,
    snapshotHash,
    _signal,
    options,
  ) => {
    const replaced = (options?.replaced ?? []) as Overlay;
    const added = (options?.added ?? []) as Overlay;
    if (options) calls.push({ replaced, added });
    const mutated = replaced.some(
      (file) => file.path === "src/clamp.js" && file.content !== CLAMP,
    );
    const strict = added.some((file) => file.content.includes("strict"));
    const code = !options ? 0 : !baselinePasses ? 1 : mutated && strict ? 1 : 0;
    return checks.map((check) => ({
      ...check,
      code,
      stdout: "",
      stderr: "",
      snapshotHash,
    }));
  };
  return { verify, calls };
}

const answer = (
  proposal: Partial<WorkerResult["proposal"]> = {},
): WorkerResult => ({
  model: "fixture",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
  proposal: { summary: "Step", requests: [], changes: [], ...proposal },
});
const tests = (body: string) =>
  answer({
    changes: [{ path: "src/clamp.test.js", before: null, after: body }],
  });
const implementation = answer({
  changes: [
    { path: "src/clamp.js", before: "return n;", after: "return n ?? 0;" },
  ],
});

async function runWith(
  root: string,
  verify: NonNullable<EngineDependencies["verify"]>,
  tester: (input: WorkerInput, call: number) => WorkerResult,
) {
  const testerInputs: WorkerInput[] = [];
  const worker = vi.fn(async (input: WorkerInput) => {
    if (input.provider.id !== "tester") return implementation;
    testerInputs.push(input);
    return tester(input, testerInputs.length);
  });
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    verify,
    worker,
  });
  engines.push(engine);
  const plan = await engine.createPlan({
    objective: "Make clamp in src/clamp.js handle a missing number",
    acceptance: ["clamp returns 0 for a missing number"],
    providerId: "local",
    steps: [
      {
        id: "implement",
        kind: "worker",
        objective: "Make clamp handle a missing number",
        dependsOn: [],
        providerId: "local",
      },
    ],
  });
  const run = await engine.wait((await engine.start(plan.id)).id);
  const events = engine.store.events(run.id);
  return {
    run,
    events,
    testerInputs,
    analyses: events.filter((event) => event.type === "mutation.analyzed"),
  };
}

describe("mutation feedback to the tester", () => {
  it("is off without policy.mutationRounds and keeps the policy hash", async () => {
    const { root } = await fixture();
    const { verify, calls } = sandbox();
    const { run, analyses, testerInputs } = await runWith(root, verify, () =>
      tests("test('x', () => {});\n"),
    );
    expect(run.status).toBe("succeeded");
    expect(analyses).toEqual([]);
    expect(calls).toEqual([]);
    expect(testerInputs).toHaveLength(1);
    expect(DEFAULT_POLICY).not.toHaveProperty("mutationRounds");
    const set = { ...DEFAULT_POLICY, mutationRounds: 1 };
    expect(hash(set)).not.toBe(hash(DEFAULT_POLICY));
    expect(() =>
      assertProjectPolicy({ ...DEFAULT_POLICY, mutationRounds: 4 }),
    ).toThrow();
  }, 60000);

  it("sends surviving mutants back to the tester as locations and operators only, and records the score", async () => {
    const { root } = await fixture((config) => {
      config.policy.mutationRounds = 2;
    });
    const { verify, calls } = sandbox();
    const { run, analyses, testerInputs, events } = await runWith(
      root,
      verify,
      (_input, call) =>
        tests(
          call === 1
            ? "test('weak', () => {});\n"
            : "test('strict', () => {});\n",
        ),
    );
    expect(run.status).toBe("succeeded");
    expect(testerInputs).toHaveLength(2);
    const feedback = testerInputs[1]!.feedback!;
    expect(feedback).toContain("src/clamp.js:3: replaced > with >=");
    expect(feedback).toContain("src/clamp.js:6: returned a constant 0");
    // No source text reaches the tester through the feedback.
    expect(feedback).not.toContain("n > max");
    expect(feedback).not.toContain("clamp(");
    expect(analyses.map((event) => event.data)).toMatchObject([
      { round: 1, status: "analyzed", mutants: 4, killed: 0, score: 0 },
      { round: 2, status: "analyzed", mutants: 4, killed: 4, score: 1 },
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "proposal.returned" &&
          event.data.reason === "mutation-survivors",
      ),
    ).toHaveLength(1);
    // The workspace is never written: the tests and mutants are overlays.
    expect(calls.length).toBeGreaterThan(0);
    expect(runEvidence(events).mutation).toMatchObject({
      round: 2,
      status: "analyzed",
      score: 1,
    });
  }, 60000);

  it("skips the analysis when no check passes on the unmutated code", async () => {
    const { root } = await fixture((config) => {
      config.policy.mutationRounds = 1;
    });
    const { verify, calls } = sandbox(false);
    const { run, analyses, testerInputs } = await runWith(root, verify, () =>
      tests("test('weak', () => {});\n"),
    );
    expect(run.status).toBe("succeeded");
    expect(analyses.map((event) => event.data)).toMatchObject([
      { status: "baseline-failed", score: null, survived: 0 },
    ]);
    // Only the baseline ran; no mutant did.
    expect(calls).toHaveLength(1);
    expect(testerInputs).toHaveLength(1);
  }, 60000);

  it("never spends a round when no model call is left within maxTurns", async () => {
    const { root } = await fixture((config) => {
      config.policy.mutationRounds = 1;
      config.policy.maxTurns = 4;
      config.policy.maxReadTurns = 3;
    });
    const { verify, calls } = sandbox();
    const { run, analyses, testerInputs } = await runWith(
      root,
      verify,
      (_input, call) =>
        call <= 3 ? answer({ requests: [`part${call}.js`] }) : tests("weak\n"),
    );
    expect(testerInputs).toHaveLength(4);
    expect(analyses.map((event) => event.data)).toEqual([
      { round: 1, status: "turn-budget" },
    ]);
    expect(calls).toEqual([]);
    expect(run.error ?? "").not.toMatch(/mutation/i);
  }, 60000);

  it("asks the local decision provider about each survivor and still feeds every survivor back in shadow mode", async () => {
    const LAYA = "http://127.0.0.1:7337/v1/decide";
    const { root, data } = await fixture((config) => {
      config.policy.mutationRounds = 1;
      config.policy.providers = ["local", "tester", "laya"];
    });
    await writeJson(path.join(data, "decisions.json"), [
      {
        id: "laya",
        endpoint: LAYA,
        model: "fixture-only",
        maxStateChars: 20000,
      },
    ]);
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url) !== LAYA)
          throw new Error(`Unexpected network call to ${String(url)}`);
        const questions = JSON.parse(String(init?.body)).questions as Record<
          string,
          { criteria: Record<string, string> }
        >;
        const answers = Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            const keys = Object.keys(question.criteria);
            if (keys.includes("equivalent")) asked.push(id);
            return [
              id,
              {
                choice: keys.includes("equivalent") ? "equivalent" : keys[0],
                confidence: 1,
              },
            ];
          }),
        );
        return new Response(JSON.stringify({ model: "fixture-only", answers }));
      }),
    );
    const { verify } = sandbox();
    const { run, analyses, testerInputs, events } = await runWith(
      root,
      verify,
      () => tests("test('weak', () => {});\n"),
    );
    expect(run.status).toBe("succeeded");
    expect(asked).toHaveLength(4);
    expect(
      events.some((event) => event.type === "decision.mutant_equivalence"),
    ).toBe(true);
    expect(analyses[0]!.data).toMatchObject({ survived: 4, equivalent: 0 });
    expect(testerInputs[1]!.feedback).toContain(
      "src/clamp.js:3: replaced > with >=",
    );
  }, 60000);
});
