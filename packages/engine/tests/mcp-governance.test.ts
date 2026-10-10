import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphEngine } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  PROJECT_FILE,
  projectDataDir,
} from "../src/project.js";
import {
  createMcpServer,
  enabledMcpTools,
  mcpArgsSha256,
  MCP_LIMITATION_NOTES,
  type McpLimitations,
  type McpServerOptions,
} from "../src/mcp.js";
import { MCP_OPTIONAL_TOOLS, parseAllowedTools } from "../src/mcp-tools.js";
import { MAX_PLAN_OBJECTIVE } from "../src/planning.js";
import { planSha256, readMcpCalls } from "../src/store.js";
import { checked, writeJson } from "../src/util.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

// A toy project whose worker, checks and Docker are fixtures: no model is
// called and no container runs.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-governance-"));
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.verification = [{ image: "fixture", argv: ["test"] }];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
  const data = projectDataDir(config.projectId);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
  });
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    worker: async () => ({
      model: "fixture",
      proposal: {
        summary: "Fix addition",
        requests: [],
        changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
      },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costUsd: 0,
        estimated: false,
      },
    }),
    verify: async (_workspace, checks, _policy, snapshotHash) =>
      checks.map((check) => ({
        ...check,
        code: 0,
        stdout: "passed",
        stderr: "",
        snapshotHash,
      })),
  });
  cleanup.push(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });
  const connect = async (options: McpServerOptions) => {
    const server = createMcpServer(engine, options);
    const client = new Client({ name: "governance-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  };
  return { root, data, config, engine, connect };
}

const json = (value: unknown) =>
  JSON.parse(
    (value as { content: { text: string }[] }).content[0]!.text,
  ) as Record<string, any>;
const text = (value: unknown) =>
  (value as { content: { text: string }[] }).content[0]!.text;

it("requires a person's stored approval for a run started over MCP even when the project policy does not require plan approval", async () => {
  const { config, engine, connect } = await fixture();
  expect(config.policy.requirePlanApproval).toBeUndefined();
  const client = await connect({ client: "local", allowRun: true });
  const plan = json(
    await client.callTool({
      name: "plan_create",
      arguments: { objective: "Fix addition", acceptance: ["2 + 3 is 5"] },
    }),
  );
  const stored = engine.store.plan(plan.id);
  expect(stored.publication).toBe("none");
  const refused = await client.callTool({
    name: "run_start",
    arguments: { planId: plan.id },
  });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain(
    `graph-engine plan-approve ${plan.id} --yes --expect ${planSha256(stored)}`,
  );
  expect(engine.store.runs()).toEqual([]);

  // A person approves it on the command line (plan-approve --yes).
  const approval = engine.store.approvePlan(plan.id);
  const started = json(
    await client.callTool({
      name: "run_start",
      arguments: { planId: plan.id },
    }),
  );
  const run = await engine.wait(started.id);
  expect(run.status).toBe("succeeded");
  expect(
    engine.store
      .events(run.id)
      .filter((event) => event.type === "plan.approval_used")
      .map((event) => event.data),
  ).toEqual([
    {
      planSha256: approval.planSha256,
      approvedAt: approval.approvedAt,
      approvedVia: "non-interactive",
    },
  ]);
  // The refusal and the start are both in the call log, with the plan and
  // the run they concerned.
  expect(
    engine.store
      .mcpCalls({ limit: 10, tool: "run_start" })
      .map(({ outcome, planId, runId }) => ({ outcome, planId, runId })),
  ).toEqual([
    { outcome: "ok", planId: plan.id, runId: run.id },
    { outcome: "refused", planId: plan.id, runId: undefined },
  ]);
});

it("refuses an MCP start of a plan whose content changed after it was approved, naming the current planSha256", async () => {
  const { engine, connect } = await fixture();
  const client = await connect({ client: "local", allowRun: true });
  const plan = await engine.createPlan({
    objective: "Fix addition",
    acceptance: ["2 + 3 is 5"],
  });
  const approval = engine.store.approvePlan(plan.id);
  // The stored plan changes after the approval (a different acceptance).
  const changed = { ...plan, acceptance: ["2 + 3 is 5", "1 + 1 is 2"] };
  (engine.store as any).db
    .prepare("UPDATE plans SET json=? WHERE id=?")
    .run(JSON.stringify(changed), plan.id);
  expect(planSha256(changed)).not.toBe(approval.planSha256);
  const refused = await client.callTool({
    name: "run_start",
    arguments: { planId: plan.id },
  });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain("changed after it was approved");
  expect(text(refused)).toContain(`--expect ${planSha256(changed)}`);
  expect(engine.store.runs()).toEqual([]);
});

it("keeps starting a plan that does not publish from the command line without a stored approval when the policy does not require one", async () => {
  const { engine } = await fixture();
  const plan = await engine.createPlan({
    objective: "Fix addition",
    acceptance: ["2 + 3 is 5"],
  });
  // graph-engine run calls start this way.
  const run = await engine.wait(
    (await engine.start(plan.id, { approvedByPerson: true })).id,
  );
  expect(run.status).toBe("succeeded");
  expect(engine.store.planApproval(plan.id).approval).toBeNull();
  expect(
    engine.store
      .events(run.id)
      .some((event) => event.type === "plan.approval_used"),
  ).toBe(false);
});

it("logs every MCP call with the SHA-256 of its canonical JSON arguments and never the arguments themselves", async () => {
  const { data, engine, connect } = await fixture();
  const client = await connect({ client: "local", allowRun: true });
  const canary = "CANARY_ARGUMENT_7f3a";
  const calls: { name: string; arguments: Record<string, unknown> }[] = [
    { name: "context_get", arguments: { query: `add ${canary}` } },
    { name: "symbol_search", arguments: { query: canary } },
    { name: "graph_neighbors", arguments: { symbolId: canary, depth: 1 } },
    { name: "template_list", arguments: {} },
    { name: "run_list", arguments: { limit: 5 } },
    { name: "run_status", arguments: { runId: canary } },
    {
      name: "plan_create",
      // The plan itself is stored, so its text carries no canary; the
      // log must not add the arguments beside it.
      arguments: { objective: "Fix addition", acceptance: ["2 + 3 is 5"] },
    },
  ];
  for (const call of calls) await client.callTool(call);
  const log = engine.store.mcpCalls({ limit: 100 }).reverse();
  expect(log.map((entry) => entry.tool)).toEqual(
    calls.map((call) => call.name),
  );
  for (const entry of log) {
    expect(entry.clientKind).toBe("local");
    expect(entry.argsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(entry).sort()).toEqual(
      expect.arrayContaining(["argsSha256", "at", "id", "outcome", "tool"]),
    );
  }
  // Keys in any order hash alike; the hash covers the validated arguments
  // (with defaults filled), so a log entry can be matched to a known call.
  expect(log[1]!.argsSha256).toBe(mcpArgsSha256({ query: canary }));
  expect(mcpArgsSha256({ symbolId: canary, depth: 1 })).toBe(
    mcpArgsSha256({ depth: 1, symbolId: canary }),
  );
  expect(log.find((entry) => entry.tool === "run_status")).toMatchObject({
    outcome: "error",
  });
  // An unknown run ID is the client's input, so it is not recorded.
  expect(log.find((entry) => entry.tool === "run_status")?.runId).toBe(
    undefined,
  );
  const created = log.find((entry) => entry.tool === "plan_create")!;
  expect(created.outcome).toBe("ok");
  expect(engine.store.hasPlan(created.planId!)).toBe(true);
  // No argument text reaches the run database or its write-ahead log.
  for (const file of ["runs.sqlite", "runs.sqlite-wal"]) {
    const full = path.join(data, file);
    if (existsSync(full))
      expect((await readFile(full)).includes(canary)).toBe(false);
  }
});

it("refuses a state-changing MCP call when the call log cannot be written, without telling the client why, and still answers a read", async () => {
  const { engine, connect } = await fixture();
  const client = await connect({ client: "local", allowRun: true });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const begin = vi
    .spyOn(engine.store, "beginMcpCall")
    .mockImplementation(() => {
      throw new Error("disk full at /private/log/path");
    });
  try {
    const saved = vi.spyOn(engine.store, "savePlan");
    const refused = await client.callTool({
      name: "plan_create",
      arguments: { objective: "Fix addition", acceptance: ["2 + 3 is 5"] },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("could not record it in its call log");
    expect(text(refused)).not.toContain("/private/log/path");
    expect(saved).not.toHaveBeenCalled();
    const read = await client.callTool({
      name: "template_list",
      arguments: {},
    });
    expect(read.isError).not.toBe(true);
    expect(text(read)).not.toContain("/private/log/path");
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "the call log could not record a plan_create call",
    );
  } finally {
    begin.mockRestore();
    stderr.mockRestore();
  }
});

it("reads the call log with readMcpCalls, newest first and filtered by tool, and exposes no MCP tool that reads it", async () => {
  const { config, data, connect } = await fixture();
  const client = await connect({
    client: "local",
    allowTools: [...MCP_OPTIONAL_TOOLS],
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names.filter((name) => /log|audit|call/i.test(name))).toEqual([]);
  await client.callTool({ name: "template_list", arguments: {} });
  await client.callTool({ name: "run_list", arguments: {} });
  await client.callTool({ name: "template_list", arguments: {} });
  const all = readMcpCalls(data, config.projectId, { limit: 10 });
  expect(all.map((entry) => entry.tool)).toEqual([
    "template_list",
    "run_list",
    "template_list",
  ]);
  expect(
    readMcpCalls(data, config.projectId, { limit: 1, tool: "run_list" }),
  ).toEqual([all[1]]);
  // A data directory with no run database has no log.
  expect(
    readMcpCalls(path.join(data, "missing"), config.projectId, { limit: 1 }),
  ).toEqual([]);
});

it("enables individual tools with allowTools, keeps allowRun and allowRunStatus as aliases for their tool sets, and refuses unknown tool names", async () => {
  expect(() => parseAllowedTools(["run_start", "run_delete"])).toThrow(
    "--allow-tool does not know run_delete",
  );
  expect(() => parseAllowedTools(["context_get"])).toThrow(
    "--allow-tool does not know context_get",
  );
  expect(parseAllowedTools(["run_status", "run_status"])).toEqual([
    "run_status",
  ]);
  const sorted = (tools: Set<string>) => [...tools].sort();
  expect(sorted(enabledMcpTools({ client: "cloud" }))).toEqual([]);
  expect(sorted(enabledMcpTools({ client: "local" }))).toEqual([
    "run_events",
    "run_list",
    "run_status",
  ]);
  expect(sorted(enabledMcpTools({ client: "cloud", allowRun: true }))).toEqual([
    "plan_create",
    "plan_decompose",
    "run_cancel",
    "run_start",
  ]);
  expect(
    sorted(enabledMcpTools({ client: "cloud", allowRunStatus: true })),
  ).toEqual(["run_events", "run_list", "run_status"]);

  const { connect } = await fixture();
  const base = [
    "context_get",
    "graph_neighbors",
    "memory_propose",
    "symbol_search",
    "template_list",
  ];
  const names = async (options: McpServerOptions) =>
    (await (await connect(options)).listTools()).tools
      .map((tool) => tool.name)
      .sort();
  expect(await names({ client: "cloud" })).toEqual(base);
  expect(
    await names({ client: "cloud", allowTools: ["run_status", "run_cancel"] }),
  ).toEqual([...base, "run_cancel", "run_status"].sort());
  expect(await names({ client: "cloud", allowRun: true })).toEqual(
    [
      ...base,
      "plan_create",
      "plan_decompose",
      "run_cancel",
      "run_start",
    ].sort(),
  );
  expect(await names({ client: "cloud", allowRunStatus: true })).toEqual(
    [...base, "run_events", "run_list", "run_status"].sort(),
  );
  expect(await names({ client: "local", allowTools: ["run_start"] })).toEqual(
    [...base, "run_events", "run_list", "run_start", "run_status"].sort(),
  );
});

// A project a cloud client may read: public/ is exportable, private/ is not,
// and an oversized private file makes indexing report incomplete coverage
// with a diagnostic that names its path.
async function limitationsFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-limits-"));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = ["api.openai.com"];
  config.policy.exportPaths = ["public/**"];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await mkdir(path.join(root, "public"));
  await mkdir(path.join(root, "private"));
  await writeFile(
    path.join(root, "public", "limits.ts"),
    [
      'import { missing } from "./not-there";',
      "export function limitsLogin() { return missing(); }",
      ...Array.from(
        { length: 101 },
        (_, index) =>
          `export function limitsMany${index}() { return ${index}; }`,
      ),
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "private", "PRIVATE_LIMITS_CANARY.ts"),
    "export function limitsLoginPrivate() { return false; }",
  );
  await writeFile(
    path.join(root, "private", "OVERSIZED_LIMITS_CANARY.txt"),
    "x".repeat(1024 * 1024 + 1),
  );
  const engine = await GraphEngine.open(root);
  cleanup.push(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  });
  const connect = async (client: "local" | "cloud") => {
    const server = createMcpServer(engine, { client });
    const mcp = new Client({ name: `limits-${client}`, version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    cleanup.push(async () => {
      await mcp.close();
      await server.close();
    });
    return mcp;
  };
  return { engine, connect };
}

it("states a cloud client's result limitations as counts and fixed sentences, never paths, diagnostics or a count of private matches", async () => {
  const { engine, connect } = await limitationsFixture();
  // A legacy index row whose signature holds a credential: screening
  // withholds it, and the count says so.
  const searchSymbols = engine.context.searchSymbols.bind(engine.context);
  vi.spyOn(engine.context, "searchSymbols").mockImplementation(
    async (...args) =>
      (await searchSymbols(...args)).map((symbol) =>
        symbol.name === "limitsLogin"
          ? {
              ...symbol,
              signature:
                'function limitsLogin(password = "LIMITS_SECRET_CANARY_123456789012")',
            }
          : symbol,
      ),
  );
  const client = await connect("cloud");
  const allowed = new Set<string>(Object.values(MCP_LIMITATION_NOTES));
  const checkCloud = (limitations: McpLimitations) => {
    for (const note of limitations.notes) expect(allowed.has(note)).toBe(true);
    const textOf = JSON.stringify(limitations);
    for (const hidden of [
      "PRIVATE_LIMITS_CANARY",
      "OVERSIZED_LIMITS_CANARY",
      "LIMITS_SECRET_CANARY",
      "private/",
      "1 MiB",
    ])
      expect(textOf).not.toContain(hidden);
    expect(limitations.notes).toContain(MCP_LIMITATION_NOTES.exportScope);
    expect(limitations.coverageIncomplete).toBe(true);
    expect(limitations.notes).toContain(MCP_LIMITATION_NOTES.cloudCoverage);
  };

  const search = json(
    await client.callTool({
      name: "symbol_search",
      arguments: { query: "limitsLogin" },
    }),
  );
  // The private limitsLoginPrivate also matches, but only the exportable
  // symbol withheld by credential screening is counted.
  expect(search.symbols).toEqual([]);
  expect(search.limitations).toMatchObject({ filtered: 1, truncated: false });
  expect(search.limitations.notes).toContain(MCP_LIMITATION_NOTES.filtered);
  checkCloud(search.limitations);

  const many = json(
    await client.callTool({
      name: "symbol_search",
      arguments: { query: "limitsMany" },
    }),
  );
  expect(many.symbols).toHaveLength(100);
  expect(many.limitations).toMatchObject({ filtered: 0, truncated: true });
  expect(many.limitations.notes).toContain(MCP_LIMITATION_NOTES.symbolLimit);
  checkCloud(many.limitations);

  const file = (await engine.context.searchSymbols("public/limits.ts")).find(
    (symbol) => symbol.kind === "file",
  )!;
  const graph = json(
    await client.callTool({
      name: "graph_neighbors",
      arguments: { symbolId: file.id },
    }),
  );
  expect(graph.limitations.unresolvedEdges).toBe(
    (graph.edges as { to: string | null }[]).filter((edge) => edge.to === null)
      .length,
  );
  expect(graph.limitations.unresolvedEdges).toBeGreaterThan(0);
  expect(graph.limitations.notes).toContain(MCP_LIMITATION_NOTES.unresolved);
  checkCloud(graph.limitations);

  const packet = json(
    await client.callTool({
      name: "context_get",
      arguments: { query: "export function return", budgetTokens: 400 },
    }),
  );
  expect(packet.limitations).toMatchObject({ truncated: true });
  expect(packet.limitations.notes).toContain(
    MCP_LIMITATION_NOTES.contextBudget,
  );
  checkCloud(packet.limitations);
});

it("gives a local client the same limitations with the indexing diagnostics", async () => {
  const { connect } = await limitationsFixture();
  const client = await connect("local");
  const search = json(
    await client.callTool({
      name: "symbol_search",
      arguments: { query: "limitsLogin" },
    }),
  );
  // A local client sees private symbols, so nothing is withheld.
  expect(
    (search.symbols as { name: string }[]).map((symbol) => symbol.name).sort(),
  ).toEqual(["limitsLogin", "limitsLoginPrivate"]);
  expect(search.limitations).toMatchObject({
    filtered: 0,
    truncated: false,
    coverageIncomplete: true,
  });
  expect(search.limitations.notes).not.toContain(
    MCP_LIMITATION_NOTES.exportScope,
  );
  expect(search.limitations.notes).toContain(MCP_LIMITATION_NOTES.coverage);
  expect(search.limitations.notes.join("\n")).toContain(
    "private/OVERSIZED_LIMITS_CANARY.txt",
  );
  const packet = json(
    await client.callTool({
      name: "context_get",
      arguments: {
        query: "export function return",
        budgetTokens: 400,
        retrieval: "lexical",
      },
    }),
  );
  expect(packet.limitations).toMatchObject({
    filtered: 0,
    truncated: true,
    coverageIncomplete: true,
  });
  expect(packet.limitations.notes.join("\n")).toContain(
    "OVERSIZED_LIMITS_CANARY",
  );
});

it("bounds a plan objective by MAX_PLAN_OBJECTIVE in plan_create, plan_decompose and the dashboard API", async () => {
  expect(MAX_PLAN_OBJECTIVE).toBe(16000);
  const { engine, connect } = await fixture();
  const client = await connect({ client: "local", allowRun: true });
  const tooLong = "x".repeat(MAX_PLAN_OBJECTIVE + 1);
  for (const name of ["plan_create", "plan_decompose"]) {
    const refused = await client.callTool({
      name,
      arguments: {
        objective: tooLong,
        acceptance: ["2 + 3 is 5"],
        plannerId: "local",
      },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(String(MAX_PLAN_OBJECTIVE));
  }
  const fits = await client.callTool({
    name: "plan_create",
    arguments: {
      objective: "x".repeat(MAX_PLAN_OBJECTIVE),
      acceptance: ["2 + 3 is 5"],
    },
  });
  expect(fits.isError).not.toBe(true);
  const { createServer } = await import("../src/server.js");
  const { app } = createServer(engine, "test-token");
  try {
    const dashboard = await app.inject({
      method: "POST",
      url: "/api/plans",
      headers: { host: "localhost", authorization: "Bearer test-token" },
      payload: { objective: tooLong, acceptance: ["2 + 3 is 5"] },
    });
    expect(dashboard.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
