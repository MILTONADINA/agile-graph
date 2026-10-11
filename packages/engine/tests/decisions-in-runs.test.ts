import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  assertProjectPolicy,
  type ContextItem,
  type DecisionRecord,
  type ProjectPolicy,
  type RunEvent,
} from "@graph-engineering/contracts";
import {
  contextSelectionCandidates,
  selectContext,
  type DecisionSession,
  type SelectionCandidate,
} from "../src/decision-controls.js";
import { decideBatch } from "../src/decision-batch.js";
import { decisionLedgerBudget } from "../src/accounting.js";
import {
  packetSavings,
  summarizeContextInsights,
} from "../src/insights-context.js";
import { RunStore } from "../src/store.js";
import { checked, hash, writeJson } from "../src/util.js";
import { GraphEngine } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";

// Synthetic toy data only: no real project, provider or key is involved.
const model = "unit-hosted-model";
const directories: string[] = [];
const stores: RunStore[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function tempDir(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
const hostedPolicy = (extra: Partial<ProjectPolicy> = {}): ProjectPolicy => ({
  ...DEFAULT_POLICY,
  inference: "allowlisted",
  network: "allowlisted",
  allowedHosts: ["api.example.test"],
  providers: ["jev"],
  exportPaths: ["src/**"],
  ...extra,
});
const jev = {
  id: "jev",
  model,
  endpoint: "https://api.example.test/decide",
  maxStateChars: 1200,
  pricing: {
    unit: "question" as const,
    usdPerUnit: 0.002,
    version: "unit-reviewed-rate",
  },
};
const session = (policy = hostedPolicy()): DecisionSession => ({
  projectId: "unit-project",
  state: { stepCount: 1 },
  cloudState: { stepCount: 1 },
  policy,
  providers: [jev],
  evidence: [],
});
/** Answers every question it receives with `include`. */
function answerAll() {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, unknown>;
    };
    return new Response(
      JSON.stringify({
        model,
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            { choice: "include", confidence: 0.9 },
          ]),
        ),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const questionId = (candidate: string) =>
  `item-${hash(candidate).slice(0, 16)}`;
const sentQuestions = (fetch: ReturnType<typeof answerAll>) =>
  fetch.mock.calls.flatMap((call) =>
    Object.keys(
      (JSON.parse(String(call[1]?.body)) as { questions: object }).questions,
    ),
  );

describe("hosted context selection", () => {
  it("marks only context items on exportable paths as exportable selection candidates", () => {
    const items: ContextItem[] = [
      {
        id: "a",
        kind: "code",
        text: "x",
        score: 1,
        source: { path: "src/a.ts", startLine: 1, endLine: 4 },
      } as ContextItem,
      {
        id: "b",
        kind: "code",
        text: "x",
        score: 1,
        source: { path: "private/b.ts", startLine: 1, endLine: 4 },
      } as ContextItem,
      {
        id: "c",
        kind: "document",
        text: "x",
        score: 1,
        source: { path: "src/.env", startLine: 1, endLine: 1 },
      } as ContextItem,
      { id: "d", kind: "memory", text: "remember", score: 1, memoryId: "m" },
    ];
    expect(
      contextSelectionCandidates(items, hostedPolicy()).map((candidate) => [
        candidate.id,
        candidate.exportable,
      ]),
    ).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", false],
    ]);
  });
  it("sends an all-exportable context selection to a hosted decision provider", async () => {
    const fetch = answerAll();
    // A run's items on exportable paths, mapped as the run maps them.
    const candidates = contextSelectionCandidates(
      ["src/a.ts", "src/b.ts"].map(
        (file) =>
          ({
            id: file,
            kind: "code",
            text: "x",
            score: 1,
            source: { path: file, startLine: 1, endLine: 4 },
          }) as ContextItem,
      ),
      hostedPolicy(),
    );
    const result = await selectContext({ ...session(), candidates });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.records).toHaveLength(2);
    expect(result.records.every((record) => record.provider === "jev")).toBe(
      true,
    );
    expect(
      result.records.every((record) => record.selected === "include"),
    ).toBe(true);
    expect(
      result.records.some((record) => record.evidence.failure !== undefined),
    ).toBe(false);
  });
  it("keeps a non-exportable candidate local-only while exportable candidates still reach the hosted provider", async () => {
    const fetch = answerAll();
    const candidates: SelectionCandidate[] = [
      {
        id: "src/a.ts:1-4",
        kind: "file",
        label: "src/a.ts:1-4",
        exportable: true,
      },
      { id: "private/b.ts:1-4", kind: "file", label: "private/b.ts:1-4" },
      {
        id: "src/c.ts:1-4",
        kind: "file",
        label: "src/c.ts:1-4",
        exportable: true,
      },
    ];
    const result = await selectContext({ ...session(), candidates });
    const sent = sentQuestions(fetch);
    expect(sent.sort()).toEqual(
      [questionId("src/a.ts:1-4"), questionId("src/c.ts:1-4")].sort(),
    );
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("private/b.ts");
    const local = result.records.find(
      (record) => record.evidence.questionId === questionId("private/b.ts:1-4"),
    );
    expect(local?.selected).toBeNull();
    expect(String(local?.evidence.failure)).toContain(
      "explicitly exportable state and questions",
    );
    expect(
      result.records.filter((record) => record.selected === "include"),
    ).toHaveLength(2);
    // Mandatory baseline still includes the local-only item.
    expect(result.selectedIds.sort()).toEqual(
      ["private/b.ts:1-4", "src/a.ts:1-4", "src/c.ts:1-4"].sort(),
    );
  });
});

