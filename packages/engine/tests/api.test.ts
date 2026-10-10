import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import {
  DEFAULT_POLICY,
  type ContextPacket,
  type ProjectPolicy,
  type ProviderConfig,
} from "@graph-engineering/contracts";
import {
  fitWorkerContext,
  invokeApiWorker,
  proposalJsonSchema,
  StructuredOutputError,
  structuredOutputFeedback,
  workerRequestBytes,
  workerRequestTokens,
  type ProviderFetch,
  type WorkerInput,
} from "../src/workers/api.js";
import {
  BYTES_PER_TOKEN,
  estimateTokens,
  tokensForBytes,
} from "../src/tokens.js";

const replyWith = (body: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    body: new Response(JSON.stringify(body)).body,
  });

it("estimates tokens conservatively from UTF-8 bytes, one estimate for every budget", () => {
  expect(BYTES_PER_TOKEN).toBe(3);
  expect(tokensForBytes(0)).toBe(0);
  expect(tokensForBytes(1)).toBe(1);
  expect(tokensForBytes(3000)).toBe(1000);
  expect(tokensForBytes(3001)).toBe(1001);
  expect(estimateTokens("abc".repeat(10))).toBe(10);
  // Multi-byte text is counted by its bytes, never by characters.
  expect(estimateTokens("é".repeat(3))).toBe(2);
});

it("gives a 16k-token model a realistic window: accepts a request over 16k bytes that fits in tokens, and still refuses an oversize one", async () => {
  const input = (bytes: number): WorkerInput => ({
    provider: { id: "local", kind: "local", model: "fixture" },
    policy: {
      ...DEFAULT_POLICY,
      providers: ["local"],
      maxContextTokens: 16_000,
    },
    objective: "Fix",
    acceptance: ["tests pass"],
    context: {
      version: "1.0.0",
      projectId: "project",
      snapshotId: "snapshot",
      query: "fix",
      mandatory: ["tests pass"],
      estimatedTokens: 0,
      budgetTokens: 16_000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
      items: [{ id: "file", kind: "code", text: "a".repeat(bytes), score: 1 }],
    },
  });
  const fits = input(30_000);
  expect(workerRequestBytes(fits)).toBeGreaterThan(16_000);
  expect(workerRequestTokens(fits)).toBe(
    tokensForBytes(workerRequestBytes(fits)),
  );
  expect(workerRequestTokens(fits)).toBeLessThanOrEqual(16_000);
  expect(fitWorkerContext(fits).context.items.map((item) => item.id)).toEqual([
    "file",
  ]);
  const fetch = vi.fn<ProviderFetch>(() =>
    replyWith({
      model: "fixture",
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "Fix",
              changes: [],
              requests: [],
            }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 9000, completion_tokens: 20 },
    }),
  );
  await expect(invokeApiWorker(fits, fetch)).resolves.toMatchObject({
    proposal: { summary: "Fix" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const oversize = input(60_000);
  expect(workerRequestTokens(oversize)).toBeGreaterThan(16_000);
  await expect(invokeApiWorker(oversize, fetch)).rejects.toThrow(
    "Worker request exceeds configured context budget",
  );
  expect(() => fitWorkerContext(oversize)).not.toThrow();
  expect(fitWorkerContext(oversize).context.items).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

const outputPacket: ContextPacket = {
  version: "1.0.0",
  projectId: "project",
  snapshotId: "snapshot",
  query: "fix",
  mandatory: ["tests pass"],
  mandatorySources: [],
  items: [],
  estimatedTokens: 20,
  budgetTokens: 1000,
  coverage: { semantic: false, graph: "syntactic", warnings: [] },
};
const cloudPolicy = (id: string, host: string): ProjectPolicy => ({
  ...DEFAULT_POLICY,
  providers: [id],
  inference: "allowlisted",
  network: "allowlisted",
  allowedHosts: [host],
});
const outputInput = (
  provider: ProviderConfig,
  policy: ProjectPolicy,
): WorkerInput => ({
  provider,
  policy,
  context: outputPacket,
  objective: "Fix sum",
  acceptance: ["sum is correct"],
});
const localProvider: ProviderConfig = {
  id: "local",
  kind: "local",
  model: "fixture",
};
const localPolicy: ProjectPolicy = { ...DEFAULT_POLICY, providers: ["local"] };

it("reports malformed or schema-invalid worker output as a recoverable StructuredOutputError with the call's usage", async () => {
  for (const content of [
    '{"summary":"Fix","changes":[',
    JSON.stringify({ summary: "Fix" }),
    JSON.stringify({ summary: "Fix", changes: [], requests: [], extra: 1 }),
  ]) {
    const error = await invokeApiWorker(
      outputInput(localProvider, localPolicy),
      () =>
        replyWith({
          model: "fixture",
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 70, completion_tokens: 9 },
        }),
    ).catch((caught: unknown) => caught);
    expect(error, content).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).reason).toBe("malformed-output");
    expect((error as StructuredOutputError).usage).toMatchObject({
      inputTokens: 70,
      outputTokens: 9,
      costUsd: 0,
    });
    expect(structuredOutputFeedback(error as StructuredOutputError)).toContain(
      "not a valid JSON proposal",
    );
  }
});

