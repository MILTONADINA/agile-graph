import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphEngine } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
} from "../src/project.js";
import { cloudErrorText, createMcpServer } from "../src/mcp.js";

// #294: an enabled provider whose endpoint host policy denies. A cloud client
// learns that the endpoint is denied, not its host; a local client sees both.
const HOST = "gateway.example.invalid";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function deniedGateway() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-cloud-host-"));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = [];
  config.policy.exportPaths = ["src/**"];
  config.policy.providers = ["gw", "off"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
  for (const id of ["gw", "off"])
    await configureProvider(projectDataDir(config.projectId), {
      id,
      kind: "chat",
      model: "gpt-toy-1",
      endpoint: `https://${HOST}/v1`,
      apiKeyEnv: "TOY_UNSET_KEY_VAR",
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      efforts: ["low"],
    });
  // "off" is configured but not permitted: its refusal names no host.
  config.policy.providers = ["gw"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
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

async function call(
  engine: GraphEngine,
  client: "cloud" | "local",
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = createMcpServer(engine, { client, allowRun: true });
  const mcp = new Client({ name: "cloud-host-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  try {
    const result = (await mcp.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError).toBe(true);
    return result.content.map((part) => part.text).join("\n");
  } finally {
    await mcp.close();
    await server.close();
  }
}

const decompose = (plannerId: string) => ({
  objective: "Add a toy greeting",
  acceptance: ["The greeting prints"],
  plannerId,
});
const create = (providerId: string) => ({
  objective: "Add a toy greeting",
  acceptance: ["The greeting prints"],
  providerId,
});

describe("denied provider endpoints over MCP (#294)", () => {
  it("a cloud plan_decompose does not name the denied host", async () => {
    const engine = await deniedGateway();
    const text = await call(engine, "cloud", "plan_decompose", decompose("gw"));
    expect(text).toContain("Project policy denies this provider's endpoint");
    expect(text).not.toContain(HOST);
  });

  it("a cloud plan_create does not name the denied host", async () => {
    const engine = await deniedGateway();
    const text = await call(engine, "cloud", "plan_create", create("gw"));
    expect(text).toContain("Project policy denies this provider's endpoint");
    expect(text).not.toContain(HOST);
  });

  it("a local client still sees the denied host", async () => {
    const engine = await deniedGateway();
    expect(
      await call(engine, "local", "plan_decompose", decompose("gw")),
    ).toContain(`Project policy denies endpoint ${HOST}`);
    expect(await call(engine, "local", "plan_create", create("gw"))).toContain(
      `Project policy denies endpoint ${HOST}`,
    );
  });

  it("a provider the policy does not allow is refused as before, for both clients", async () => {
    const engine = await deniedGateway();
    for (const client of ["cloud", "local"] as const) {
      const text = await call(
        engine,
        client,
        "plan_decompose",
        decompose("off"),
      );
      expect(text).toContain("Project policy does not allow provider off");
      expect(text).not.toContain(HOST);
    }
  });

  it("rewrites every host form an endpoint denial can carry", () => {
    for (const host of [
      HOST,
      "10.0.0.7",
      "[::1]",
      "internal-gw",
      "_private.internal",
      "private_gateway.internal",
    ])
      expect(
        cloudErrorText(
          `Configured workers that cannot be used: gw: Project policy denies endpoint ${host}.`,
        ),
      ).toBe(
        "Configured workers that cannot be used: gw: Project policy denies this provider's endpoint (its host is not shown to cloud clients).",
      );
    expect(
      cloudErrorText(
        "Project policy denies endpoint private_gateway.internal: a chat provider needs an HTTPS endpoint on a host in policy.allowedHosts",
      ),
    ).toBe(
      "Project policy denies this provider's endpoint (its host is not shown to cloud clients): a chat provider needs an HTTPS endpoint on a host in policy.allowedHosts",
    );
    expect(cloudErrorText("Project policy denies endpoint [::1]")).toBe(
      "Project policy denies this provider's endpoint (its host is not shown to cloud clients)",
    );
    expect(cloudErrorText("Run cancelled")).toBe("Run cancelled");
  });
});
