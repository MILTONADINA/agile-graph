import type { ProjectConfig, ProjectPolicy } from "@agile-graph/contracts";
import { command, checked, hash } from "../util.js";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gitFiles } from "./workspace.js";
import { isAllowedPath, safePath, wholeRepository } from "../policy.js";

export async function dockerAvailable(
  probe: typeof command = command,
): Promise<boolean> {
  for (const timeoutMs of [5_000, 15_000]) {
    try {
      if (
        (
          await probe("docker", ["info", "--format", "{{.ServerVersion}}"], {
            timeoutMs,
          })
        ).code === 0
      )
        return true;
    } catch {
      // The daemon can become ready after the first probe times out.
    }
  }
  return false;
}
/**
 * Reads a file from the verification view only when it is a regular file.
 * Check code can replace an input with a FIFO; opening one blocks until a
 * writer appears, and the container that could write has already exited.
 */
async function readRegularFile(file: string): Promise<Buffer> {
  // O_NOFOLLOW and O_NONBLOCK are not available on Windows, so the path is
  // checked first on every platform.
  if (!(await lstat(file)).isFile())
    throw new Error("Verification input is not a regular file");
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Verification input is not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export interface VerificationResult {
  /** Operator-assigned catalogue identity, absent for legacy unnamed checks. */
  checkId?: string;
  argv: string[];
  image: string;
  imageId?: string;
  code: number;
  stdout: string;
  stderr: string;
  snapshotHash: string;
}
/** A file added to the verification view only, never to the workspace. */
export interface AddedFile {
  path: string;
  content: string;
}
/**
 * Runs registered checks in the offline sandbox, each on its own temporary
 * view: a fresh copy of the workspace's allowed files. `options.added` writes new files into
 * that view only (the security audit's reproducer), so the workspace itself
 * is never written; an added path that already exists is refused.
 * `options.replaced` overwrites files the view already has, in the view
 * only; a replaced path the view lacks is refused.
 */
export async function verifyInContainer(
  workspace: string,
  checks: ProjectConfig["verification"],
  policy: ProjectPolicy,
  snapshotHash: string,
  signal?: AbortSignal,
  options: {
    added?: readonly AddedFile[];
    /** Existing files whose content the view replaces (mutation analysis). */
    replaced?: readonly AddedFile[];
  } = {},
): Promise<VerificationResult[]> {
  // A managed run can refresh the shared policy object while a check awaits.
  // Freeze this invocation's reviewed deadline before any filesystem/probe
  // await, so later checks cannot silently acquire a different timeout.
  const timeoutMs =
    policy.verificationTimeoutSeconds === null
      ? null
      : (policy.verificationTimeoutSeconds ?? policy.timeoutSeconds) * 1000;
  if (checks.length === 0)
    throw new Error(
      "No verification commands configured; acceptance cannot be established",
    );
  // Checks run on the whole repository, whatever the working set.
  policy = wholeRepository(policy);
  const results: VerificationResult[] = [];
  // Each check gets a fresh copy of the view, so a file an earlier check
  // writes (a planted config, a stub binary, a patched test) cannot change
  // what a later check runs against.
  const freshView = async () => {
    const view = await mkdtemp(
      path.join(path.dirname(workspace), "verification-"),
    );
    const inputs = new Map<string, string>();
    try {
      for (const relative of await gitFiles(workspace))
        if (isAllowedPath(relative, policy)) {
          try {
            const file = await safePath(workspace, relative, policy);
            const content = await readFile(file);
            const target = path.join(view, relative);
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(file, target);
            inputs.set(relative, hash(content.toString("base64")));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      for (const added of options.added ?? []) {
        if (inputs.has(added.path))
          throw new Error(
            `An added verification file already exists: ${added.path}`,
          );
        // safePath refuses a path outside the policy or through a symlink;
        // "wx" refuses a file that is already there.
        const target = await safePath(view, added.path, policy);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, added.content, { flag: "wx" });
        inputs.set(
          added.path,
          hash(Buffer.from(added.content).toString("base64")),
        );
      }
      for (const replaced of options.replaced ?? []) {
        if (!inputs.has(replaced.path))
          throw new Error(
            `A replaced verification file does not exist: ${replaced.path}`,
          );
        await writeFile(
          await safePath(view, replaced.path, policy),
          replaced.content,
        );
        inputs.set(
          replaced.path,
          hash(Buffer.from(replaced.content).toString("base64")),
        );
      }
    } catch (error) {
      await rm(view, { recursive: true, force: true });
      throw error;
    }
    return { view, inputs };
  };
  const views: string[] = [];
  try {
    for (const check of checks) {
      if (signal?.aborted) throw new Error("Run cancelled");
      const { view, inputs } = await freshView();
      views.push(view);
      const imageId = await checked(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", check.image],
        { timeoutMs: 10000, signal },
      );
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
        throw new Error(
          "Verification image must already be provisioned locally",
        );
      let failed = false;
      const name = `graph-check-${hash(`${workspace}:${Date.now()}:${check.argv.join(" ")}`).slice(0, 20)}`;
      const stop = () => {
        void command("docker", ["kill", name], { timeoutMs: 5000 }).catch(
          () => {},
        );
      };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const result = await command(
          "docker",
          [
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=256",
            "--memory=4g",
            "--cpus=2",
            // With all capabilities dropped, container root cannot traverse a
            // private (0700) bind mount owned by the Linux host user. Match the
            // owner instead of granting DAC_OVERRIDE or opening private files.
            ...(process.getuid && process.getgid
              ? ["--user", `${process.getuid()}:${process.getgid()}`]
              : []),
            "--mount",
            `type=bind,source=${view},target=/workspace`,
            "--workdir",
            "/workspace",
            "--env",
            "CI=true",
            "--env",
            "HOME=/tmp",
            imageId,
            ...check.argv,
          ],
          {
            signal,
            // Null is an explicit completion-driven choice, not a missing
            // value. Probes and cleanup above/below stay independently bounded.
            timeoutMs,
          },
        );
        results.push({
          ...result,
          ...(check.id !== undefined ? { checkId: check.id } : {}),
          argv: check.argv,
          image: check.image,
          imageId,
          snapshotHash,
        });
        failed = result.code !== 0;
      } finally {
        signal?.removeEventListener("abort", stop);
        await command("docker", ["rm", "-f", name], { timeoutMs: 5000 }).catch(
          () => {},
        );
      }
      for (const [relative, digest] of inputs) {
        try {
          const file = await safePath(view, relative, policy);
          if (hash((await readRegularFile(file)).toString("base64")) !== digest)
            throw new Error(`Verification modified source file ${relative}`);
        } catch {
          throw new Error(`Verification changed a source input: ${relative}`);
        }
      }
      await rm(view, { recursive: true, force: true });
      if (failed) break;
    }
    return results;
  } finally {
    for (const view of views) await rm(view, { recursive: true, force: true });
  }
}
