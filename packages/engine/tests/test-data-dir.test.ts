import { it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";
import { projectDataDir } from "../src/project.js";
import { teardown } from "./global-data-dir.js";

it("keeps every test's project data out of the user's data directory", () => {
  const userDirs = ["agile-graph", "graph-engineering"].map((name) =>
    path.resolve(envPaths(name, { suffix: "" }).data),
  );
  expect(process.env.GRAPH_ENGINE_DATA_DIR).toBeTruthy();
  const dataDir = path.resolve(projectDataDir("test-data-dir-guard"));
  for (const userData of userDirs)
    expect(dataDir.startsWith(userData + path.sep)).toBe(false);
});

it("never removes a data folder this run did not create", async () => {
  const chosen = await mkdtemp(path.join(os.tmpdir(), "graph-engine-chosen-"));
  try {
    vi.stubEnv("GRAPH_ENGINE_DATA_DIR", chosen);
    vi.stubEnv("GRAPH_ENGINE_TEST_OWNED_DATA_DIR", chosen);
    await teardown();
    expect(existsSync(chosen)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await rm(chosen, { recursive: true, force: true });
  }
});