describe("decision-only cost cap", () => {
  const question = {
    id: "workflow",
    category: "workflow",
    candidates: { safe: "Baseline", alternative: "Alternative" },
    baseline: "safe",
    exportable: true,
  };
  const batch = (policy: ProjectPolicy) => ({
    projectId: "unit-project",
    state: { files: 2 },
    cloudState: { files: 2 },
    questions: [question],
    policy,
    providers: [jev],
    evidence: [],
    budget: { reserve: vi.fn(async () => {}), settle: vi.fn(async () => {}) },
  });
  it("lets Jev decide under decisionMaxCostUsd while workers keep maxCostUsd 0", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model,
            answers: { workflow: { choice: "alternative", confidence: 0.9 } },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const input = batch(hostedPolicy({ maxCostUsd: 0, decisionMaxCostUsd: 1 }));
    const result = await decideBatch(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(input.budget.reserve).toHaveBeenCalledTimes(1);
    expect(result.records[0]?.selected).toBe("alternative");
    expect(typeof result.records[0]?.evidence.latencyMs).toBe("number");
    expect(typeof result.records[0]?.evidence.batchId).toBe("string");
  });
  it("refuses hosted decisions under a zero decisionMaxCostUsd even when maxCostUsd allows spend", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const input = batch(hostedPolicy({ maxCostUsd: 5, decisionMaxCostUsd: 0 }));
    const result = await decideBatch(input);
    expect(fetch).not.toHaveBeenCalled();
    expect(String(result.records[0]?.evidence.failure)).toContain(
      "cost ceiling",
    );
  });
  it("validates decisionMaxCostUsd and leaves it out of the default policy", () => {
    expect("decisionMaxCostUsd" in DEFAULT_POLICY).toBe(false);
    expect(() =>
      assertProjectPolicy({ ...DEFAULT_POLICY, decisionMaxCostUsd: 1 }),
    ).not.toThrow();
    expect(() =>
      assertProjectPolicy({ ...DEFAULT_POLICY, decisionMaxCostUsd: null }),
    ).not.toThrow();
    expect(() =>
      assertProjectPolicy({ ...DEFAULT_POLICY, decisionMaxCostUsd: -1 }),
    ).toThrow();
    expect(() =>
      assertProjectPolicy({
        ...DEFAULT_POLICY,
        decisionMaxCostUsd: "1",
      } as unknown as ProjectPolicy),
    ).toThrow();
  });
  it("charges decisions to a daily project ledger, refuses once the day's cap is spent, and still refuses workers at maxCostUsd 0", async () => {
    const store = new RunStore(
      await tempDir("graph-decision-cap-"),
      "project-cap",
    );
    stores.push(store);
    const policy = { maxCostUsd: 0, decisionMaxCostUsd: 0.01 };
    let clock = Date.parse("2026-10-10T23:00:00Z");
    const budget = decisionLedgerBudget({
      store,
      policy: () => policy,
      ownerId: "plan-unit",
      nowMs: () => clock,
    });
    const usage = (callId: string) => ({
      callId,
      provider: "jev",
      model,
      questionCount: 1,
      inputTokens: 10,
      outputTokens: 1,
      reportedCostUsd: null,
      estimatedCostUsd: 0.004,
      chargedUsd: 0.004,
      reservedUsd: 0.004,
      priceVersion: "unit-reviewed-rate",
      costUnknown: false,
      outcome: "completed" as const,
    });
    for (const callId of ["d1", "d2"]) {
      await budget.reserve({ callId, provider: "jev", amountUsd: 0.004 });
      await budget.settle(usage(callId));
    }
    expect(store.usage("decisions-2026-10-10").costUsd).toBeCloseTo(0.008);
    expect(store.usage("plan-unit").costUsd ?? 0).toBe(0);
    await expect(
      budget.reserve({ callId: "d3", provider: "jev", amountUsd: 0.004 }),
    ).rejects.toThrow();
    // A worker call stays under maxCostUsd 0 and is refused.
    expect(() =>
      store.reserveCall(
        "plan-unit",
        "worker-x",
        "cloud",
        0.001,
        policy.maxCostUsd,
      ),
    ).toThrow();
    // The next UTC day has a fresh decision cap.
    clock = Date.parse("2026-10-11T00:00:01Z");
    await budget.reserve({ callId: "d4", provider: "jev", amountUsd: 0.004 });
    expect(store.usage("decisions-2026-10-11").costUsd).toBeCloseTo(0.004);
  });
  it("settles an unpriced call under no cap on the ledger of the day it was sent", async () => {
    const store = new RunStore(
      await tempDir("graph-decision-cap-"),
      "project-cap",
    );
    stores.push(store);
    let clock = Date.parse("2026-10-10T23:59:59Z");
    const budget = decisionLedgerBudget({
      store,
      policy: () => ({ maxCostUsd: 0, decisionMaxCostUsd: null }),
      ownerId: "plan-unit",
      nowMs: () => clock,
    });
    await budget.reserve({ callId: "d1", provider: "jev", amountUsd: null });
    // The response arrives after midnight.
    clock = Date.parse("2026-10-11T00:00:02Z");
    await budget.settle({
      callId: "d1",
      provider: "jev",
      model: "jev-unit",
      questionCount: 1,
      inputTokens: 10,
      outputTokens: 1,
      reportedCostUsd: 0.003,
      estimatedCostUsd: null,
      chargedUsd: 0.003,
      reservedUsd: null,
      priceVersion: null,
      costUnknown: false,
      outcome: "completed",
    });
    expect(store.usage("decisions-2026-10-10").costUsd).toBeCloseTo(0.003);
    expect(store.usage("decisions-2026-10-11").costUsd ?? 0).toBe(0);
  });

  it("keeps decisions on the run's ledger under maxCostUsd when no decision cap is set", async () => {
    const store = new RunStore(
      await tempDir("graph-decision-cap-"),
      "project-cap",
    );
    stores.push(store);
    const budget = decisionLedgerBudget({
      store,
      policy: () => ({ maxCostUsd: 0.005 }),
      ownerId: "plan-unit",
      nowMs: () => Date.parse("2026-10-10T12:00:00Z"),
    });
    await budget.reserve({ callId: "d1", provider: "jev", amountUsd: 0.004 });
    expect(store.usage("plan-unit").costUsd).toBeCloseTo(0.004);
    await expect(
      budget.reserve({ callId: "d2", provider: "jev", amountUsd: 0.004 }),
    ).rejects.toThrow();
  });
});

