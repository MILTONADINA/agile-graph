import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This module compiles to dist/package-layout.js and runs from src/ under
// tests; either way the engine package's root is one directory up.
const ENGINE_PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The engine package's own directory, installed or in a source checkout. */
export function enginePackageRoot(): string {
  return path.resolve(ENGINE_PACKAGE_ROOT);
}

/** The engine's version, read from its own package.json. */
export const ENGINE_VERSION = (() => {
  try {
    return (
      JSON.parse(
        readFileSync(path.join(ENGINE_PACKAGE_ROOT, "package.json"), "utf8"),
      ) as { version: string }
    ).version;
  } catch {
    return "unknown";
  }
})();

/**
 * The repository root when the engine runs from an Agile Graph source
 * checkout, or null when it runs as an installed package. Paths outside the
 * package are only ever resolved against a checkout: next to an installed
 * package, a relative path would reach into whatever else is installed.
 */
export function sourceCheckoutRoot(
  packageRoot: string = enginePackageRoot(),
): string | null {
  const root = path.resolve(packageRoot, "..", "..");
  if (path.join(root, "packages", "engine") !== path.resolve(packageRoot))
    return null;
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { name?: unknown };
    return manifest.name === "agile-graph-workspace" ? root : null;
  } catch {
    return null;
  }
}

/**
 * The dashboard a server hosts: the dashboard workspace's build in a source
 * checkout, or the copy packed into an installed engine.
 */
export function dashboardRoot(
  packageRoot: string = enginePackageRoot(),
): string {
  const checkout = sourceCheckoutRoot(packageRoot);
  return checkout
    ? path.join(checkout, "packages", "dashboard", "dist")
    : path.join(path.resolve(packageRoot), "dashboard");
}

/**
 * The security scanner image's build context: the repository's sidecar in a
 * source checkout, or the copy of its Dockerfile an installed engine ships.
 */
export function scannerBuildContext(
  packageRoot: string = enginePackageRoot(),
): string {
  const checkout = sourceCheckoutRoot(packageRoot);
  return checkout
    ? path.join(checkout, "sidecars", "security")
    : path.join(path.resolve(packageRoot), "scanner");
}
