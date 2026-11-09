import type { ProjectPolicy } from "@agile-graph/contracts";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAllowedPath, safePath, wholeRepository } from "../policy.js";
import { checkedGit, managedGit } from "./git.js";
import { gitFiles, workspaceFingerprint } from "./workspace.js";

/** A private copy of exactly the regular files included in the fingerprint. */
export async function createWorkspaceSnapshot(
  workspace: string,
  policy: ProjectPolicy,
  expectedHash: string,
): Promise<{ path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agile-graph-snapshot-"));
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
    await checkedGit(root, ["init", "-q"]);
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
        { input: copied.join("\0") + "\0" },
      );
      if (added.code !== 0)
        throw new Error(`Snapshot git add failed: ${added.stderr}`);
    }
    const actual = await workspaceFingerprint(root, policy);
    if (actual !== expectedHash)
      throw new Error(
        `Workspace snapshot hash mismatch: expected ${expectedHash}, got ${actual}`,
      );
    return { path: root, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
