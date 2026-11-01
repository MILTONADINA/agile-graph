import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as CursorSdk from "@cursor/sdk";
import {
  runCursorTextProposal,
  type CursorRunnerRequest,
} from "../src/workers/cursor-runner.js";

const proposal = {
  summary: "Use the existing return value",
  changes: [],
  requests: [],
};
const scratchWorkspace = path.resolve(os.tmpdir(), "graph-cursor-fixture");

function fixture(events: Array<Record<string, unknown>> = []) {
  const cancel = vi.fn(async () => {});
  const close = vi.fn();
  const run = {
    async *stream() {
      for (const event of events) yield event;
    },
    wait: vi.fn(async () => ({
      status: "finished",
      result: JSON.stringify(proposal),
      model: { id: "fixture-model" },
      usage: {
        inputTokens: 55,
        outputTokens: 40,
        cacheReadTokens: 8,
      },
    })),
    cancel,
  };
  const send = vi.fn(async () => run);
  const create = vi.fn(async () => ({ send, close }));
  class JsonlLocalAgentStore {
    constructor(public readonly directory: string) {}
  }
  return {
    sdk: {
      Agent: { create },
      JsonlLocalAgentStore,
    } as unknown as typeof CursorSdk,
    create,
    send,
    close,
    cancel,
    run,
  };
}

function request(): CursorRunnerRequest {
  return {
    workspace: scratchWorkspace,
    model: "fixture-model",
    prompt: "Return a JSON proposal for this selected public source.",
    maxInputTokens: 1024,
    maxOutputTokens: 128,
  };
}

