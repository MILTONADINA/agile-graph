// The CycloneDX SBOMs the release workflow attaches: each names its published
// package as the subject and keeps that package's runtime graph, including
// the engine's optional peers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { subjectSbom, workspaceSbom } from "./sbom.mjs";

for (const workspace of ["packages/contracts", "packages/engine"]) {
  test(`${workspace} SBOM names the published package as its subject`, async () => {
    const {
      name,
      version,
      peerDependencies = {},
    } = JSON.parse(
      await readFile(
        new URL(`../${workspace}/package.json`, import.meta.url),
        "utf8",
      ),
    );
    const bom = workspaceSbom(workspace);
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.ok(bom.specVersion);
    assert.equal(bom.metadata.component["bom-ref"], `${name}@${version}`);
    assert.equal(
      bom.metadata.component.purl,
      `pkg:npm/${name.replace("@", "%40")}@${version}`,
    );
    const names = new Set(bom.components.map((component) => component.name));
    assert.ok(!names.has(name), "the subject is not also a component");
    assert.ok(!names.has("eslint") && !names.has("vitest"));
    for (const peer of Object.keys(peerDependencies))
      assert.ok(names.has(peer), `optional peer ${peer} is missing`);
    const refs = new Set([
      bom.metadata.component["bom-ref"],
      ...bom.components.map((component) => component["bom-ref"]),
    ]);
    for (const entry of bom.dependencies) {
      assert.ok(refs.has(entry.ref), `dangling dependency ref ${entry.ref}`);
      for (const ref of entry.dependsOn ?? [])
        assert.ok(refs.has(ref), `dangling dependsOn ref ${ref}`);
    }
  });
}

test("subjectSbom drops the root and what only the root reaches", () => {
  const bom = subjectSbom(
    {
      bomFormat: "CycloneDX",
      metadata: { component: { "bom-ref": "root@1" } },
      components: [
        { "bom-ref": "pkg@2", name: "pkg" },
        { "bom-ref": "dep@3", name: "dep" },
        { "bom-ref": "tool@4", name: "tool" },
      ],
      dependencies: [
        { ref: "root@1", dependsOn: ["pkg@2", "tool@4"] },
        { ref: "pkg@2", dependsOn: ["dep@3"] },
        { ref: "dep@3", dependsOn: [] },
        { ref: "tool@4", dependsOn: [] },
      ],
    },
    "pkg",
    "2",
  );
  assert.equal(bom.metadata.component.name, "pkg");
  assert.deepEqual(
    bom.components.map((component) => component.name),
    ["dep"],
  );
  assert.deepEqual(
    bom.dependencies.map((entry) => entry.ref),
    ["pkg@2", "dep@3"],
  );
  assert.throws(() => subjectSbom(bom, "absent", "1"), /missing/);
});
