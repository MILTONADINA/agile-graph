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
import {
  createWorkspaceSnapshot,
  removeStaleSnapshots,
  SnapshotMismatchError,
} from "../src/execution/snapshot.js";
import { gitFiles, workspaceFingerprint } from "../src/execution/workspace.js";
import { checked } from "../src/util.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  // A per-test parent, since snapshots are created beside the workspace.
  const parent = await mkdtemp(path.join(os.tmpdir(), "graph-snapshot-"));
  roots.push(parent);
  const workspace = path.join(parent, "ws");
  await mkdir(workspace);
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
    // Windows has no POSIX mode bits to keep.
    if (process.platform !== "win32")
      expect(
        (await stat(path.join(snapshot.path, "run.sh"))).mode & 0o111,
      ).toBe(0o111);
    expect(
      await readFile(path.join(snapshot.path, "src", "nested.txt"), "utf8"),
    ).toBe("nested");
    expect(await gitFiles(snapshot.path)).toEqual(await gitFiles(workspace));
    if (process.platform !== "win32")
      expect((await stat(snapshot.path)).mode & 0o777).toBe(0o700);
    // Beside the workspace, where container views are made, not in tmp.
    expect(path.dirname(snapshot.path)).toBe(path.dirname(workspace));
    expect(path.basename(snapshot.path)).toMatch(/^ws-snapshot-/);
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
    const before = new Set(await readdir(path.dirname(workspace)));
    await expect(
      createWorkspaceSnapshot(workspace, DEFAULT_POLICY, "any"),
    ).rejects.toThrow(/Symlink is outside managed file scope/);
    const created = (await readdir(path.dirname(workspace))).filter(
      (name) => !before.has(name),
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
    const before = new Set(await readdir(path.dirname(workspace)));
    await expect(
      createWorkspaceSnapshot(workspace, DEFAULT_POLICY, "not-the-hash"),
    ).rejects.toBeInstanceOf(SnapshotMismatchError);
    const created = (await readdir(path.dirname(workspace))).filter(
      (name) => !before.has(name),
    );
    expect(created).toEqual([]);
  });

  it("removes only this workspace's leftover snapshot directories, never following a symlink", async () => {
    const workspace = await fixture();
    const parent = path.dirname(workspace);
    const outside = await mkdtemp(path.join(os.tmpdir(), "graph-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    await mkdir(path.join(parent, "ws-snapshot-old1"));
    await writeFile(path.join(parent, "ws-snapshot-old1", "f"), "x");
    await mkdir(path.join(parent, "other-snapshot-old2"));
    await mkdir(path.join(parent, "ws2"));
    await writeFile(path.join(parent, "ws-snapshot-file"), "not a dir");
    await symlink(outside, path.join(parent, "ws-snapshot-link"));
    expect(await removeStaleSnapshots(workspace)).toBe(0);
    expect(await exists(path.join(parent, "ws-snapshot-old1"))).toBe(false);
    expect(await exists(path.join(parent, "other-snapshot-old2"))).toBe(true);
    expect(await exists(path.join(parent, "ws2"))).toBe(true);
    expect(await exists(path.join(parent, "ws-snapshot-file"))).toBe(true);
    expect(await exists(path.join(parent, "ws-snapshot-link"))).toBe(true);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await exists(workspace)).toBe(true);
  });

  it("never touches a repository GIT_DIR points at", async () => {
    const workspace = await fixture();
    const decoy = await mkdtemp(path.join(os.tmpdir(), "graph-decoy-"));
    roots.push(decoy);
    await checked("git", ["init", "-q", "--bare"], { cwd: decoy });
    const listing = async () => (await readdir(decoy)).sort();
    const before = await listing();
    const hash = await workspaceFingerprint(workspace, DEFAULT_POLICY);
    const saved = {
      dir: process.env.GIT_DIR,
      tree: process.env.GIT_WORK_TREE,
      index: process.env.GIT_INDEX_FILE,
    };
    process.env.GIT_DIR = decoy;
    process.env.GIT_WORK_TREE = workspace;
    process.env.GIT_INDEX_FILE = path.join(decoy, "decoy-index");
    try {
      const snapshot = await createWorkspaceSnapshot(
        workspace,
        DEFAULT_POLICY,
        hash,
      );
      expect(await exists(path.join(snapshot.path, ".git"))).toBe(true);
      expect(await gitFiles(snapshot.path)).toEqual([
        "source.txt",
        "src/nested.txt",
      ]);
      await snapshot.dispose();
    } finally {
      for (const [name, value] of [
        ["GIT_DIR", saved.dir],
        ["GIT_WORK_TREE", saved.tree],
        ["GIT_INDEX_FILE", saved.index],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    expect(await listing()).toEqual(before);
    expect(await exists(path.join(decoy, "decoy-index"))).toBe(false);
    expect(await exists(path.join(decoy, "index"))).toBe(false);
  });
});
