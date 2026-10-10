import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENT_CONFIG_OWASP_MCP,
  agentConfigFindings,
  tokenPassthrough,
} from "../src/security/agent-config.js";
import { withFingerprints } from "../src/security/scan.js";
import { toSarif } from "../src/security/sarif.js";

const files = (entries: Record<string, string>) =>
  new Map(
    Object.entries(entries).map(([file, text]) => [file, text.split("\n")]),
  );
const scan = (entries: Record<string, string>) =>
  agentConfigFindings(files(entries));
const json = (value: unknown) => JSON.stringify(value, null, 2);
// Synthetic values a finding must never repeat.
const SECRET = "toy-secret-value-123";

describe("agent-config OWASP MCP Top 10 tags", () => {
  it("tags every agent-config finding with its rule's OWASP MCP Top 10 IDs and carries them into SARIF results and rules", () => {
    const entries = {
      ".mcp.json": json({
        mcpServers: { toy: { command: "toy-server", args: ["--x"] } },
      }),
      ".claude/settings.json": json({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "toy-hook" }] }],
        },
      }),
    };
    const result = scan(entries);
    expect(result.findings.length).toBeGreaterThan(1);
    for (const found of result.findings) {
      expect(found.tags).toEqual(AGENT_CONFIG_OWASP_MCP[found.rule]);
      for (const tag of found.tags!)
        expect(tag).toMatch(/^MCP(0[1-9]|10):2025$/);
    }
    const lines = files(entries);
    const sarif = toSarif(
      withFingerprints(result.findings, (file) => lines.get(file)),
      "0.1.0",
    );
    const run = sarif.runs[0]!;
    const server = run.results.find(
      (r) => r.ruleId === "agent-config/mcp-server",
    )!;
    expect(server.properties.tags).toEqual(["MCP04:2025", "MCP09:2025"]);
    expect(
      run.tool.driver.rules.find((r) => r.id === "agent-config/hook-command")
        ?.properties?.tags,
    ).toEqual(["MCP05:2025"]);
  });

  it("maps every agent-config rule in docs/mcp-security-coverage.md, with every OWASP MCP ID listed", () => {
    const doc = readFileSync(
      new URL("../../../docs/mcp-security-coverage.md", import.meta.url),
      "utf8",
    );
    for (const rule of Object.keys(AGENT_CONFIG_OWASP_MCP))
      expect(doc).toContain(`\`${rule}\``);
    for (let n = 1; n <= 10; n++)
      expect(doc).toContain(`MCP${String(n).padStart(2, "0")}`);
  });
});

describe("agent-config token passthrough", () => {
  it("flags a server forwarding an inbound authorization header, passthrough setting or flag, naming no value", () => {
    const result = scan({
      ".mcp.json": json({
        mcpServers: {
          header: {
            type: "http",
            url: `https://downstream.example.invalid/mcp?k=${SECRET}`,
            headers: { Authorization: "Bearer ${INBOUND_TOKEN}" },
          },
          vscodeStyle: {
            url: "https://other.example.invalid/mcp",
            headers: { "X-Auth": "${env:HTTP_AUTHORIZATION}" },
          },
          setting: {
            command: "toy-proxy",
            forwardAuthorization: true,
          },
          flag: {
            command: "toy-proxy",
            args: ["--pass-through-auth", `--token=${SECRET}`],
          },
        },
      }),
    });
    const found = result.findings.filter((f) => f.rule === "token-passthrough");
    expect(found.map((f) => f.resource).sort()).toEqual([
      "mcpServers.flag",
      "mcpServers.header",
      "mcpServers.setting",
      "mcpServers.vscodeStyle",
    ]);
    for (const f of found) {
      expect(f.message).not.toContain(SECRET);
      expect(f.message).not.toContain("Bearer");
      expect(f.tags).toEqual(["MCP01:2025", "MCP07:2025"]);
    }
    expect(
      found.find((f) => f.resource === "mcpServers.header")?.message,
    ).toContain("downstream.example.invalid");
    // The ordinary per-server finding stays beside it.
    expect(result.findings.filter((f) => f.rule === "mcp-server")).toHaveLength(
      4,
    );
  });

  it("stays quiet on a server using its own key or an unrelated variable", () => {
    expect(
      tokenPassthrough({
        url: "https://api.example.invalid/mcp",
        headers: { Authorization: "Bearer ${TOY_SERVICE_API_KEY}" },
        env: { TOY_HOME: "${HOME}" },
      }),
    ).toBeUndefined();
    expect(
      tokenPassthrough({ command: "toy", args: ["--forward-port=1"] }),
    ).toBeUndefined();
    expect(
      tokenPassthrough({ command: "toy", forwardAuthorization: false }),
    ).toBeUndefined();
  });

  it("flags a passthrough flag in a Codex config.toml server's args", () => {
    const result = scan({
      ".codex/config.toml": [
        "[mcp_servers.toy]",
        'command = "toy-proxy"',
        'args = ["--forward-token", "--port=1"]',
      ].join("\n"),
    });
    expect(
      result.findings.filter((f) => f.rule === "token-passthrough"),
    ).toHaveLength(1);
  });
});
