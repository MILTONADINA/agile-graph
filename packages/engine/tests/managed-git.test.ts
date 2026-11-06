import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { managedGit } from "../src/execution/git.js";
import { checked } from "../src/util.js";

// Every command is still run for real; the mock only records the calls.
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util.js")>();
  mocks.command.mockImplementation(actual.command);
  return { ...actual, command: mocks.command };
});

const directories: string[] = [];
afterEach(async () => {
  mocks.command.mockClear();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("managedGit", () => {
  it("gives the filter-configuration probe the caller's cancellation and timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-managed-git-"));
    directories.push(root);
    await checked("git", ["init", "-q", "-b", "dev"], { cwd: root });
    const controller = new AbortController();
    mocks.command.mockClear();
    const result = await managedGit(root, ["status", "--porcelain"], {
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    const [probe, status] = mocks.command.mock.calls;
    expect(probe?.[1]).toContain("--get-regexp");
    expect(probe?.[2]).toMatchObject({ cwd: root, timeoutMs: 30_000 });
    expect(probe?.[2]?.signal).toBe(controller.signal);
    expect(status?.[2]).toMatchObject({ cwd: root, timeoutMs: 30_000 });
    expect(status?.[2]?.signal).toBe(controller.signal);
  });
});