it("detects truncated structured output from chat completions, the Responses API and Anthropic", async () => {
  vi.stubEnv("GRAPH_TEST_TRUNCATION_KEY", "fixture-only-not-a-real-key");
  try {
    const cut = '{"summary":"Fi';
    const cases: {
      provider: ProviderConfig;
      policy: ProjectPolicy;
      reply: unknown;
    }[] = [
      {
        provider: localProvider,
        policy: localPolicy,
        reply: {
          choices: [{ message: { content: cut }, finish_reason: "length" }],
          usage: { prompt_tokens: 50, completion_tokens: 4000 },
        },
      },
      {
        provider: {
          id: "gateway",
          kind: "chat",
          model: "fixture",
          endpoint: "https://gateway.example/v1",
          apiKeyEnv: "GRAPH_TEST_TRUNCATION_KEY",
        },
        policy: cloudPolicy("gateway", "gateway.example"),
        reply: {
          choices: [{ message: { content: cut }, finish_reason: "length" }],
          usage: { prompt_tokens: 50, completion_tokens: 4000 },
        },
      },
      {
        provider: {
          id: "gpt",
          kind: "openai",
          model: "fixture",
          apiKeyEnv: "GRAPH_TEST_TRUNCATION_KEY",
        },
        policy: cloudPolicy("gpt", "api.openai.com"),
        reply: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            { type: "message", content: [{ type: "output_text", text: cut }] },
          ],
          usage: { input_tokens: 50, output_tokens: 4000 },
        },
      },
      {
        provider: {
          id: "claude-api",
          kind: "anthropic",
          model: "fixture",
          apiKeyEnv: "GRAPH_TEST_TRUNCATION_KEY",
        },
        policy: cloudPolicy("claude-api", "api.anthropic.com"),
        reply: {
          content: [{ type: "text", text: cut }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 50, output_tokens: 4000 },
        },
      },
    ];
    for (const { provider, policy, reply } of cases) {
      const error = await invokeApiWorker(outputInput(provider, policy), () =>
        replyWith(reply),
      ).catch((caught: unknown) => caught);
      expect(error, provider.kind).toBeInstanceOf(StructuredOutputError);
      expect((error as StructuredOutputError).reason).toBe("truncated-output");
      expect((error as Error).message).toContain("maxOutputTokens");
      expect((error as StructuredOutputError).usage.outputTokens).toBe(4000);
      expect(
        structuredOutputFeedback(error as StructuredOutputError),
      ).toContain("cut off at the output token limit");
    }
    // A completed Responses answer is not mistaken for a truncated one.
    await expect(
      invokeApiWorker(outputInput(cases[2]!.provider, cases[2]!.policy), () =>
        replyWith({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    summary: "Fix",
                    changes: [],
                    requests: [],
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
      ),
    ).resolves.toMatchObject({ proposal: { summary: "Fix" } });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("budgets serialized metadata and framing without trimming mandatory evidence", () => {
  const input: WorkerInput = {
    provider: { id: "local", kind: "local", model: "fixture" },
    policy: { ...DEFAULT_POLICY, providers: ["local"], maxContextTokens: 2000 },
    objective: "Fix the regression",
    acceptance: ["Keep required behavior"],
    context: {
      version: "1.0.0",
      projectId: "project",
      snapshotId: "snapshot",
      query: "regression",
      mandatory: ["Do not change the API"],
      estimatedTokens: 1900,
      budgetTokens: 2000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
      items: [
        { id: "useful", kind: "code", text: "important".repeat(50), score: 1 },
        { id: "extra", kind: "code", text: '\\"\n'.repeat(1800), score: 0.1 },
      ],
    },
  };
  expect(workerRequestTokens(input)).toBeGreaterThan(2000);
  const result = fitWorkerContext(input);
  expect(workerRequestTokens(result)).toBeLessThanOrEqual(2000);
  expect(result.context.items.map((item) => item.id)).toEqual(["useful"]);
  expect(result.context.mandatory).toEqual(input.context.mandatory);
  expect(input.context.items).toHaveLength(2);
  expect(() =>
    fitWorkerContext({
      ...input,
      context: { ...input.context, mandatory: ["required".repeat(1000)] },
    }),
  ).toThrow("Mandatory worker request");
  expect(() =>
    fitWorkerContext({
      ...input,
      provider: { ...input.provider, maxContextTokens: 500 },
    }),
  ).toThrow("Mandatory worker request");
});

it("uses a local OpenAI-compatible endpoint and validates its structured patch", async () => {
  let received: any;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        model: "local-fixture",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Fix",
                changes: [{ path: "sum.js", before: "a-b", after: "a+b" }],
                requests: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const packet: ContextPacket = {
      version: "1.0.0",
      projectId: "project",
      snapshotId: "snapshot",
      query: "fix",
      mandatory: ["tests pass"],
      items: [],
      estimatedTokens: 20,
      budgetTokens: 1000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
    };
    const result = await invokeApiWorker({
      provider: {
        id: "local",
        kind: "local",
        model: "fixture",
        endpoint: `http://127.0.0.1:${port}/v1`,
        localOptions: { enableThinking: false, thinkingBudget: 0 },
      },
      policy: { ...DEFAULT_POLICY, providers: ["local"] },
      context: packet,
      objective: "Fix sum",
      acceptance: ["sum is correct"],
    });
    expect(result.proposal.changes[0].after).toBe("a+b");
    expect(result.usage.inputTokens).toBe(100);
    expect(received.response_format.type).toBe("json_schema");
    expect(received.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(received.thinking_budget).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("requests Anthropic structured output and rejects refusal or truncation", async () => {
  const proposal = {
    summary: "Fix",
    changes: [{ path: "sum.js", before: "a-b", after: "a+b" }],
    requests: [],
  };
  const replies = [
    {
      model: "fixture",
      content: [
        { type: "thinking", thinking: "", signature: "fixture" },
        { type: "text", text: JSON.stringify(proposal) },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    {
      model: "fixture",
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: null },
      usage: { input_tokens: 100, output_tokens: 0 },
    },
    {
      model: "fixture",
      content: [{ type: "text", text: '{"summary":"Fi' }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 4000 },
    },
  ];
  const received: any[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    paths.push(String(request.url));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(replies.shift()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("GRAPH_TEST_ANTHROPIC_KEY", "fixture-only-not-a-real-key");
  try {
    const port = (server.address() as { port: number }).port;
    const input: WorkerInput = {
      provider: {
        id: "claude-api",
        kind: "anthropic",
        model: "fixture",
        endpoint: `http://127.0.0.1:${port}`,
        apiKeyEnv: "GRAPH_TEST_ANTHROPIC_KEY",
        efforts: ["medium"],
      },
      policy: {
        ...DEFAULT_POLICY,
        providers: ["claude-api"],
        inference: "allowlisted",
        network: "allowlisted",
      },
      context: {
        version: "1.0.0",
        projectId: "project",
        snapshotId: "snapshot",
        query: "fix",
        mandatory: ["tests pass"],
        mandatorySources: [],
        items: [],
        estimatedTokens: 20,
        budgetTokens: 1000,
        coverage: { semantic: false, graph: "syntactic", warnings: [] },
      },
      objective: "Fix sum",
      acceptance: ["sum is correct"],
      effort: "medium",
    };
    const result = await invokeApiWorker(input);
    expect(result.proposal).toEqual(proposal);
    expect(result.usage.inputTokens).toBe(100);
    expect(paths[0]).toBe("/v1/messages");
    expect(received[0].output_config).toEqual({
      format: { type: "json_schema", schema: proposalJsonSchema },
      effort: "medium",
    });
    expect(received[0].tools).toBeUndefined();
    expect(received[0].tool_choice).toBeUndefined();
    await expect(invokeApiWorker(input)).rejects.toThrow("declined");
    await expect(invokeApiWorker(input)).rejects.toThrow("maxOutputTokens");
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
