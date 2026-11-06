import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { screenJsonRpcLine, screenJsonRpcLines } from "../src/mcp-stdio.js";

describe("JSON-RPC stdio screening (#297)", () => {
  it("answers each malformed frame with the JSON-RPC error code and a fixed message", () => {
    expect(screenJsonRpcLine("{not json")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(screenJsonRpcLine('{"jsonrpc":"2.0","id":77}')).toMatchObject({
      id: 77,
      error: { code: -32600 },
    });
    expect(
      screenJsonRpcLine(
        '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":null}',
      ),
    ).toMatchObject({ id: 21, error: { code: -32600 } });
    expect(screenJsonRpcLine("[]")).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    const strings = screenJsonRpcLine(
      '{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"symbol_search","arguments":"x"}}',
    );
    expect(strings).toEqual({
      jsonrpc: "2.0",
      id: 22,
      error: {
        code: -32602,
        message: "Invalid params: arguments must be an object",
      },
    });
  });

  it("passes valid messages through unchanged, including notifications", () => {
    for (const line of [
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x","arguments":{}}}',
      '{"jsonrpc":"2.0","id":3,"result":{}}',
    ])
      expect(screenJsonRpcLine(line), line).toBeUndefined();
  });

  it("forwards valid lines, answers the rest, and ends only after the last answer", async () => {
    const input = new PassThrough();
    const replies: unknown[] = [];
    const output = screenJsonRpcLines(input, async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      replies.push(message);
    });
    let forwarded = "";
    output.on("data", (chunk) => (forwarded += chunk));
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n{not');
    input.write(" json\n\n");
    input.end('{"jsonrpc":"2.0","id":9}');
    await once(output, "end");
    expect(forwarded).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(replies).toMatchObject([
      { id: null, error: { code: -32700 } },
      { id: 9, error: { code: -32600 } },
    ]);
  });

  it("lets go of its input once its output closes", () => {
    const input = new PassThrough();
    const output = screenJsonRpcLines(input, async () => {});
    expect(input.listenerCount("data")).toBe(1);
    output.destroy();
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(input.listenerCount("data")).toBe(0);
        expect(input.listenerCount("end")).toBe(0);
        expect(input.isPaused()).toBe(true);
        resolve();
      }),
    );
  });
  it("refuses a line over 10 MB even when its newline arrives in the same chunk", async () => {
    const input = new PassThrough();
    const replies: unknown[] = [];
    const output = screenJsonRpcLines(input, async (message) => {
      replies.push(message);
    });
    let forwarded = "";
    output.on("data", (chunk) => (forwarded += chunk));
    input.write("x".repeat(10 * 1024 * 1024 - 1));
    input.write("xx\n");
    input.end('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    await once(output, "end");
    expect(replies).toMatchObject([
      { id: null, error: { code: -32600, message: "Request too large" } },
    ]);
    expect(forwarded).toBe('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  });
});