describe("insights-context", () => {
  it("measures a packet's excerpts against the whole files they came from without reading contents into the result", async () => {
    const root = await tempDir("graph-packet-");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/a.ts"), "a".repeat(4000));
    await writeFile(path.join(root, "src/b.ts"), "b".repeat(1000));
    const result = await packetSavings(root, {
      estimatedTokens: 500,
      items: [
        {
          id: "1",
          kind: "code",
          text: "a".repeat(400),
          score: 1,
          source: { path: "src/a.ts", startLine: 1, endLine: 4 },
        },
        {
          id: "2",
          kind: "code",
          text: "a".repeat(400),
          score: 1,
          source: { path: "src/a.ts", startLine: 9, endLine: 12 },
        },
        {
          id: "3",
          kind: "code",
          text: "b".repeat(200),
          score: 1,
          source: { path: "src/b.ts", startLine: 1, endLine: 2 },
        },
        {
          id: "4",
          kind: "code",
          text: "c",
          score: 1,
          source: { path: "../outside.ts", startLine: 1, endLine: 1 },
        },
        { id: "5", kind: "memory", text: "m".repeat(800), score: 1 },
      ] as ContextItem[],
    });
    const { tokensForBytes, estimateTokens } = await import("../src/tokens.js");
    expect(result).toEqual({
      packetTokens: 500,
      excerptTokens:
        2 * estimateTokens("a".repeat(400)) +
        estimateTokens("b".repeat(200)) +
        estimateTokens("c"),
      wholeFileTokens: tokensForBytes(4000) + tokensForBytes(1000),
      files: 3,
      unreadableFiles: 1,
    });
    expect(JSON.stringify(result)).not.toContain("src/");
  });
  it("counts a workspace symlink to a file outside the workspace as unreadable", async () => {
    const outside = await tempDir("graph-packet-outside-");
    await writeFile(path.join(outside, "big.ts"), "z".repeat(40000));
    const root = await tempDir("graph-packet-");
    await mkdir(path.join(root, "src"));
    await symlink(path.join(outside, "big.ts"), path.join(root, "src/link.ts"));
    const result = await packetSavings(root, {
      estimatedTokens: 10,
      items: [
        {
          id: "1",
          kind: "code",
          text: "z",
          score: 1,
          source: { path: "src/link.ts", startLine: 1, endLine: 1 },
        },
      ] as ContextItem[],
    });
    expect(result.wholeFileTokens).toBe(0);
    expect(result.unreadableFiles).toBe(1);
  });
  it("reports context savings per run and in total, and decision quality per provider and category", () => {
    const event = (runId: string, data: object): RunEvent => ({
      version: "1.0.0",
      id: `${runId}-${Math.random()}`,
      runId,
      projectId: "p",
      at: "2026-10-10T00:00:00Z",
      type: "context.packet",
      data: data as Record<string, unknown>,
    });
    const packet = (excerpt: number, whole: number) => ({
      packetTokens: excerpt + 10,
      excerptTokens: excerpt,
      wholeFileTokens: whole,
      files: 1,
      unreadableFiles: 0,
    });
    const record = (
      provider: string,
      selected: string | null,
      evidence: Record<string, unknown>,
      category = "file-selection",
    ): DecisionRecord => ({
      version: "1.0.0",
      id: `${provider}-${Math.random()}`,
      projectId: "p",
      category,
      candidates: ["include", "exclude"],
      selected,
      baseline: "include",
      provider,
      modelVersion: "m",
      policyVersion: "v",
      confidence: selected ? 0.9 : null,
      mode: "shadow",
      createdAt: "2026-10-10T00:00:00Z",
      evidence,
    });
    const decisions = [
      record("laya", "include", {
        batchId: "b1",
        questionId: "q1",
        callId: "l1",
        latencyMs: 40,
      }),
      record("laya", "exclude", {
        batchId: "b1",
        questionId: "q2",
        callId: "l1",
        latencyMs: 40,
      }),
      record("jev", "include", {
        batchId: "b1",
        questionId: "q1",
        callId: "j1",
        latencyMs: 300,
        usage: { chargedUsd: 0.002 },
      }),
      record("jev", "include", {
        batchId: "b1",
        questionId: "q2",
        callId: "j1",
        latencyMs: 300,
      }),
      record("jev", null, {
        batchId: "b2",
        questionId: "q3",
        callId: "j2",
        failure:
          "Hosted decisions require explicitly exportable state and questions",
      }),
    ];
    const report = summarizeContextInsights(
      [
        {
          runId: "r1",
          events: [
            event("r1", packet(100, 1000)),
            event("r1", packet(50, 500)),
          ],
        },
        { runId: "r2", events: [] },
      ],
      decisions,
    );
    expect(report.contextSavings.runs).toEqual([
      {
        runId: "r1",
        packets: 2,
        packetTokens: 170,
        excerptTokens: 150,
        wholeFileTokens: 1500,
        savedTokens: 1350,
        ratio: 0.1,
        unreadableFiles: 0,
      },
    ]);
    expect(report.contextSavings.total).toMatchObject({
      runs: 1,
      excerptTokens: 150,
      wholeFileTokens: 1500,
      savedTokens: 1350,
    });
    const jevRow = report.decisionQuality.byProviderCategory.find(
      (row) => row.provider === "jev",
    );
    expect(jevRow).toMatchObject({
      questions: 3,
      answered: 2,
      abstained: 1,
      abstainReasons: {
        "Hosted decisions require explicitly exportable state and questions": 1,
      },
      latencyMs: { calls: 1, mean: 300, max: 300 },
      spendUsd: 0.002,
    });
    expect(report.decisionQuality.agreement).toEqual([
      {
        providers: ["jev", "laya"],
        category: "file-selection",
        compared: 2,
        agreed: 1,
        rate: 0.5,
      },
    ]);
  });
});

