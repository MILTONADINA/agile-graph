// Builds exactly what the published engine package contains: a clean dist,
// so no output of a deleted source is packed, the dashboard's built files and
// the security scanner's Dockerfile. npm runs it before it packs or publishes
// the package; the dashboard must already be built (npm run build at the
// repository root). With --assets-only it copies the dashboard and scanner
// files and leaves dist as it is, so a test can inspect the tarball without
// rebuilding the dist other processes may be using.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engine = fileURLToPath(new URL("..", import.meta.url));
const repository = path.resolve(engine, "..", "..");
const dashboard = path.join(repository, "packages", "dashboard", "dist");
if (!existsSync(path.join(dashboard, "index.html")))
  throw new Error(
    "The dashboard is not built; run npm run build at the repository root first",
  );
const assetsOnly = process.argv.includes("--assets-only");
for (const output of [...(assetsOnly ? [] : ["dist"]), "dashboard", "scanner"])
  rmSync(path.join(engine, output), { recursive: true, force: true });
if (!assetsOnly)
  execFileSync("npm", ["run", "build"], {
    cwd: engine,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
cpSync(dashboard, path.join(engine, "dashboard"), { recursive: true });
mkdirSync(path.join(engine, "scanner"));
copyFileSync(
  path.join(repository, "sidecars", "security", "Dockerfile"),
  path.join(engine, "scanner", "Dockerfile"),
);
