import { afterEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { verifyInContainer } from "../src/execution/docker.js";
import { checked } from "../src/util.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("verification inputs", () => {
  it.skipIf(process.platform === "win32")(
    "fails a check that swaps a verification input for a FIFO instead of waiting on it",
    { timeout: 20_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "graph-verify-fifo-"));
      directories.push(directory);
      const root = join(directory, "repo");
      await mkdir(join(root, "src"), { recursive: true });
      await checked("git", ["init", "-b", "dev"], { cwd: root });
      await writeFile(join(root, "src/index.ts"), "export const a = 1;\n");
      const bin = join(directory, "bin");
      await mkdir(bin);
      const viewFile = join(directory, "view.txt");
      // A stand-in for Docker whose check replaces an input with a FIFO in
      // the mounted view, as hostile check code running as the host user can.
      await writeFile(
        join(bin, "docker"),
        [
          "#!/bin/sh",
          'case "$1" in',
          `  image) echo sha256:${"a".repeat(64)} ;;`,
          '  run) for arg in "$@"; do case "$arg" in type=bind,source=*) source="${arg#type=bind,source=}"; source="${source%%,target=*}" ;; esac; done',
          '       printf %s "$source" > "$GRAPH_FAKE_DOCKER_VIEW"',
          '       rm "$source/src/index.ts" && mkfifo "$source/src/index.ts" ;;',
          "esac",
          "exit 0",
          "",
        ].join("\n"),
      );
      await chmod(join(bin, "docker"), 0o755);
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      vi.stubEnv("GRAPH_FAKE_DOCKER_VIEW", viewFile);
      const verification = verifyInContainer(
        root,
        [{ image: "fixture", argv: ["npm", "test"] }],
        structuredClone(DEFAULT_POLICY),
        "snapshot",
      );
      const outcome = await Promise.race([
        verification.then(
          () => "passed",
          (error: Error) => error.message,
        ),
        new Promise<string>((resolve) =>
          setTimeout(resolve, 3_000, "still waiting on the FIFO"),
        ),
      ]);
      if (outcome === "still waiting on the FIFO") {
        // Release the engine's blocked read so the test can finish: a
        // non-blocking writer can open a FIFO that has a reader waiting.
        const view = await readFile(viewFile, "utf8");
        const writer = await open(
          join(view, "src/index.ts"),
          constants.O_WRONLY | constants.O_NONBLOCK,
        ).catch(() => undefined);
        await writer?.close();
        await verification.catch(() => {});
      }
      expect(outcome).toBe("Verification changed a source input: src/index.ts");
    },
  );
});

describe("verification views", () => {
  it.skipIf(process.platform === "win32")(
    "gives each check a fresh view so an earlier check cannot plant a file a later check sees",
    { timeout: 20_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "graph-verify-plant-"));
      directories.push(directory);
      const root = join(directory, "repo");
      await mkdir(join(root, "src"), { recursive: true });
      await checked("git", ["init", "-b", "dev"], { cwd: root });
      await writeFile(join(root, "src/index.ts"), "export const a = 1;\n");
      await checked("git", ["add", "src/index.ts"], { cwd: root });
      const bin = join(directory, "bin");
      await mkdir(bin);
      // A stand-in for Docker: "plant" writes a new file into the mounted
      // view; "probe" fails when that file, or the reproducer, is missing
      // or present against expectation.
      await writeFile(
        join(bin, "docker"),
        [
          "#!/bin/sh",
          'case "$1" in',
          `  image) echo sha256:${"a".repeat(64)} ;;`,
          '  run) for arg in "$@"; do case "$arg" in type=bind,source=*) source="${arg#type=bind,source=}"; source="${source%%,target=*}" ;; esac; last="$arg"; done',
          '       case "$last" in',
          '         plant) printf x > "$source/src/planted.ts" ;;',
          '         probe) test -e "$source/src/planted.ts" && exit 7; test -f "$source/src/repro.test.ts" || exit 8 ;;',
          "       esac ;;",
          "esac",
          "exit 0",
          "",
        ].join("\n"),
      );
      await chmod(join(bin, "docker"), 0o755);
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      const results = await verifyInContainer(
        root,
        [
          { image: "fixture", argv: ["plant"] },
          { image: "fixture", argv: ["probe"] },
        ],
        structuredClone(DEFAULT_POLICY),
        "snapshot",
        undefined,
        { added: [{ path: "src/repro.test.ts", content: "repro\n" }] },
      );
      expect(results.map(({ code }) => code)).toEqual([0, 0]);
    },
  );
});
