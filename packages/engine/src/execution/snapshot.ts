import type { ProjectPolicy } from "@agile-graph/contracts";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { isAllowedPath, safePath, wholeRepository } from "../policy.js";
import { managedGit } from "./git.js";
import { gitFiles, workspaceFingerprint } from "./workspace.js";

/** The copy no longer matches the hash it was taken for: the workspace changed. */
export class SnapshotMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotMismatchError";
  }
}
// Snapshots sit beside the run workspace, not in the system temp folder: the
// container views for generators and checks are made in the same parent, and
// VM-backed Docker shares only the home folder.
const snapshotPrefix = (workspace: string) =>
  `${path.basename(workspace)}-snapshot-`;
/**
 * Removes snapshots of this workspace an earlier crash left behind: only
 * real directories (never a symlink or file) with this workspace's prefix.
 */
export async function removeStaleSnapshots(workspace: string): Promise<void> {
  const parent = path.dirname(workspace),
    prefix = snapshotPrefix(workspace);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const target = path.join(parent, name);
    try {
      if ((await lstat(target)).isDirectory())
        await rm(target, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** A private copy of exactly the regular files included in the fingerprint. */
export async function createWorkspaceSnapshot(
  workspace: string,
  policy: ProjectPolicy,
  expectedHash: string,
): Promise<{ path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(
    path.join(path.dirname(workspace), snapshotPrefix(workspace)),
  );
  const dispose = async () => {
    await rm(root, { recursive: true, force: true });
  };
  try {
    await chmod(root, 0o700);
    const whole = wholeRepository(policy);
    const copied: string[] = [];
    for (const relative of await gitFiles(workspace)) {
      if (!isAllowedPath(relative, whole)) continue;
      try {
        const source = await safePath(workspace, relative, whole);
        const info = await stat(source);
        if (!info.isFile()) continue;
        const target = path.join(root, relative);
        await mkdir(path.dirname(target), { recursive: true });
        // FICLONE is advisory: Node falls back to copying when unsupported.
        await copyFile(source, target, constants.COPYFILE_FICLONE);
        await chmod(target, 0o600 | (info.mode & 0o111));
        copied.push(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // No hooks, and no global or system configuration of the operator's.
    // The global file is a path that never exists (Git ignores a missing
    // one); the null device is refused as a config file on Windows.
    const env = {
      GIT_CONFIG_GLOBAL: path.join(root, ".git", "no-global-config"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const init = await managedGit(root, ["init", "-q"], { env });
    if (init.code !== 0)
      throw new Error(`Snapshot git init failed: ${init.stderr.trim()}`);
    if (copied.length) {
      const added = await managedGit(
        root,
        [
          "--literal-pathspecs",
          "add",
          "-f",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { input: copied.join("\0") + "\0", env },
      );
      if (added.code !== 0)
        throw new Error(`Snapshot git add failed: ${added.stderr}`);
    }
    const actual = await workspaceFingerprint(root, policy);
    if (actual !== expectedHash)
      throw new SnapshotMismatchError(
        `Workspace snapshot hash mismatch: expected ${expectedHash}, got ${actual}`,
      );
    return { path: root, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
