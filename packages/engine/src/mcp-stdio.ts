import { PassThrough } from "node:stream";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

/** The SDK's own stdio line limit. */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

type Reply = (message: JSONRPCMessage) => Promise<void>;
const error = (
  id: string | number | null,
  code: number,
  message: string,
): JSONRPCMessage =>
  ({ jsonrpc: "2.0", id, error: { code, message } }) as JSONRPCMessage;

/**
 * The reply a malformed stdio line gets, or undefined when the line is a valid
 * JSON-RPC message the server should receive. The SDK's stdio transport drops
 * a frame it cannot parse with no reply, so a client waiting on that id hangs
 * until its own timeout (#297). Error texts are fixed; they never quote the
 * line or a validator's output.
 */
export function screenJsonRpcLine(line: string): JSONRPCMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return error(null, -32700, "Parse error");
  }
  if (Array.isArray(value))
    return error(null, -32600, "Batch requests are not supported over stdio");
  const raw = value as { id?: unknown; method?: unknown; params?: unknown };
  const id =
    typeof raw?.id === "string" || typeof raw?.id === "number" ? raw.id : null;
  if (!JSONRPCMessageSchema.safeParse(value).success)
    return error(id, -32600, "Invalid Request");
  if (raw.method === "tools/call" && id !== null) {
    const args = (raw.params as { arguments?: unknown } | undefined)?.arguments;
    if (
      args !== undefined &&
      (args === null || typeof args !== "object" || Array.isArray(args))
    )
      return error(id, -32602, "Invalid params: arguments must be an object");
  }
  return undefined;
}

/**
 * A copy of `input` holding only the lines the server should receive. Each
 * other line is answered through `reply`, and the copy ends only after those
 * replies are written, so a client's last malformed line is still answered.
 */
export function screenJsonRpcLines(
  input: NodeJS.ReadableStream,
  reply: Reply,
): PassThrough {
  const output = new PassThrough();
  let pending = Buffer.alloc(0);
  let skipping = false;
  let replies: Promise<void> = Promise.resolve();
  const answer = (message: JSONRPCMessage) => {
    replies = replies.then(() => reply(message)).catch(() => {});
  };
  const line = (bytes: Buffer) => {
    const text = bytes.toString("utf8").replace(/\r$/, "");
    if (!text.trim()) return;
    const refusal = screenJsonRpcLine(text);
    if (refusal) answer(refusal);
    else output.write(`${text}\n`);
  };
  const onData = (chunk: Buffer | string) => {
    pending = Buffer.concat([
      pending,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ]);
    for (let index; (index = pending.indexOf(10)) !== -1;) {
      if (skipping) skipping = false;
      // Checked per line, so the limit does not depend on chunk boundaries.
      else if (index > MAX_LINE_BYTES)
        answer(error(null, -32600, "Request too large"));
      else line(pending.subarray(0, index));
      pending = pending.subarray(index + 1);
    }
    if (pending.length > MAX_LINE_BYTES) {
      // Too long to be a message: answer once and drop it up to its newline.
      if (!skipping) answer(error(null, -32600, "Request too large"));
      skipping = true;
      pending = Buffer.alloc(0);
    }
  };
  const onEnd = () => {
    if (pending.length && !skipping) line(pending);
    void replies.then(() => output.end());
  };
  const onError = (cause: Error) => output.destroy(cause);
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onError);
  // Once the server is done with the copy, let go of the input, as the SDK's
  // transport does on close, so a listener left on stdin cannot keep the
  // process alive after shutdown.
  output.once("close", () => {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    if (input.listenerCount("data") === 0) input.pause();
  });
  return output;
}
