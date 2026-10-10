import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  API_KINDS,
  DEFAULT_POLICY,
  INSTALLED_KINDS,
  LOCAL_KINDS,
  PROVIDER_KINDS,
  isApiKind,
  isCloudKind,
  isInstalledKind,
  type ContextPacket,
  type ProjectPolicy,
  type ProviderConfig,
} from "@graph-engineering/contracts";
import {
  estimateRequestCost,
  invokeApiWorker,
  proposalJsonSchema,
  usageFrom,
  type ProviderFetch,
} from "../src/workers/api.js";
import { invokeReviewWorker } from "../src/workers/review.js";
import { invokePlanWorker } from "../src/workers/plan.js";
import { workerTimeoutMs } from "../src/workers/deadline.js";
import { isInstalledProvider } from "../src/workers/identity.js";
import {
  assertProvider,
  contextForProvider,
  costBudgetRefusal,
} from "../src/policy.js";
import {
  configureProvider,
  initializeProject,
  loadProviders,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { GraphEngine } from "../src/service.js";
import { createMcpServer } from "../src/mcp.js";
import { checked, writeJson } from "../src/util.js";

const KEY_ENV = "GRAPH_TEST_CHAT_KEY";
const gateway: ProviderConfig = {
  id: "gateway",
  kind: "chat",
  model: "hosted-fixture",
  endpoint: "https://gateway.example/v1",
  apiKeyEnv: KEY_ENV,
  inputCostPerMillion: 1,
  outputCostPerMillion: 2,
  efforts: ["low"],
};
const policy: ProjectPolicy = {
  ...DEFAULT_POLICY,
  providers: ["gateway"],
  inference: "allowlisted",
  network: "allowlisted",
  allowedHosts: ["gateway.example"],
  exportPaths: ["src/**"],
};
const proposal = {
  summary: "Fix",
  changes: [{ path: "src/sum.js", before: "a-b", after: "a+b" }],
  requests: [],
};
const reply = (content: unknown) =>
  new Response(
    JSON.stringify({
      model: "hosted-fixture",
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
  );
const packet = (items: ContextPacket["items"] = []): ContextPacket => ({
  version: "1.0.0",
  projectId: "project",
  snapshotId: "snapshot",
  query: "fix",
  mandatory: ["tests pass"],
  mandatorySources: [],
  items,
  estimatedTokens: 20,
  budgetTokens: 1000,
  coverage: { semantic: false, graph: "syntactic", warnings: [] },
});
const source = (file: string, text: string) => ({
  id: file,
  kind: "code" as const,
  text,
  score: 1,
  source: { path: file, startLine: 1, endLine: 1 },
});

describe("chat provider", () => {
  it("calls chat completions with a strict JSON schema and bearer key, with no local-server options", async () => {
    vi.stubEnv(KEY_ENV, "fixture-only-not-a-real-key");
    try {
      const calls: {
        url: string;
        headers: Record<string, string>;
        body: any;
      }[] = [];
      const fetch: ProviderFetch = async (url, init) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return reply(proposal);
      };
      const result = await invokeApiWorker(
        {
          provider: gateway,
          policy,
          context: packet(),
          objective: "Fix sum",
          acceptance: ["sum is correct"],
          effort: "low",
        },
        fetch,
      );
      expect(result.proposal).toEqual(proposal);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://gateway.example/v1/chat/completions");
      expect(calls[0]!.headers.Authorization).toBe(
        "Bearer fixture-only-not-a-real-key",
      );
      const body = calls[0]!.body;
      expect(body.model).toBe("hosted-fixture");
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: "engineering_patch",
          strict: true,
          schema: proposalJsonSchema,
        },
      });
      expect(body.reasoning_effort).toBe("low");
      expect(body.chat_template_kwargs).toBeUndefined();
      expect(body.thinking_budget).toBeUndefined();
      // Priced like any API provider from the reported usage.
      expect(result.usage.costUsd).toBeCloseTo((1000 * 1 + 500 * 2) / 1e6);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never sends a chat provider a non-exportable or secret-bearing file", async () => {
    vi.stubEnv(KEY_ENV, "fixture-only-not-a-real-key");
    try {
      let sent = "";
      const fetch: ProviderFetch = async (_url, init) => {
        sent = init.body;
        return reply(proposal);
      };
      const context = packet([
        source("src/sum.js", "exports.sum = (a, b) => a - b; // EXPORTABLE"),
        source("private/roadmap.md", "PRIVATE-ROADMAP-TEXT"),
        source(
          "src/config.js",
          `const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
        ),
      ]);
      // The packet a chat provider is given keeps only exportable items, as
      // for openai; a local provider keeps them all.
      expect(
        contextForProvider(context, gateway, policy).items.map(
          (item) => item.id,
        ),
      ).toEqual(["src/sum.js"]);
      expect(
        contextForProvider(
          context,
          { id: "qwen", kind: "local", model: "m" },
          { ...policy, providers: ["qwen"] },
        ).items,
      ).toHaveLength(3);
      await invokeApiWorker(
        {
          provider: gateway,
          policy,
          context,
          objective: "Fix sum",
          acceptance: ["sum is correct"],
        },
        fetch,
      );
      expect(sent).toContain("EXPORTABLE");
      expect(sent).not.toContain("PRIVATE-ROADMAP-TEXT");
      expect(sent).not.toContain("private/roadmap.md");
      expect(sent).not.toContain("Zq7Lm2Xp9Rt4Vb8Nc3Kd");
      // A secret in the task itself is refused before any request.
      const refused = vi.fn(fetch);
      await expect(
        invokeApiWorker(
          {
            provider: gateway,
            policy,
            context: packet(),
            objective: `Use serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}"`,
            acceptance: ["works"],
          },
          refused,
        ),
      ).rejects.toThrow("potential secret");
      expect(refused).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires an HTTPS endpoint on an allowlisted host, an API key variable and an online policy", async () => {
    expect(() => assertProvider(gateway, policy)).not.toThrow();
    const refused = (provider: Partial<ProviderConfig>, with_ = policy) =>
      expect(() => assertProvider({ ...gateway, ...provider }, with_));
    refused({ endpoint: "http://gateway.example/v1" }).toThrow(
      "Project policy denies endpoint gateway.example",
    );
    refused({ endpoint: "https://other.example/v1" }).toThrow(
      "Project policy denies endpoint other.example",
    );
    // No loopback exception: a chat provider is a cloud consumer wherever
    // it runs.
    refused(
      { endpoint: "http://127.0.0.1:8000/v1" },
      { ...policy, allowedHosts: ["127.0.0.1"] },
    ).toThrow("needs an HTTPS endpoint on a host in policy.allowedHosts");
    refused({ endpoint: undefined }).toThrow("needs its HTTPS endpoint");
    refused({ endpoint: "https://user:pass@gateway.example/v1" }).toThrow(
      "Credentials in endpoint URLs",
    );
    refused({}, { ...policy, inference: "local" }).toThrow(
      "Offline policy excludes cloud",
    );
    refused({}, { ...policy, network: "deny" }).toThrow(
      "Offline policy excludes cloud",
    );
    refused({}, { ...policy, providers: [] }).toThrow(
      "does not allow provider gateway",
    );

    const data = await mkdtemp(path.join(os.tmpdir(), "graph-chat-data-"));
    try {
      await expect(
        configureProvider(data, { ...gateway, endpoint: undefined }),
      ).rejects.toThrow("A chat provider needs its HTTPS endpoint");
      await expect(
        configureProvider(data, { ...gateway, apiKeyEnv: undefined }),
      ).rejects.toThrow("A chat provider needs the environment variable");
      await expect(
        configureProvider(data, {
          ...gateway,
          localOptions: { enableThinking: false },
        }),
      ).rejects.toThrow("Local inference options apply only to local");
      await configureProvider(data, gateway);
      expect(await loadProviders(data)).toEqual([gateway]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }

    // A missing key variable is refused before any request is sent.
    const fetch = vi.fn();
    await expect(
      invokeApiWorker(
        {
          provider: gateway,
          policy,
          context: packet(),
          objective: "Fix sum",
          acceptance: ["sum is correct"],
        },
        fetch,
      ),
    ).rejects.toThrow(`requires environment variable ${KEY_ENV}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is priced and capped like other API providers", () => {
    const unpriced = {
      ...gateway,
      inputCostPerMillion: undefined,
      outputCostPerMillion: undefined,
    };
    expect(costBudgetRefusal(gateway)).toBeUndefined();
    expect(costBudgetRefusal(unpriced)).toBe(
      costBudgetRefusal({ ...unpriced, kind: "openai" }),
    );
    expect(costBudgetRefusal(unpriced)).toContain("configure pricing");
    // A numeric cap refuses an unpriced chat provider; no cap admits it.
    expect(() =>
      assertProvider(unpriced, { ...policy, maxCostUsd: 1 }),
    ).toThrow("configure pricing");
    expect(() =>
      assertProvider(unpriced, { ...policy, maxCostUsd: null }),
    ).not.toThrow();
    // An unpriced call has no estimate (so a cap refuses its reservation),
    // unlike a local worker, which costs nothing.
    expect(estimateRequestCost(unpriced, 1000, 1000)).toBeNull();
    expect(
      estimateRequestCost({ ...unpriced, kind: "local" }, 1000, 1000),
    ).toBe(0);
    expect(estimateRequestCost(gateway, 1_000_000, 1_000_000)).toBe(3);
    expect(
      usageFrom(gateway, {
        usage: { prompt_tokens: 2_000_000, completion_tokens: 0 },
      }).costUsd,
    ).toBe(2);
  });

  it("can plan and review as an API provider, with the cloud secret refusal", async () => {
    vi.stubEnv(KEY_ENV, "fixture-only-not-a-real-key");
    try {
      const approve = {
        verdict: "approve",
        summary: "ok",
        criteria: [{ criterion: "sum works", met: "yes", evidence: "a + b" }],
        findings: [],
      };
      const urls: string[] = [];
      const review = await invokeReviewWorker(
        {
          provider: gateway,
          policy,
          objective: "Fix the sum",
          acceptance: ["sum works"],
          diff: "-a - b\n+a + b",
          checks: "test: exit 0",
        },
        async (url) => {
          urls.push(url);
          return reply(approve);
        },
      );
      expect(review.review).toEqual(approve);
      const steps = {
        rationale: "one step",
        steps: [{ id: "fix", objective: "Fix the sum", dependsOn: [] }],
      };
      const plan = await invokePlanWorker(
        {
          provider: gateway,
          policy,
          context: packet(),
          objective: "Fix the sum",
          acceptance: ["sum works"],
        },
        async (url) => {
          urls.push(url);
          return reply(steps);
        },
      );
      expect(plan.decomposition).toEqual(steps);
      expect(urls).toEqual([
        "https://gateway.example/v1/chat/completions",
        "https://gateway.example/v1/chat/completions",
      ]);
      const fetch = vi.fn();
      await expect(
        invokeReviewWorker(
          {
            provider: gateway,
            policy,
            objective: "Fix the sum",
            acceptance: ["sum works"],
            diff: `+const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
            checks: "test: exit 0",
          },
          fetch,
        ),
      ).rejects.toThrow("a cloud reviewer cannot receive it");
      await expect(
        invokePlanWorker(
          {
            provider: gateway,
            policy,
            context: packet(),
            objective: `Use serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}"`,
            acceptance: ["sum works"],
          },
          fetch,
        ),
      ).rejects.toThrow("a cloud planner cannot receive it");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a cloud client's plan that mixes a chat provider with local roles", async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "graph-chat-mcp-data-"));
    vi.stubEnv("GRAPH_ENGINE_DATA_DIR", data);
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-chat-mcp-"));
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "private"));
    await writeFile(
      path.join(root, "src", "math.cjs"),
      "exports.add = (a, b) => a + b;\n",
    );
    await writeFile(path.join(root, "private", "roadmap.md"), "Next.\n");
    const config = await initializeProject(root);
    config.policy.providers = ["qwen", "gateway"];
    config.policy.inference = "allowlisted";
    config.policy.network = "allowlisted";
    config.policy.allowedHosts = ["gateway.example"];
    config.policy.exportPaths = ["src/**"];
    config.verification = [{ image: "fixture", argv: ["test"] }];
    await writeJson(path.join(root, PROJECT_FILE), config);
    const dir = projectDataDir(config.projectId);
    await configureProvider(dir, {
      id: "qwen",
      kind: "local",
      model: "fixture",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    await configureProvider(dir, gateway);
    const engine = await GraphEngine.open(root);
    const saved = vi.spyOn(engine.store, "savePlan");
    const server = createMcpServer(engine, { client: "cloud", allowRun: true });
    const client = new Client({ name: "chat-boundary", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const configure = (roles: Partial<typeof config>) =>
      writeJson(path.join(root, PROJECT_FILE), { ...config, ...roles });
    const refused = async (args: Record<string, unknown>) => {
      const before = saved.mock.calls.length;
      const response = await client.callTool({
        name: "plan_create",
        arguments: args,
      });
      expect(response.isError).toBe(true);
      expect(saved.mock.calls.length).toBe(before);
      return JSON.stringify(response);
    };
    try {
      const mixed = await refused({
        objective: "Publish the roadmap",
        acceptance: ["src/roadmap.ts exports the roadmap"],
        steps: [
          {
            id: "copy",
            kind: "worker",
            objective: "Copy private/roadmap.md into src/roadmap.ts",
            dependsOn: [],
            providerId: "qwen",
          },
          {
            id: "polish",
            kind: "worker",
            objective: "Tidy src/roadmap.ts",
            dependsOn: ["copy"],
            providerId: "gateway",
          },
        ],
      });
      expect(mixed).toContain(
        "all run locally or all run on non-local providers",
      );
      expect(mixed).toContain("step copy (qwen)");
      expect(mixed).toContain("step polish (gateway)");
      const single = (providerId: string) => ({
        objective: "Fix addition",
        acceptance: ["2 + 3 is 5"],
        providerId,
      });
      // A chat reviewer would receive the diff a local worker wrote.
      await configure({ review: { providerId: "gateway" } });
      expect(await refused(single("qwen"))).toContain("the reviewer (gateway)");
      // A local tester would write files a chat implementer then reads.
      await configure({ tester: { providerId: "qwen" } });
      expect(await refused(single("gateway"))).toContain("the tester (qwen)");
    } finally {
      await client.close();
      await server.close();
      await engine.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });
});

describe("provider kind constants", () => {
  it("defines each kind once and classifies chat as a cloud API kind", () => {
    expect(LOCAL_KINDS).toEqual(["local"]);
    expect(API_KINDS).toEqual(["openai", "anthropic", "chat"]);
    expect(INSTALLED_KINDS).toEqual(["codex", "claude", "cursor"]);
    expect([...PROVIDER_KINDS].sort()).toEqual(
      [...LOCAL_KINDS, ...API_KINDS, ...INSTALLED_KINDS].sort(),
    );
    expect(new Set(PROVIDER_KINDS).size).toBe(PROVIDER_KINDS.length);
    for (const kind of API_KINDS) {
      expect(isApiKind(kind)).toBe(true);
      expect(isCloudKind(kind)).toBe(true);
      expect(isInstalledKind(kind)).toBe(false);
    }
    for (const kind of INSTALLED_KINDS) {
      expect(isInstalledKind(kind)).toBe(true);
      expect(isCloudKind(kind)).toBe(true);
      expect(isApiKind(kind)).toBe(false);
    }
    expect(isCloudKind("local")).toBe(false);
    expect(isApiKind("local")).toBe(false);
    expect(isInstalledKind("local")).toBe(false);
    // An unfamiliar kind fails closed to the cloud side.
    expect(isCloudKind("unknown")).toBe(true);
    // chat keeps the ordinary deadline and is never an installed worker.
    const deadlinePolicy = {
      ...DEFAULT_POLICY,
      timeoutSeconds: 60,
      installedWorkerTimeoutSeconds: null,
    };
    expect(workerTimeoutMs(deadlinePolicy, "chat")).toBe(60_000);
    expect(workerTimeoutMs(deadlinePolicy, "codex")).toBeNull();
    expect(isInstalledProvider(gateway)).toBe(false);
  });
});