describe("hosted decisions in a GraphEngine run", () => {
  const JEV = "https://api.example.test/decide";
  /**
   * A toy git project whose policy lets Jev decide under decisionMaxCostUsd
   * while a priced hosted worker stays under maxCostUsd 0.
   */
  async function engineFixture() {
    const root = await tempDir("graph-decisions-run-");
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
    await checked("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "private"));
    await writeFile(
      path.join(root, "src/math.cjs"),
      "exports.add = (a, b) => a - b;\n",
    );
    await writeFile(
      path.join(root, "private/math-notes.cjs"),
      "// add helper notes\nexports.addNotes = (a, b) => a - b;\n",
    );
    const config = await initializeProject(root);
    Object.assign(config.policy, {
      inference: "allowlisted",
      network: "allowlisted",
      allowedHosts: ["api.example.test"],
      providers: ["cloud-unit", "jev"],
      exportPaths: ["src/**"],
      maxCostUsd: 0,
      decisionMaxCostUsd: 1,
    });
    config.verification = [{ image: "fixture", argv: ["test"] }];
    await writeJson(path.join(root, PROJECT_FILE), config);
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "test: initial fixture"], {
      cwd: root,
    });
    const data = projectDataDir(config.projectId);
    directories.push(data);
    await configureProvider(data, {
      id: "cloud-unit",
      kind: "openai",
      model: "unit-worker",
      endpoint: "https://api.example.test/v1",
      inputCostPerMillion: 1,
      outputCostPerMillion: 1,
    });
    await writeJson(path.join(data, "decisions.json"), [
      { ...jev, endpoint: JEV },
    ]);
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url) !== JEV)
          throw new Error(`Unexpected network call to ${String(url)}`);
        bodies.push(String(init?.body));
        const questions = JSON.parse(String(init?.body)).questions as Record<
          string,
          { criteria: Record<string, string> }
        >;
        const answers = Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [
            id,
            { choice: Object.keys(question.criteria)[0], confidence: 0.9 },
          ]),
        );
        return new Response(JSON.stringify({ model, answers }));
      }),
    );
    const worker = vi.fn(async () => {
      throw new Error("The worker must not be reached under maxCostUsd 0");
    });
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker,
      verify: async () => {
        throw new Error("This test's run does not reach its checks");
      },
    });
    engines.push(engine);
    return { engine, bodies, worker };
  }
  it("settles a run's hosted decisions on the daily decision ledger and refuses its worker under maxCostUsd 0", async () => {
    const { engine, bodies, worker } = await engineFixture();
    const plan = await engine.createPlan({
      objective: "Fix add in src/math.cjs",
      acceptance: ["add returns the sum"],
      providerId: "cloud-unit",
    });
    const run = await engine.wait((await engine.start(plan.id)).id);
    expect(bodies.length).toBeGreaterThan(0);
    const day = new Date().toISOString().slice(0, 10);
    expect(engine.store.usage(`decisions-${day}`).costUsd).toBeGreaterThan(0);
    expect(engine.store.usage(plan.id).costUsd ?? 0).toBe(0);
    expect(
      engine.store
        .decisions()
        .some(
          (record) => record.provider === "jev" && record.selected !== null,
        ),
    ).toBe(true);
    expect(worker).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(String(run.error)).toMatch(/cost|ceiling|budget/i);
  }, 60000);
  it("sends a run's hosted context selection only exportable path labels", async () => {
    const { engine, bodies } = await engineFixture();
    const plan = await engine.createPlan({
      objective: "Fix add in src/math.cjs and read the add notes",
      acceptance: ["add returns the sum"],
      providerId: "cloud-unit",
    });
    await engine.wait((await engine.start(plan.id)).id);
    const selection = engine.store
      .decisions()
      .filter((record) => record.category === "file-selection");
    // The exportable excerpt reached Jev and was answered there; the
    // non-exportable one stayed local-only.
    expect(
      selection.some(
        (record) => record.provider === "jev" && record.selected === "include",
      ),
    ).toBe(true);
    expect(
      selection.some((record) =>
        String(record.evidence.failure).includes("explicitly exportable"),
      ),
    ).toBe(true);
    expect(bodies.join("\n")).toContain("src/math.cjs:");
    expect(bodies.join("\n")).not.toContain("private/");
    expect(bodies.join("\n")).not.toContain("addNotes");
  }, 60000);
});
