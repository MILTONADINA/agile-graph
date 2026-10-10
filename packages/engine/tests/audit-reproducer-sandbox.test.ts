import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { verifyInContainer } from "../src/execution/docker.js";
import * as util from "../src/util.js";

// The offline sandbox an audit reproducer runs in: verifyInContainer with a
// file added to its temporary view only. Docker itself is faked.
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const viewOf = (argv: string[]) =>
  argv[argv.indexOf("--mount") + 1]!.slice(
    "type=bind,source=".length,
    -",target=/workspace".length,
  );

async function fixture(onRun: (argv: string[]) => Promise<util.CommandResult>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-reproducer-"));
  roots.push(root);
  await util.checked("git", ["init", "-b", "dev"], { cwd: root });
  await writeFile(path.join(root, "toy.js"), "export const value = 1;\n");
  const actualChecked = util.checked;
  const actualCommand = util.command;
  const runs: string[][] = [];
  vi.spyOn(util, "checked").mockImplementation(
    async (executable, argv, options) =>
      executable === "docker"
        ? `sha256:${"a".repeat(64)}`
        : actualChecked(executable, argv, options),
  );
  vi.spyOn(util, "command").mockImplementation(
    async (executable, argv, options) => {
      if (executable !== "docker")
        return actualCommand(executable, argv, options);
      if (argv[0] !== "run") return { code: 0, stdout: "", stderr: "" };
      runs.push(argv);
      return onRun(argv);
    },
  );
  return { root, runs };
}

describe("audit reproducer sandbox", () => {
  it("adds a reproducer only to the temporary verification view and runs it with no network", async () => {
    const content = "import { value } from './toy.js';\n";
    let inView: string | undefined;
    let copied: string | undefined;
    const { root, runs } = await fixture(async (argv) => {
      const view = viewOf(argv);
      inView = await readFile(path.join(view, "toy.test.js"), "utf8");
      copied = await readFile(path.join(view, "toy.js"), "utf8");
      return { code: 1, stdout: "not ok", stderr: "" };
    });
    const results = await verifyInContainer(
      root,
      [{ image: "toy-verify", argv: ["node", "--test", "toy.test.js"] }],
      DEFAULT_POLICY,
      "snapshot",
      undefined,
      { added: [{ path: "toy.test.js", content }] },
    );
    expect(inView).toBe(content);
    expect(copied).toBe("export const value = 1;\n");
    expect(results).toMatchObject([
      {
        code: 1,
        imageId: `sha256:${"a".repeat(64)}`,
        snapshotHash: "snapshot",
      },
    ]);
    const [argv] = runs as [string[]];
    for (const flag of [
      "--network=none",
      "--cap-drop=ALL",
      "--pull=never",
      "--security-opt=no-new-privileges",
    ])
      expect(argv).toContain(flag);
    expect(argv.slice(-3)).toEqual(["node", "--test", "toy.test.js"]);
    // The view is temporary and outside the workspace, which never sees the
    // reproducer.
    const view = viewOf(argv);
    expect(path.relative(root, view).startsWith("..")).toBe(true);
    expect(await exists(view)).toBe(false);
    expect(await exists(path.join(root, "toy.test.js"))).toBe(false);
  });

  it("refuses an added file that already exists or leaves the view", async () => {
    const { root, runs } = await fixture(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const check = [{ image: "toy-verify", argv: ["node", "--test"] }];
    await expect(
      verifyInContainer(root, check, DEFAULT_POLICY, "s", undefined, {
        added: [{ path: "toy.js", content: "replaced" }],
      }),
    ).rejects.toThrow("already exists");
    for (const outside of ["../escape.test.js", "/tmp/escape.test.js"])
      await expect(
        verifyInContainer(root, check, DEFAULT_POLICY, "s", undefined, {
          added: [{ path: outside, content: "x" }],
        }),
      ).rejects.toThrow("outside allowed project scope");
    expect(runs).toEqual([]);
    expect(await readFile(path.join(root, "toy.js"), "utf8")).toBe(
      "export const value = 1;\n",
    );
    // A reproducer that rewrites its own file in the view is refused too.
    vi.restoreAllMocks();
    const changing = await fixture(async (argv) => {
      await writeFile(path.join(viewOf(argv), "toy.test.js"), "changed");
      return { code: 1, stdout: "", stderr: "" };
    });
    await expect(
      verifyInContainer(changing.root, check, DEFAULT_POLICY, "s", undefined, {
        added: [{ path: "toy.test.js", content: "original" }],
      }),
    ).rejects.toThrow("Verification changed a source input: toy.test.js");
  });
});
