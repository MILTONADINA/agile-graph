// The per-user data folder names, shared by the scripts that read the engine's
// private data. Mirrors packages/engine/src/promotion-local-paths.ts.
import { existsSync } from "node:fs";
import path from "node:path";
import envPaths from "env-paths";

export const DATA_DIR_NAME = "agile-graph";
// Stable identifier from before the Agile Graph rename; do not change.
export const LEGACY_DATA_DIR_NAME = "graph-engineering";

/** The new folder unless only the legacy one exists. Nothing is moved. */
export function pickDataDir(current, legacy, exists = existsSync) {
  return exists(current) || !exists(legacy) ? current : legacy;
}

/** The per-user data folder for a platform (the legacy one if only it exists). */
export function userDataDir(platform, env, home, exists = existsSync) {
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : path.join(home, ".local", "share");
  return pickDataDir(
    path.join(base, DATA_DIR_NAME),
    path.join(base, LEGACY_DATA_DIR_NAME),
    exists,
  );
}

/** The engine's data root through env-paths, as the engine itself resolves it. */
export function engineDataDirFromEnvPaths() {
  return pickDataDir(
    envPaths(DATA_DIR_NAME, { suffix: "" }).data,
    envPaths(LEGACY_DATA_DIR_NAME, { suffix: "" }).data,
  );
}
