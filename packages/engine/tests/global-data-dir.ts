import { rm } from "node:fs/promises";

/**
 * Removes the per-run data folder vitest.config.ts created in this process.
 * A folder the caller chose, or one an outer run created, is never removed.
 */
export async function teardown(): Promise<void> {
  const owned = (globalThis as Record<symbol, unknown>)[
    Symbol.for("agile-graph.ownedTestDataDir")
  ];
  if (typeof owned === "string" && owned === process.env.GRAPH_ENGINE_DATA_DIR)
    await rm(owned, { recursive: true, force: true });
}
