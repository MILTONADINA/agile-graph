import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checked } from "../src/util.js";

// A cloud-backed MCP client ends its session by closing the server's standard
// input, and the server then exits by itself. The client's SIGTERM comes only
// after a grace period, and Windows delivers SIGTERM as a forced kill that
// skips the server's close of its context database and run store.

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../", import.meta.url));
// Far above a clean close, far below the test timeout.
const EXIT_WITHIN_MS = 5_000;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-mcp-stdin-"));
  const data = await mkdtemp(path.join(tmpdir(), "graph-mcp-stdin-data-"));
  directories.push(root, data);
  await checked("git", ["init", "-q"], { cwd: root });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  Object.assign(env, {
    GRAPH_ENGINE_DATA_DIR: data,
    CI: "",
    GRAPH_ENGINE_NO_FEEDBACK: "1",
  });
  const argv = (...args: string[]) => [
    "--import",
    "tsx",
    CLI,
    "-C",
    root,
    ...args,
  ];
  await checked(process.execPath, argv("init"), { cwd: ENGINE, env });
  return {
    env,
    serve: () =>
      spawn(process.execPath, argv("mcp", "--client", "cloud"), {
        cwd: ENGINE,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
  };
}

// Newline-delimited JSON-RPC, as an MCP client speaks it over stdio.
function converse(child: ChildProcessWithoutNullStreams) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  // The reply to request `id`, once the server has written it.
  const reply = async (id: number) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const found = stdout
        .split("\n")
        .slice(0, -1)
        .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
        .find((message) => message.id === id);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(
          `no reply to request ${id}; stderr: ${stderr.slice(-500)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const initialize = async () => {
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-stdin-shutdown", version: "1.0" },
      },
    });
    expect((await reply(1)).result).toBeDefined();
    send({ method: "notifications/initialized" });
  };
  return { send, reply, initialize, stderr: () => stderr };
}

// The server's exit as [code, signal], or undefined if it has not exited within `ms`.
async function exitWithin(child: ChildProcessWithoutNullStreams, ms: number) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const exited = once(child, "exit").then(([code, signal]) => ({
    code,
    signal,
  }));
  try {
    return await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

it("exits by itself when its client closes stdin, without waiting for a signal", async () => {
  const { serve } = await project();
  const child = serve();
  const client = converse(child);
  try {
    await client.initialize();
    client.send({ id: 2, method: "tools/list" });
    expect((await client.reply(2)).result).toBeDefined();
    child.stdin.end();
    expect(await exitWithin(child, EXIT_WITHIN_MS), client.stderr()).toEqual({
      code: 0,
      signal: null,
    });
  } finally {
    child.kill("SIGKILL");
  }
}, 120_000);

it("answers a request its client sent before closing stdin, then exits by itself", async () => {
  const { serve } = await project();
  const child = serve();
  const client = converse(child);
  try {
    await client.initialize();
    client.send({
      id: 2,
      method: "tools/call",
      params: { name: "context_get", arguments: { query: "rule" } },
    });
    // The client closes stdin before the server has written that reply.
    child.stdin.end();
    expect((await client.reply(2)).result).toBeDefined();
    expect(await exitWithin(child, EXIT_WITHIN_MS), client.stderr()).toEqual({
      code: 0,
      signal: null,
    });
  } finally {
    child.kill("SIGKILL");
  }
}, 120_000);
