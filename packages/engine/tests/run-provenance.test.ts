import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  SCHEMA_VERSION,
  type ExecutionPlan,
  type ProjectConfig,
  type RunEvent,
  type RunRecord,
} from "@graph-engineering/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  PROJECT_FILE,
  projectDataDir,
} from "../src/project.js";
import { checked, hash, writeJson } from "../src/util.js";
import type { WorkerInput } from "../src/workers/api.js";
import { containsSecret } from "../src/policy.js";
import { planSha256 } from "../src/store.js";
import {
  buildRunProvenance,
  changedFileDigests,
  IN_TOTO_STATEMENT_TYPE,
  RUN_PROVENANCE_PREDICATE_TYPE,
  runProvenanceFile,
  runProvenanceSchema,
} from "../src/run-provenance.js";

const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const OBJECTIVE = "Rewrite the private billing prompt for toy-project";
const NOTE = "Looks right to the reviewer named Pat";
const SECRET = `sk-${"Zq7Lm2Xp9Rt4Vb8Nc3Kd5Hs1Wy6Ej0Uf"}`;
const REALPATH = "/Users/someone/.local/bin/coder";

function receipt(overrides: Partial<RunRecord> = {}): {
  run: RunRecord;
  events: RunEvent[];
} {
  const plan: ExecutionPlan = {
    version: SCHEMA_VERSION,
    id: "plan-1",
    projectId: "toy",
    snapshotId: "a".repeat(64),
    policyHash: hash(DEFAULT_POLICY),
    createdAt: "2026-10-10T00:00:00.000Z",
    objective: OBJECTIVE,
    acceptance: [`never leak ${SECRET}`],
    steps: [],
    verification: [],
    publication: "commit",
    installedWorkers: [
      {
        providerId: "coder",
        providerProfileSha256: "c".repeat(64),
        identity: { realpath: REALPATH, sha256: "d".repeat(64) },
      },
    ],
  };
  const run: RunRecord = {
    id: "run-1",
    plan,
    status: "succeeded",
    createdAt: "2026-10-10T00:01:00.000Z",
    updatedAt: "2026-10-10T00:09:00.000Z",
    workspace: "/Users/someone/private/worktree",
    branch: "graph/run-1",
    baseCommit: "1".repeat(40),
    commit: "2".repeat(40),
    pullRequest: "https://github.com/someone/toy/pull/1",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
    completion: {
      automatedChecksPassed: true,
      humanAcceptance: "accepted",
      reviewScope: "normal",
    },
    ...overrides,
  };
  const snapshot = "e".repeat(64);
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>): RunEvent => ({
    version: SCHEMA_VERSION,
    id: `event-${++seq}`,
    runId: run.id,
    projectId: "toy",
    at: `2026-10-10T00:0${Math.min(seq, 9)}:00.000Z`,
    type,
    data,
  });
  const events = [
    event("plan.approval_used", {
      planSha256: planSha256(plan),
      approvedAt: "2026-10-10T00:00:30.000Z",
      approvedVia: "terminal",
    }),
    event("run.started", { resuming: false }),
    event("worker.identity_used", {
      planSha256: planSha256(plan),
      providerId: "coder",
      providerProfileSha256: "c".repeat(64),
      identity: { realpath: REALPATH, sha256: "d".repeat(64) },
      version: "1.2.3",
    }),
    event("worker.dispatched", {
      provider: "coder",
      model: "/Users/someone/models/toy-model.gguf",
      attempt: 1,
    }),
    event("verification.completed", {
      checks: [{ code: 0, stdout: `printed ${SECRET}`, stderr: "" }],
      snapshotHash: snapshot,
    }),
    event("review.completed", {
      providerId: "reviewer",
      model: "review-model",
      passed: true,
      verdict: "approve",
      snapshotHash: snapshot,
      summary: `Prompt said: ${OBJECTIVE}`,
    }),
    event("security.gate_passed", { snapshotHash: snapshot }),
    event("run.succeeded", { usage: run.usage }),
    event("acceptance.recorded", {
      decision: "accepted",
      snapshotHash: snapshot,
      commit: run.commit,
      note: NOTE,
    }),
  ];
  return { run, events };
}

