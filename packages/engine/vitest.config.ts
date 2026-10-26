import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests that open a project without choosing a data folder would otherwise
// write under the user's real data directory (issue #176). Each run gets its
// own temporary folder, removed by tests/global-data-dir.ts; a folder the
// caller already chose is kept. Ownership is recorded in this process only,
// never in an environment variable a nested run could inherit.
if (!process.env.GRAPH_ENGINE_DATA_DIR) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "graph-engine-tests-"));
  process.env.GRAPH_ENGINE_DATA_DIR = dataDir;
  (globalThis as Record<symbol, unknown>)[
    Symbol.for("agile-graph.ownedTestDataDir")
  ] = dataDir;
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: { GRAPH_ENGINE_DATA_DIR: process.env.GRAPH_ENGINE_DATA_DIR },
    globalSetup: ["tests/global-data-dir.ts"],
    // Windows CI runners spawn processes and Git markedly slower: in the
    // round-000 retro, 3 of the 11 CI runs with a failed platform job hit
    // the 30 s limit on Windows only, 2 of them with no other failure. A
    // test's own explicit limit still applies.
    testTimeout: process.platform === "win32" ? 60000 : 30000,
    hookTimeout: process.platform === "win32" ? 60000 : 30000,
    coverage: {
      // Off unless CI asks for it on one matrix entry, so the floor check
      // reads the report of the test run that job already makes.
      enabled: process.env.GRAPH_ENGINE_COVERAGE === "1",
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