describe("Cursor SDK scratch proposal runner", () => {
  it("disables every ambient settings layer and built-in tool", async () => {
    const fake = fixture();
    const result = await runCursorTextProposal(
      request(),
      "test-user-key",
      fake.sdk,
    );
    expect(result).toEqual({
      proposal,
      model: "fixture-model",
      usage: {
        inputTokens: 55,
        outputTokens: 40,
        cachedTokens: 8,
        costUsd: null,
        estimated: false,
      },
    });
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-user-key",
        model: { id: "fixture-model" },
        tools: [],
        disallowedTools: ["shell", "mcp", "task"],
        mcpServers: {},
        local: expect.objectContaining({
          cwd: scratchWorkspace,
          settingSources: [],
          sandboxOptions: { enabled: true },
          autoReview: false,
          customTools: {},
          enableAgentRetries: false,
        }),
      }),
    );
    expect(fake.send).toHaveBeenCalledWith(request().prompt, {
      mcpServers: {},
    });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("rejects tool activity and cancels before accepting a proposal", async () => {
    const fake = fixture([{ type: "tool_call", name: "read" }]);
    await expect(
      runCursorTextProposal(request(), "test-user-key", fake.sdk),
    ).rejects.toThrow("tool operation");
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("rejects reported token overruns and missing credentials before success", async () => {
    const fake = fixture([
      {
        type: "usage",
        usage: { inputTokens: 55, outputTokens: 129 },
      },
    ]);
    await expect(
      runCursorTextProposal(request(), "test-user-key", fake.sdk),
    ).rejects.toThrow("token bound");
    expect(fake.cancel).toHaveBeenCalledOnce();
    const missing = fixture();
    await expect(
      runCursorTextProposal(request(), "", missing.sdk),
    ).rejects.toThrow("user key is required");
    expect(missing.create).not.toHaveBeenCalled();
  });

  it("rejects oversized final text before parsing and closes the agent", async () => {
    const fake = fixture();
    fake.run.wait.mockResolvedValueOnce({
      status: "finished",
      result: "x".repeat(1_000_001),
      model: { id: "fixture-model" },
      usage: { inputTokens: 55, outputTokens: 40, cacheReadTokens: 8 },
    });
    await expect(
      runCursorTextProposal(request(), "test-user-key", fake.sdk),
    ).rejects.toThrow("response byte limit");
    expect(fake.close).toHaveBeenCalledOnce();
  });
});

describe("Cursor SDK scratch proposal runner: input validation", () => {
  it("refuses a relative scratch workspace before creating an agent", async () => {
    const fake = fixture();
    await expect(
      runCursorTextProposal(
        { ...request(), workspace: "relative/scratch" },
        "test-user-key",
        fake.sdk,
      ),
    ).rejects.toThrow("must be absolute");
    expect(fake.create).not.toHaveBeenCalled();
  });

  it.each([
    ["zero input bound", { maxInputTokens: 0 }],
    ["negative output bound", { maxOutputTokens: -1 }],
    ["fractional input bound", { maxInputTokens: 10.5 }],
    ["non-finite output bound", { maxOutputTokens: Infinity }],
    ["NaN input bound", { maxInputTokens: Number.NaN }],
  ])("refuses invalid token bounds: %s", async (_name, override) => {
    const fake = fixture();
    await expect(
      runCursorTextProposal(
        { ...request(), ...override },
        "test-user-key",
        fake.sdk,
      ),
    ).rejects.toThrow("token bounds are invalid");
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("refuses a prompt larger than the input bound without contacting the SDK", async () => {
    const fake = fixture();
    await expect(
      runCursorTextProposal(
        { ...request(), prompt: "word ".repeat(2000), maxInputTokens: 10 },
        "test-user-key",
        fake.sdk,
      ),
    ).rejects.toThrow("input bound");
    expect(fake.create).not.toHaveBeenCalled();
  });
});

describe("Cursor SDK scratch proposal runner: result handling", () => {
  const finished = (over: Record<string, unknown> = {}) => ({
    status: "finished",
    result: JSON.stringify(proposal),
    model: { id: "fixture-model" },
    usage: { inputTokens: 55, outputTokens: 40, cacheReadTokens: 8 },
    ...over,
  });
  const run = (fake: ReturnType<typeof fixture>, result: unknown) => {
    fake.run.wait.mockResolvedValueOnce(result as never);
    return runCursorTextProposal(request(), "test-user-key", fake.sdk);
  };

  it.each([
    ["a cancelled run", finished({ status: "cancelled" })],
    ["an errored run", finished({ status: "error" })],
    ["a non-string result", finished({ result: { proposal } })],
    ["a missing result", finished({ result: undefined })],
  ])("rejects %s and still closes the agent", async (_name, result) => {
    const fake = fixture();
    await expect(run(fake, result)).rejects.toThrow("did not finish");
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("measures the response limit in bytes, not characters", async () => {
    // Bytes, not characters, are measured: 4-byte characters push a short
    // string past the 1,000,000 byte limit.
    const fake = fixture();
    await expect(
      run(fake, finished({ result: "😀".repeat(250_001) })),
    ).rejects.toThrow("response byte limit");
  });

  it("rejects result usage over either bound after the run finished", async () => {
    await expect(
      run(
        fixture(),
        finished({ usage: { inputTokens: 1025, outputTokens: 1 } }),
      ),
    ).rejects.toThrow("token bound");
    await expect(
      run(
        fixture(),
        finished({ usage: { inputTokens: 1, outputTokens: 129 } }),
      ),
    ).rejects.toThrow("token bound");
  });

  it("accepts usage exactly at the bounds", async () => {
    const result = await run(
      fixture(),
      finished({ usage: { inputTokens: 1024, outputTokens: 128 } }),
    );
    expect(result.usage).toMatchObject({
      inputTokens: 1024,
      outputTokens: 128,
    });
  });

  it("treats negative, non-finite and missing usage as unknown rather than trusting it", async () => {
    const result = await run(
      fixture(),
      finished({
        usage: {
          inputTokens: -5,
          outputTokens: Number.NaN,
          cacheReadTokens: Infinity,
        },
      }),
    );
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      estimated: false,
    });
    const noUsage = await run(fixture(), finished({ usage: undefined }));
    expect(noUsage.usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("rejects a model other than the one selected", async () => {
    await expect(
      run(fixture(), finished({ model: { id: "other-model" } })),
    ).rejects.toThrow("changed the selected worker model");
  });

  it("allows the auto model to resolve to a concrete one and reports it", async () => {
    const fake = fixture();
    fake.run.wait.mockResolvedValueOnce(
      finished({ model: { id: "concrete-model" } }) as never,
    );
    const result = await runCursorTextProposal(
      { ...request(), model: "auto" },
      "test-user-key",
      fake.sdk,
    );
    expect(result.model).toBe("concrete-model");
  });

  it("falls back to the requested model when the result names none", async () => {
    const result = await run(fixture(), finished({ model: undefined }));
    expect(result.model).toBe("fixture-model");
  });

  it("rejects text that is not JSON and closes the agent", async () => {
    const fake = fixture();
    await expect(run(fake, finished({ result: "not json {" }))).rejects.toThrow(
      "no valid JSON proposal",
    );
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("does not trust a stream usage event with non-finite counts to trigger or hide an overrun", async () => {
    const ok = fixture([
      { type: "usage", usage: { inputTokens: Number.NaN, outputTokens: -3 } },
      { type: "usage", usage: { inputTokens: 1024, outputTokens: 128 } },
      { type: "message", text: "ignored" },
    ]);
    await expect(
      runCursorTextProposal(request(), "test-user-key", ok.sdk),
    ).resolves.toMatchObject({ model: "fixture-model" });
    expect(ok.cancel).not.toHaveBeenCalled();
    const over = fixture([
      { type: "usage", usage: { inputTokens: 1025, outputTokens: 0 } },
    ]);
    await expect(
      runCursorTextProposal(request(), "test-user-key", over.sdk),
    ).rejects.toThrow("token bound");
    expect(over.cancel).toHaveBeenCalledOnce();
  });

  it("puts the agent store inside the scratch workspace", async () => {
    const fake = fixture();
    await runCursorTextProposal(request(), "test-user-key", fake.sdk);
    const options = fake.create.mock.calls[0]![0] as unknown as {
      local: { store: { directory: string } };
    };
    expect(options.local.store.directory).toBe(
      path.join(scratchWorkspace, "store"),
    );
  });
});
