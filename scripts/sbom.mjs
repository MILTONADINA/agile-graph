// Writes a CycloneDX SBOM whose subject is one published workspace package.
// `npm sbom --workspace` names the private root as `metadata.component`, so
// this makes the workspace package the subject and keeps only what it reaches
// through the dependency graph. `--omit dev` is not used: npm marks the
// engine's optional peers as dev in the lockfile and would drop them, so the
// package's own dev-only dependencies are cut from the subject's edges here.
// Usage: node scripts/sbom.mjs packages/engine > engine.cdx.json
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

export function subjectSbom(bom, name, version, devOnly = []) {
  const ref = `${name}@${version}`;
  const subject = bom.components.find(
    (component) => component["bom-ref"] === ref,
  );
  if (!subject) throw new Error(`${ref} is missing from the npm SBOM`);
  const dev = new Set(devOnly);
  const edges = new Map(
    (bom.dependencies ?? []).map((entry) => [
      entry.ref,
      entry.ref === ref
        ? (entry.dependsOn ?? []).filter(
            (next) => !dev.has(next.slice(0, next.lastIndexOf("@"))),
          )
        : (entry.dependsOn ?? []),
    ]),
  );
  const reached = new Set([ref]);
  const queue = [ref];
  while (queue.length) {
    for (const next of edges.get(queue.pop()) ?? [])
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
  }
  return {
    ...bom,
    metadata: { ...bom.metadata, component: subject },
    components: bom.components.filter(
      (component) =>
        component["bom-ref"] !== ref && reached.has(component["bom-ref"]),
    ),
    dependencies: (bom.dependencies ?? [])
      .filter((entry) => reached.has(entry.ref))
      .map((entry) =>
        entry.ref === ref ? { ...entry, dependsOn: edges.get(ref) } : entry,
      ),
  };
}

export function workspaceSbom(workspace) {
  const {
    name,
    version,
    devDependencies = {},
    peerDependencies = {},
  } = JSON.parse(
    readFileSync(new URL(`../${workspace}/package.json`, import.meta.url)),
  );
  // Optional peers are listed as dev too (so tests can import them); keep them.
  const devOnly = Object.keys(devDependencies).filter(
    (dependency) => !(dependency in peerDependencies),
  );
  const bom = JSON.parse(
    execFileSync(
      "npm",
      ["sbom", "--workspace", workspace, "--sbom-format", "cyclonedx"],
      { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  return subjectSbom(bom, name, version, devOnly);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspace = process.argv[2];
  if (!workspace) throw new Error("usage: sbom.mjs <workspace directory>");
  process.stdout.write(
    `${JSON.stringify(workspaceSbom(workspace), null, 2)}\n`,
  );
}
