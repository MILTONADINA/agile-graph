import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { readMcpCalls, RunStore } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

it("adds the tool definition hash column to an existing call log in place and reads entries logged before it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graph-mcp-def-"));
  directories.push(dir);
  const projectId = "toy-project-1";
  // A version-5 call log written before def_sha256 existed.
  const legacy = new Database(join(dir, "runs.sqlite"));
  legacy.exec(
    "CREATE TABLE mcp_calls(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL,at TEXT NOT NULL,tool TEXT NOT NULL,client_kind TEXT NOT NULL,args_sha256 TEXT NOT NULL,outcome TEXT,plan_id TEXT,run_id TEXT); PRAGMA user_version=5;",
  );
  legacy
    .prepare(
      "INSERT INTO mcp_calls(id,project_id,at,tool,client_kind,args_sha256,outcome) VALUES('old',?,'2026-01-01T00:00:00Z','context_get','local',?, 'ok')",
    )
    .run(projectId, "a".repeat(64));
  legacy.close();
  const [old] = readMcpCalls(dir, projectId, { limit: 10 });
  expect(old).toMatchObject({ id: "old", tool: "context_get" });
  expect(old).not.toHaveProperty("definitionSha256");
  const store = new RunStore(dir, projectId);
  try {
    expect(store.schemaVersion).toBe(5);
    store.beginMcpCall({
      tool: "symbol_search",
      clientKind: "cloud",
      argsSha256: "b".repeat(64),
      definitionSha256: "c".repeat(64),
    });
    const [latest, earlier] = store.mcpCalls({ limit: 10 });
    expect(latest).toMatchObject({
      tool: "symbol_search",
      definitionSha256: "c".repeat(64),
    });
    expect(earlier).not.toHaveProperty("definitionSha256");
  } finally {
    store.close();
  }
  expect(readMcpCalls(dir, projectId, { limit: 1 })[0]).toMatchObject({
    definitionSha256: "c".repeat(64),
  });
});
