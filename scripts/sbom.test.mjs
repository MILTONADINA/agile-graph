// The CycloneDX SBOMs the release workflow attaches: `npm sbom` must produce
// valid JSON naming each published package and its version.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

for (const workspace of ["packages/contracts", "packages/engine"]) {
  test(`${workspace} has a CycloneDX SBOM`, async () => {
    const { name, version } = JSON.parse(
      await readFile(
        new URL(`../${workspace}/package.json`, import.meta.url),
        "utf8",
      ),
    );
    const bom = JSON.parse(
      execFileSync(
        "npm",
        [
          "sbom",
          "--workspace",
          workspace,
          "--sbom-format",
          "cyclonedx",
          "--omit",
          "dev",
        ],
        { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    );
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.ok(bom.specVersion);
    // npm names the root workspace as the SBOM subject and lists the
    // selected workspace package among the components.
    assert.ok(
      bom.components.some(
        (component) =>
          component["bom-ref"] === `${name}@${version}` &&
          component.version === version &&
          component.purl === `pkg:npm/${name.replace("@", "%40")}@${version}`,
      ),
      `${name}@${version} is missing from the SBOM`,
    );
    assert.ok(Array.isArray(bom.components));
  });
}
