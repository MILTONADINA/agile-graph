// The per-user data directory that holds the owner's promotion files outside
// every project: the owner's public keys (`promotion-keys/`), the prepared
// trust anchor, the local enrollment record (`promotion-enrollment/`) and the
// Rekor high-water state (`rekor-witness/`, see promotion-rekor-witness.ts).
// Project data dirs are `<this>/projects/<id>`, and backups copy only named
// files from a project data dir, so nothing here is ever backed up, restored
// or indexed for an MCP client.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR_NAME = "agile-graph";
// Stable identifier from before the Agile Graph rename; do not change.
export const LEGACY_DATA_DIR_NAME = "graph-engineering";

/**
 * The new data folder unless only the legacy one exists, so an install that
 * predates the rename keeps its data. Nothing is moved, copied or deleted.
 */
export function pickDataDir(
  current: string,
  legacy: string,
  exists: (dir: string) => boolean = existsSync,
): string {
  return exists(current) || !exists(legacy) ? current : legacy;
}

function userDataBase(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support");
  return env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, ".local", "share");
}

/** `~/Library/Application Support/agile-graph` on macOS, XDG elsewhere (or the legacy `graph-engineering` folder when only that exists). */
export function promotionUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  exists: (dir: string) => boolean = existsSync,
): string {
  const base = userDataBase(platform, env, home);
  return pickDataDir(
    path.join(base, DATA_DIR_NAME),
    path.join(base, LEGACY_DATA_DIR_NAME),
    exists,
  );
}

/** Where the owner's key tool keeps `<role>.pub.pem` unless told otherwise. */
export const OWNER_KEY_DIR_NAME = "promotion-keys";
/** The local enrollment record's directory (0700) and file (0600). */
export const ENROLLMENT_DIR_NAME = "promotion-enrollment";
export const ENROLLMENT_FILE_NAME = "enrollment.json";
/** Where `anchor-prepare` writes unless given `--out`. */
export const PREPARED_ANCHOR_FILE_NAME = "promotion-trust-anchor.prepared.json";
