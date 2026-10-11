import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  dashboardRoot,
  ENGINE_VERSION,
  enginePackageRoot,
  scannerBuildContext,
  sourceCheckoutRoot,
} from "../src/package-layout.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A directory tree with a package.json at each given relative path. */
async function layout(manifests: Record<string, { name: string }>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-layout-"));
  directories.push(root);
  for (const [relative, manifest] of Object.entries(manifests)) {
    await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(
      path.join(root, relative, "package.json"),
      JSON.stringify(manifest),
    );
  }
  return root;
}

describe("engine package layout", () => {
  it("finds the repository it runs from as a source checkout", async () => {
    const repository = fileURLToPath(new URL("../../..", import.meta.url));
    expect(enginePackageRoot()).toBe(
      path.join(path.resolve(repository), "packages", "engine"),
    );
    expect(sourceCheckoutRoot()).toBe(path.resolve(repository));
    const manifest = JSON.parse(
      await readFile(path.join(enginePackageRoot(), "package.json"), "utf8"),
    ) as { version: string };
    expect(ENGINE_VERSION).toBe(manifest.version);
  });

  it("treats an installed engine as no checkout and keeps every file it serves inside the package", async () => {
    const root = await layout({
      ".": { name: "graph-engineering-workspace" },
      "node_modules/@graph-engineering/engine": {
        name: "@graph-engineering/engine",
      },
      "node_modules/@graph-engineering/dashboard": {
        name: "@graph-engineering/dashboard",
      },
    });
    const installed = path.join(
      root,
      "node_modules",
      "@graph-engineering",
      "engine",
    );
    expect(sourceCheckoutRoot(installed)).toBeNull();
    expect(dashboardRoot(installed)).toBe(path.join(installed, "dashboard"));
    expect(scannerBuildContext(installed)).toBe(
      path.join(installed, "scanner"),
    );
  });

  it("accepts a checkout only when its root package is this repository's", async () => {
    const other = await layout({
      ".": { name: "someone-elses-monorepo" },
      "packages/engine": { name: "@graph-engineering/engine" },
    });
    const vendored = path.join(other, "packages", "engine");
    expect(sourceCheckoutRoot(vendored)).toBeNull();
    expect(dashboardRoot(vendored)).toBe(path.join(vendored, "dashboard"));

    const checkout = await layout({
      ".": { name: "graph-engineering-workspace" },
      "packages/engine": { name: "@graph-engineering/engine" },
    });
    const engine = path.join(checkout, "packages", "engine");
    expect(sourceCheckoutRoot(engine)).toBe(checkout);
    expect(dashboardRoot(engine)).toBe(
      path.join(checkout, "packages", "dashboard", "dist"),
    );
    expect(scannerBuildContext(engine)).toBe(
      path.join(checkout, "sidecars", "security"),
    );
  });
});
