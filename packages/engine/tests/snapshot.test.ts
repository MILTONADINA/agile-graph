import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import { createWorkspaceSnapshot } from "../src/execution/snapshot.js";
import { gitFiles, workspaceFingerprint } from "../src/execution/workspace.js";
import { checked } from "../src/util.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "graph-snapshot-"));
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  await writeFile(path.join(workspace, "source.txt"), "original");
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "nested.txt"), "nested");
  return workspace;
}
const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

describe("workspace snapshot", () => {
  it("equals the fingerprint, keeps executable bits and lists its files through Git", async () => {
    const workspace = await fixture();
    await writeFile(path.join(workspace, "run.sh"), "#!/bin/sh\n");
    await chmod(path.join(workspace, "run.sh"), 0o755);
    const hash = await workspaceFingerprint(workspace, DEFAULT_POLICY);
    const snapshot = await createWorkspaceSnapshot(
      workspace,
      DEFAULT_POLICY,
      hash,
    );
    roots.push(snapshot.path);
    expect(await workspaceFingerprint(snapshot.path, DEFAULT_POLICY)).toBe(
      hash,
    );
    expect((await stat(path.join(snapshot.path, "run.sh"))).mode & 0o111).toBe(
      0o111,
    );
    expect(
      await readFile(path.join(snapshot.path, "src", "nested.txt"), "utf8"),
    ).toBe("nested");
    expect(await gitFiles(snapshot.path)).toEqual(await gitFiles(workspace));
    expect((await stat(snapshot.path)).mode & 0o777).toBe(0o700);
    await snapshot.dispose();
  });

  it("does not follow a symlink out of the workspace", async () => {
    const workspace = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "graph-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(workspace, "link.txt"),
    );
    // The fingerprint refuses such a link, so the snapshot refuses it too and
    // never copies the target.
    const before = new Set(await readdir(os.tmpdir()));
    await expect(
      createWorkspaceSnapshot(workspace, DEFAULT_POLICY, "any"),
    ).rejects.toThrow(/Symlink is outside managed file scope/);
    const created = (await readdir(os.tmpdir())).filter(
      (name) => name.startsWith("agile-graph-snapshot-") && !before.has(name),
    );
    expect(created).toEqual([]);
  });

  it("omits a file the policy denies", async () => {
    const workspace = await fixture();
    await writeFile(path.join(workspace, ".env"), "TOKEN=x");
    const hash = await workspaceFingerprint(workspace, DEFAULT_POLICY);
    const snapshot = await createWorkspaceSnapshot(
      workspace,
      DEFAULT_POLICY,
      hash,
    );
    roots.push(snapshot.path);
    expect(await exists(path.join(snapshot.path, ".env"))).toBe(false);
    expect(await exists(path.join(snapshot.path, "source.txt"))).toBe(true);
    await snapshot.dispose();
  });

  it("includes a tracked file that .gitignore matches and lists it through Git", async () => {
    const workspace = await fixture();
    await writeFile(path.join(workspace, ".gitignore"), "kept.log\n");
    await writeFile(path.join(workspace, "kept.log"), "tracked anyway");
    await checked("git", ["add", "-f", "kept.log", ".gitignore"], {
      cwd: workspace,
    });
    const hash = await workspaceFingerprint(workspace, DEFAULT_POLICY);
    const snapshot = await createWorkspaceSnapshot(
      workspace,
      DEFAULT_POLICY,
      hash,
    );
    roots.push(snapshot.path);
    expect(await readFile(path.join(snapshot.path, "kept.log"), "utf8")).toBe(
      "tracked anyway",
    );
    expect(await gitFiles(snapshot.path)).toContain("kept.log");
    await snapshot.dispose();
  });

  it("removes its directory on dispose and disposes again without error", async () => {
    const workspace = await fixture();
    const hash = await workspaceFingerprint(workspace, DEFAULT_POLICY);
    const snapshot = await createWorkspaceSnapshot(
      workspace,
      DEFAULT_POLICY,
      hash,
    );
    expect(await exists(snapshot.path)).toBe(true);
    await snapshot.dispose();
    expect(await exists(snapshot.path)).toBe(false);
    await expect(snapshot.dispose()).resolves.toBeUndefined();
  });

  it("throws on a hash mismatch and leaves no directory behind", async () => {
    const workspace = await fixture();
    const before = new Set(await readdir(os.tmpdir()));
    await expect(
      createWorkspaceSnapshot(workspace, DEFAULT_POLICY, "not-the-hash"),
    ).rejects.toThrow(/hash mismatch/);
    const created = (await readdir(os.tmpdir())).filter(
      (name) => name.startsWith("agile-graph-snapshot-") && !before.has(name),
    );
    expect(created).toEqual([]);
  });
});
