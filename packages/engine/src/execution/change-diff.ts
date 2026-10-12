import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectPolicy, RunEvent } from "@agile-graph/contracts";
import { safePath } from "../policy.js";
import { command } from "../util.js";
import { checkpointPaths, type DagCheckpoint } from "./dag.js";
import { gitBlob } from "./git.js";

/**
 * Every file a run's workers wrote: patches, cached solutions and the DAG's
 * steps and repairs, including one an acknowledged resume recorded as
 * applied. A single-step or cached patch counts from the moment it is
 * recorded as applying, before its first write, so one the process died
 * during, or whose rollback failed, is still the run's: each of its files
 * still in the workspace (one it never reached, or one the rollback removed,
 * has nothing to review or publish). A patch whose rollback restored the
 * workspace wrote nothing. The operator's own uncommitted files in the
 * workspace are not the worker's change.
 */
export async function runWrittenPaths(
  events: readonly RunEvent[],
  workspace: string,
  dagCheckpoint?: DagCheckpoint,
): Promise<string[]> {
  const inventory = (event: RunEvent) => {
    const paths = event.data.paths;
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== "string"))
      throw new Error(
        "Retained patch lacks its verification path inventory; explicit source review is required before reuse",
      );
    return paths as string[];
  };
  const rolledBack = new Set(
    events
      .filter((event) => event.type === "patch.rolled_back")
      .map((event) => event.data.applying),
  );
  const inWorkspace = async (file: string) => {
    try {
      await stat(path.join(workspace, file));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (["ENOENT", "ENOTDIR"].includes(code)) return false;
      throw error;
    }
  };
  const applying: string[] = [];
  for (const event of events)
    if (event.type === "patch.applying" && !rolledBack.has(event.id))
      for (const file of inventory(event))
        if (await inWorkspace(file)) applying.push(file);
  return [
    ...new Set([
      ...events
        .filter((event) =>
          [
            "patch.applied",
            "dag.step.completed",
            "solution.cache_hit",
          ].includes(event.type),
        )
        .flatMap(inventory),
      ...applying,
      ...(dagCheckpoint ? checkpointPaths(dagCheckpoint) : []),
    ]),
  ];
}

/**
 * A unified diff of `files` between `baseCommit` and the workspace, for a
 * reviewer. Diffs raw bytes outside the repository: the original from the
 * object store with no conversion, the new file from disk. Neither the
 * change's .gitattributes (-diff, working-tree-encoding, ident, eol) nor any
 * diff driver or configuration can alter what the reviewer sees.
 */
export async function changeDiff(options: {
  workspace: string;
  baseCommit: string;
  files: readonly string[];
  policy: ProjectPolicy;
  signal?: AbortSignal;
}): Promise<string> {
  const { workspace, baseCommit, files, policy, signal } = options;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "graph-review-"));
  const parts: string[] = [];
  try {
    // Empty stand-ins for Git configuration, attributes and absent files:
    // null device names differ across platforms.
    const empty = path.join(scratch, "empty");
    await writeFile(empty, "");
    await mkdir(path.join(scratch, "a"));
    await mkdir(path.join(scratch, "b"));
    for (const [index, file] of files.entries()) {
      const before = `a/${index}`;
      const after = `b/${index}`;
      const original = await gitBlob(workspace, baseCommit, file, {
        signal,
      });
      await writeFile(path.join(scratch, before), original ?? "");
      const current = await safePath(workspace, file, policy);
      const exists = await stat(current).then(
        () => true,
        () => false,
      );
      if (exists) await copyFile(current, path.join(scratch, after));
      else await writeFile(path.join(scratch, after), "");
      const result = await command(
        "git",
        [
          "-c",
          "core.attributesFile=empty",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--text",
          "--no-color",
          `--src-prefix=a/${file}#`,
          `--dst-prefix=b/${file}#`,
          "--",
          before,
          after,
        ],
        {
          cwd: scratch,
          signal,
          timeoutMs: 60000,
          maxBytes: 20_000_000,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: empty,
          },
        },
      );
      // --no-index exits 0 for identical files and 1 when they differ.
      if (result.code !== 0 && result.code !== 1)
        throw new Error(
          `git could not show the change to ${file}: ${result.stderr.trim().slice(0, 500)}`,
        );
      const status =
        original === undefined ? " (new file)" : exists ? "" : " (deleted)";
      parts.push(`File ${file}${status}:\n${result.stdout}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return parts.join("\n");
}
