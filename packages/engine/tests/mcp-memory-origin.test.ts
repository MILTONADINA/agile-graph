import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createMcpServer } from "../src/mcp.js";

// #295: a memory proposed through MCP records which kind of client proposed
// it, review and acceptance show that, and the call log links the memory.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-memory-origin-"));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.exportPaths = ["src/**"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "toy.ts"), "export const toy = 1;\n");
  const engine = await GraphEngine.open(root);
  cleanups.push(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  });
  return engine;
}

async function propose(engine: GraphEngine, client: "cloud" | "local") {
  const server = createMcpServer(engine, { client });
  const mcp = new Client({ name: "memory-origin-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  try {
    const result = (await mcp.callTool({
      name: "memory_propose",
      arguments: {
        text: `Toy requirement from ${client}`,
        kind: "requirement",
      },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return JSON.parse(result.content[0]!.text) as { id: string };
  } finally {
    await mcp.close();
    await server.close();
  }
}

describe("memory proposal origin (#295)", () => {
  it("a cloud requirement proposal records proposedBy cloud through review and acceptance, and the call log names it", async () => {
    const engine = await project();
    const { id } = await propose(engine, "cloud");
    expect((await engine.context.memory(id)).proposedBy).toBe("cloud");
    const [entry] = engine.store.mcpCalls({ limit: 1, tool: "memory_propose" });
    expect(entry).toMatchObject({
      clientKind: "cloud",
      outcome: "ok",
      memoryId: id,
    });
    const accepted = await engine.context.acceptMemory(id, {});
    expect(accepted).toMatchObject({ status: "accepted", proposedBy: "cloud" });
    await engine.context.index({ semantic: false });
    const review = (await engine.context.reviewMemories()).find(
      (item) => item.memoryId === id,
    );
    expect(review?.proposedBy).toBe("cloud");
  });

  it("a local client's proposal records proposedBy local", async () => {
    const engine = await project();
    const { id } = await propose(engine, "local");
    expect((await engine.context.memory(id)).proposedBy).toBe("local");
    expect(
      engine.store.mcpCalls({ limit: 1, tool: "memory_propose" })[0]?.memoryId,
    ).toBe(id);
  });

  it("a memory a person adds directly has no proposedBy", async () => {
    const engine = await project();
    const memory = await engine.context.createMemory({
      text: "Toy decision added locally",
      kind: "decision",
    });
    expect(memory.proposedBy).toBeUndefined();
  });
});