const providers = [
  {
    id: "coder",
    kind: "local" as const,
    model: "toy-model",
    endpoint: "http://127.0.0.1:1/private",
    apiKeyEnv: "TOY_API_KEY",
  },
  { id: "reviewer", kind: "local" as const, model: "review-model" },
];
const changed = {
  files: [{ path: "src/b.ts", sha256: "f".repeat(64) }],
  removed: ["src/old.ts"],
};

describe("run provenance statement", () => {
  it("emits a schema-valid in-toto Statement v1 for an accepted run", () => {
    const { run, events } = receipt();
    const statement = buildRunProvenance({
      run,
      events,
      changed,
      providers,
      policy: DEFAULT_POLICY,
    });
    expect(runProvenanceSchema.parse(statement)).toEqual(statement);
    expect(Object.keys(statement).sort()).toEqual([
      "_type",
      "predicate",
      "predicateType",
      "subject",
    ]);
    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(RUN_PROVENANCE_PREDICATE_TYPE);
    expect(statement.subject).toEqual([
      { name: "git+commit", digest: { gitCommit: "2".repeat(40) } },
      { name: "src/b.ts", digest: { sha256: "f".repeat(64) } },
    ]);
    expect(statement.predicate).toMatchObject({
      planSha256: planSha256(run.plan),
      policyHash: run.plan.policyHash,
      decisionMode: "shadow",
      resultCommit: "2".repeat(40),
      removedFiles: ["src/old.ts"],
      approval: { matchesPlan: true, approvedVia: "terminal" },
      signed: false,
      timestamps: {
        planCreatedAt: run.plan.createdAt,
        runCreatedAt: run.createdAt,
      },
    });
    expect(statement.predicate.workers).toEqual([
      {
        role: "worker",
        providerId: "coder",
        kind: "local",
        model: "toy-model.gguf",
        executable: {
          sha256: "d".repeat(64),
          version: "1.2.3",
          providerProfileSha256: "c".repeat(64),
        },
      },
      {
        role: "reviewer",
        providerId: "reviewer",
        kind: "local",
        model: "review-model",
        executable: null,
      },
    ]);
    expect(
      statement.predicate.gates.map((gate) => [gate.gate, gate.passed]),
    ).toEqual([
      ["verification", true],
      ["review", true],
      ["security", true],
    ]);
    // The schema is strict: an extra field is refused.
    expect(() =>
      runProvenanceSchema.parse({
        ...statement,
        predicate: { ...statement.predicate, objective: OBJECTIVE },
      }),
    ).toThrow();
  });

  it("leaves prompts, notes, check output, secrets, paths and user identity out of the statement", () => {
    const { run, events } = receipt();
    const text = JSON.stringify(
      buildRunProvenance({
        run,
        events,
        changed,
        providers,
        policy: DEFAULT_POLICY,
      }),
    );
    for (const forbidden of [
      OBJECTIVE,
      SECRET,
      NOTE,
      REALPATH,
      "/Users/someone",
      "someone",
      "printed",
      "Prompt said",
      "TOY_API_KEY",
      "127.0.0.1",
      run.pullRequest!,
      os.homedir(),
    ])
      expect(text).not.toContain(forbidden);
    expect(containsSecret(text)).toBe(false);
  });

  it("reduces any model path to its base name and a model URL to its last path segment", () => {
    const models = [
      ["models/user-dir/x.gguf", "x.gguf"],
      ["C:\\Users\\someone\\m.gguf", "m.gguf"],
      ["http://10.0.0.5:8080/v1/models/qwen.gguf", "qwen.gguf"],
      ["http://localhost:11434", null],
      ["plain-model", "plain-model"],
    ] as const;
    for (const [model, expected] of models) {
      const { run, events } = receipt();
      const dispatched = events.find(
        (event) => event.type === "worker.dispatched",
      )!;
      dispatched.data = { ...dispatched.data, model };
      const statement = buildRunProvenance({
        run,
        events,
        changed,
        providers,
        policy: DEFAULT_POLICY,
      });
      expect(statement.predicate.workers[0]!.model).toBe(expected);
      const text = JSON.stringify(statement);
      for (const leaked of ["user-dir", "10.0.0.5", "localhost", "someone"])
        expect(text).not.toContain(leaked);
    }
  });

  it("refuses a run a person has not accepted", () => {
    for (const humanAcceptance of ["pending", "rejected"] as const) {
      const { run, events } = receipt();
      run.completion!.humanAcceptance = humanAcceptance;
      expect(() =>
        buildRunProvenance({
          run,
          events,
          changed,
          providers,
          policy: DEFAULT_POLICY,
        }),
      ).toThrow("only for a run a person accepted");
    }
  });

  it("reports the decision mode only while the policy still matches the plan", () => {
    const { run, events } = receipt();
    const statement = buildRunProvenance({
      run,
      events,
      changed,
      providers,
      policy: { ...DEFAULT_POLICY, maxWorkers: 7 },
    });
    expect(statement.predicate.decisionMode).toBeNull();
  });

  it("attests the verified snapshot when a run published no commit", () => {
    const { run, events } = receipt({ commit: undefined });
    const statement = buildRunProvenance({
      run,
      events,
      changed: { files: [], removed: [] },
      providers,
      policy: DEFAULT_POLICY,
    });
    expect(statement.subject).toEqual([
      {
        name: "graph-engineering+workspace-snapshot",
        digest: { sha256: "e".repeat(64) },
      },
    ]);
  });
});

