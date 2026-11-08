import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENGINE_NODE_RANGE,
  nodeVersionSupported,
  parseNodeVersion,
  unsupportedNodeMessage,
} from "../src/node-range.js";
import { usageName } from "../src/usage-name.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("parseNodeVersion", () => {
  it("reads exact major.minor.patch versions", () => {
    expect(parseNodeVersion("22.17.9")).toEqual([22, 17, 9]);
    expect(parseNodeVersion("26.0.0")).toEqual([26, 0, 0]);
  });

  it("rejects anything that is not an exact version", () => {
    for (const text of ["22", "22.18", "v22.18.0", "22.18.0-rc.1", "", "a.b.c"])
      expect(parseNodeVersion(text)).toBeUndefined();
  });
});

describe("nodeVersionSupported for ^22.18.0 || >=24 <27", () => {
  const supported = (version: string) =>
    nodeVersionSupported(version, "^22.18.0 || >=24 <27");

  it("accepts the boundaries of the range", () => {
    expect(supported("22.18.0")).toBe(true);
    expect(supported("24.0.0")).toBe(true);
    expect(supported("26.99.99")).toBe(true);
  });

  it("refuses just outside the boundaries", () => {
    expect(supported("22.17.9")).toBe(false);
    expect(supported("27.0.0")).toBe(false);
  });

  it("refuses the whole gap between the two alternatives", () => {
    expect(supported("23.0.0")).toBe(false);
    expect(supported("23.11.0")).toBe(false);
    expect(supported("23.99.99")).toBe(false);
  });

  it("accepts every minor of major 22 from 22.18 and none below", () => {
    expect(supported("22.19.0")).toBe(true);
    expect(supported("22.0.0")).toBe(false);
    expect(supported("22.17.1")).toBe(false);
  });

  it("refuses versions outside the range in both directions", () => {
    expect(supported("18.20.0")).toBe(false);
    expect(supported("21.7.3")).toBe(false);
    expect(supported("28.0.0")).toBe(false);
  });

  it("accepts the middle of the 24 to 26 window", () => {
    expect(supported("25.9.0")).toBe(true);
  });

  it("refuses a malformed version", () => {
    expect(supported("not-a-version")).toBe(false);
  });

  it("throws on a range shape it does not read", () => {
    expect(() => nodeVersionSupported("22.18.0", "^22.18.0 - 26")).toThrow();
    expect(() => nodeVersionSupported("22.18.0", ">=22.18.0 || 24")).toThrow();
    expect(() => nodeVersionSupported("22.18.0", "^0.4.0")).toThrow();
    expect(() => nodeVersionSupported("22.18.0", "<=22.18.0")).toThrow();
  });
});

describe("ENGINE_NODE_RANGE", () => {
  it("equals the engines.node of packages/engine/package.json", async () => {
    const manifest = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      engines: { node: string };
    };
    expect(ENGINE_NODE_RANGE).toBe(manifest.engines.node);
  });
});

describe("usageName", () => {
  it("names the invoked binary", () => {
    expect(usageName("/usr/local/bin/agile-graph")).toBe("agile-graph");
    expect(usageName("/usr/local/bin/graph-engine")).toBe("graph-engine");
    expect(usageName("graph-engine")).toBe("graph-engine");
  });

  it("defaults to agile-graph for any other entry point", () => {
    expect(usageName("/repo/packages/engine/dist/cli.js")).toBe("agile-graph");
    expect(usageName(undefined)).toBe("agile-graph");
  });
});

describe("CLI entry checks", () => {
  // Preloads run before the CLI module, so they can pin process.versions.node.
  // `name` makes a symlink with that basename, the way npm installs a bin.
  async function runWithNode(version: string, name?: string) {
    const dir = await mkdtemp(path.join(tmpdir(), "graph-node-gate-"));
    directories.push(dir);
    const preload = path.join(dir, "fake-node-version.mjs");
    await writeFile(
      preload,
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });\n`,
    );
    let entry = CLI;
    if (name) {
      entry = path.join(dir, name);
      await symlink(CLI, entry);
    }
    return new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            pathToFileURL(preload).href,
            entry,
            "--help",
          ],
          { timeout: 60_000, maxBuffer: 1_000_000, windowsHide: true },
          (error, stdout, stderr) =>
            resolve({
              code: error ? Number(error.code ?? 1) : 0,
              stdout,
              stderr,
            }),
        );
      },
    );
  }

  it("refuses an unsupported Node with one stderr line and exit 1", async () => {
    const result = await runWithNode("22.17.9");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "agile-graph needs Node 22.18+ or 24 to 26; this is 22.17.9\n",
    );
    expect(result.stderr).toBe(`${unsupportedNodeMessage("22.17.9")}\n`);
  });

  it("runs on a supported Node and names the invoked binary", async () => {
    const result = await runWithNode("22.18.0");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^Usage: agile-graph /);
  });

  it("names graph-engine when invoked as graph-engine", async () => {
    const result = await runWithNode("24.0.0", "graph-engine");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: graph-engine /);
  });
});
