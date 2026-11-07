import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphEngine } from "../src/service.js";
import {
  PROJECT_FILE,
  configureProvider,
  initializeProject,
  projectDataDir,
} from "../src/project.js";
import { writeJson } from "../src/util.js";
import { createMcpServer } from "../src/mcp.js";

// specs/integration/mcp-server.md: every free-text string a tool accepts has a
// length bound, so an oversized input is refused by the schema (#296).
async function withClient(
  fn: (client: Client, engine: GraphEngine) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-bounds-"));
  // A permitted, configured worker: without one, plan_create refuses before it
  // would echo a providerId.
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  await writeJson(path.join(root, PROJECT_FILE), config);
  const data = projectDataDir(config.projectId);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
  });
  await writeFile(
    path.join(root, "math.ts"),
    "export function add(a: number, b: number) { return a + b; }",
  );
  const engine = await GraphEngine.open(root);
  const server = createMcpServer(engine, {
    client: "local",
    allowRun: true,
    allowRunStatus: true,
  });
  const client = new Client({ name: "bounds-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await fn(client, engine);
  } finally {
    await client.close();
    await server.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

type Schema = Record<string, unknown>;
function unboundedStrings(schema: unknown, at: string, out: string[]) {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Schema;
  if (
    s.type === "string" &&
    s.maxLength === undefined &&
    !s.enum &&
    s.const === undefined
  )
    out.push(at);
  for (const [key, value] of Object.entries(s.properties ?? {}))
    unboundedStrings(value, `${at}.${key}`, out);
  if (s.items) unboundedStrings(s.items, `${at}[]`, out);
  for (const key of ["anyOf", "oneOf", "allOf"] as const)
    for (const [i, value] of ((s[key] as unknown[]) ?? []).entries())
      unboundedStrings(value, `${at}|${i}`, out);
}

it("every string a tool accepts has a maxLength in tools/list", async () => {
  await withClient(async (client) => {
    const unbounded: string[] = [];
    for (const tool of (await client.listTools()).tools)
      unboundedStrings(tool.inputSchema, tool.name, unbounded);
    expect(unbounded).toEqual([]);
  });
});

const text = (result: unknown) => JSON.stringify(result);

it("refuses an over-length symbol_search query and providerId without echoing them", async () => {
  await withClient(async (client) => {
    const query = "q".repeat(49_999);
    const search = await client.callTool({
      name: "symbol_search",
      arguments: { query },
    });
    expect(search.isError).toBe(true);
    expect(text(search)).not.toContain(query.slice(0, 600));
    expect(text(search).length).toBeLessThan(2_000);
    expect(text(search)).not.toMatch(/LIKE or GLOB/);

    const providerId = "p".repeat(20_000);
    const plan = await client.callTool({
      name: "plan_create",
      arguments: { objective: "Add a toy function", providerId },
    });
    expect(plan.isError).toBe(true);
    expect(text(plan)).not.toContain(providerId.slice(0, 300));
    expect(text(plan).length).toBeLessThan(2_000);
  });
});

it("returns a fixed message when SQLite refuses a symbol pattern", async () => {
  await withClient(async (_client, engine) => {
    // Past the schema bound, straight to the index, as an internal caller could.
    await expect(
      engine.context.searchSymbols("x".repeat(60_000)),
    ).rejects.toThrow(/^The symbol search query is too long; shorten it\.$/);
  });
});

it("names validUntil, not only a CLI flag, when an MCP memory expiry has passed", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "memory_propose",
      arguments: {
        text: "Toy constraint",
        kind: "constraint",
        validUntil: "2000-01-01T00:00:00Z",
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("give a later expiry (validUntil");
  });
});