async function toyRepository(): Promise<{
  root: string;
  head: () => Promise<string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-provenance-git-"));
  directories.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Toy"], { cwd: root });
  await checked("git", ["config", "user.email", "toy@example.invalid"], {
    cwd: root,
  });
  await writeFile(path.join(root, "keep.txt"), "keep\n");
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "base"], { cwd: root });
  return {
    root,
    head: async () =>
      (await checked("git", ["rev-parse", "HEAD"], { cwd: root })).trim(),
  };
}

describe("run provenance from a real run", () => {
  it("records a changed submodule pointer as a subject named by the commit it points to", async () => {
    const { root, head } = await toyRepository();
    const base = await head();
    const pointed = "1".repeat(40);
    await checked(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${pointed},vendor/sub`],
      { cwd: root },
    );
    await writeFile(path.join(root, "a.txt"), "a\n");
    await checked("git", ["add", "a.txt"], { cwd: root });
    await checked("git", ["commit", "-m", "submodule"], { cwd: root });
    const commit = await head();
    const changed = await changedFileDigests(root, base, commit);
    expect(changed).toEqual({
      files: [
        {
          path: "a.txt",
          sha256: createHash("sha256").update("a\n").digest("hex"),
        },
      ],
      submodules: [{ path: "vendor/sub", commit: pointed }],
      removed: [],
      truncated: false,
    });
    const { run, events } = receipt({ commit });
    const statement = buildRunProvenance({
      run,
      events,
      changed,
      providers,
      policy: DEFAULT_POLICY,
    });
    expect(statement.subject).toEqual([
      { name: "git+commit", digest: { gitCommit: commit } },
      { name: "a.txt", digest: { sha256: changed.files[0]!.sha256 } },
      { name: "vendor/sub", digest: { gitCommit: pointed } },
    ]);
    expect(statement.predicate.filesTruncated).toBe(false);
  });

  it("stops digesting past the file and byte limits and records that the list was truncated", async () => {
    const { root, head } = await toyRepository();
    const base = await head();
    for (const name of ["a.txt", "b.txt", "c.txt"])
      await writeFile(path.join(root, name), `${name}\n`.repeat(10));
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "many"], { cwd: root });
    const commit = await head();
    const all = await changedFileDigests(root, base, commit);
    expect(all.files.map((file) => file.path)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    expect(all.truncated).toBe(false);
    const byCount = await changedFileDigests(root, base, commit, {
      maxFiles: 2,
    });
    expect(byCount.files).toEqual(all.files.slice(0, 2));
    expect(byCount.truncated).toBe(true);
    const byBytes = await changedFileDigests(root, base, commit, {
      maxBytes: 100,
    });
    expect(byBytes.files).toEqual(all.files.slice(0, 1));
    expect(byBytes.truncated).toBe(true);
    const { run, events } = receipt({ commit });
    expect(
      buildRunProvenance({
        run,
        events,
        changed: byCount,
        providers,
        policy: DEFAULT_POLICY,
      }).predicate.filesTruncated,
    ).toBe(true);
  });

  it("digests each changed file's bytes at the result commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-provenance-git-"));
    directories.push(root);
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await checked("git", ["config", "user.name", "Toy"], { cwd: root });
    await checked("git", ["config", "user.email", "toy@example.invalid"], {
      cwd: root,
    });
    await writeFile(path.join(root, "keep.txt"), "keep\n");
    await writeFile(path.join(root, "gone.txt"), "gone\n");
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "base"], { cwd: root });
    const base = (
      await checked("git", ["rev-parse", "HEAD"], { cwd: root })
    ).trim();
    const bytes = Buffer.from([0, 255, 10, 200, 13]);
    await writeFile(path.join(root, "bin.dat"), bytes);
    await rm(path.join(root, "gone.txt"));
    await checked("git", ["add", "-A"], { cwd: root });
    await checked("git", ["commit", "-m", "change"], { cwd: root });
    const commit = (
      await checked("git", ["rev-parse", "HEAD"], { cwd: root })
    ).trim();
    expect(await changedFileDigests(root, base, commit)).toEqual({
      files: [
        {
          path: "bin.dat",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
      submodules: [],
      removed: ["gone.txt"],
      truncated: false,
    });
    await expect(changedFileDigests(root, undefined, commit)).rejects.toThrow(
      "no base commit",
    );
  });

  it("writes the statement when a person accepts a run that committed its result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-provenance-"));
    directories.push(root);
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
    await checked("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    await writeFile(
      path.join(root, "math.cjs"),
      "exports.add = (a, b) => a - b;\n",
    );
    const config: ProjectConfig = await initializeProject(root);
    config.policy.providers = ["local"];
    config.policy.publication = "commit";
    config.verification = [{ image: "fixture", argv: ["test"] }];
    await writeJson(path.join(root, PROJECT_FILE), config);
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
    const data = projectDataDir(config.projectId);
    directories.push(data);
    await configureProvider(data, {
      id: "local",
      kind: "local",
      model: "fixture",
    });
    const worker = vi.fn(async (_input: WorkerInput) => ({
      model: "fixture",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costUsd: 0,
        estimated: false,
      },
      proposal: {
        summary: "Fix addition",
        requests: [],
        changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
      },
    }));
    const verify: NonNullable<EngineDependencies["verify"]> = async (
      _workspace,
      checks,
      _policy,
      snapshotHash,
    ) =>
      checks.map((check) => ({
        ...check,
        code: 0,
        stdout: "",
        stderr: "",
        snapshotHash,
      }));
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker,
      verify,
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition in math.cjs",
      acceptance: ["2 + 3 is 5"],
    });
    const result = await engine.wait(
      (await engine.start(plan.id, { approvedByPerson: true })).id,
    );
    expect(result.status).toBe("succeeded");
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    await engine.recordAcceptance(result.id, {
      accepted: true,
      note: "Looks right",
    });
    const written = JSON.parse(
      await readFile(runProvenanceFile(data, result.id), "utf8"),
    );
    expect(runProvenanceSchema.parse(written)).toEqual(written);
    expect(written.subject).toEqual([
      { name: "git+commit", digest: { gitCommit: result.commit } },
      {
        name: "math.cjs",
        digest: {
          sha256: createHash("sha256")
            .update("exports.add = (a, b) => a + b;\n")
            .digest("hex"),
        },
      },
    ]);
    const text = JSON.stringify(written);
    for (const forbidden of [
      "Fix addition in math.cjs",
      "2 + 3 is 5",
      "Looks right",
      "a + b",
      "test@example.invalid",
      root,
    ])
      expect(text).not.toContain(forbidden);
    expect(
      engine.store
        .events(result.id)
        .some((event) => event.type === "provenance.capture_failed"),
    ).toBe(false);
  });
});
