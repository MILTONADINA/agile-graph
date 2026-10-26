// The reproducible-tarball check: packing one tree twice must give identical
// tarballs. Synthetic two-file packages only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packTwice } from "./pack-twice.mjs";

async function fixture(prepack) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pack-twice-test-"));
  await mkdir(path.join(dir, "lib"));
  await writeFile(path.join(dir, "lib", "a.js"), "export const a = 1;\n");
  await writeFile(path.join(dir, "lib", "b.js"), "export const b = 2;\n");
  await writeFile(
    path.join(dir, "stamp.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync("lib/b.js", "export const b = '" + Date.now() + "-" + process.hrtime.bigint() + "';\\n");
`,
  );
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "toy-pack",
      version: "1.0.0",
      files: ["lib"],
      ...(prepack ? { scripts: { prepack: "node stamp.mjs" } } : {}),
    }),
  );
  return dir;
}

test("two packs of an unchanged package are identical", async () => {
  const dir = await fixture(false);
  try {
    const result = await packTwice([dir]);
    assert.deepEqual(result.differences, []);
    assert.equal(result.packed.length, 1);
    assert.match(result.packed[0].sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a package whose content changes on every pack fails with a file diff", async () => {
  const dir = await fixture(true);
  try {
    const result = await packTwice([dir], { runScripts: true });
    assert.equal(result.differences.length, 1);
    const [difference] = result.differences;
    assert.match(difference, /toy-pack/);
    assert.match(difference, /lib\/b\.js/);
    assert.doesNotMatch(difference, /lib\/a\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the release and CI workflows run the script", async () => {
  for (const file of ["release.yml", "ci.yml"]) {
    const text = await readFile(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      "utf8",
    );
    assert.match(text, /^\s*(run: )?node scripts\/pack-twice\.mjs\s*$/m, file);
  }
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    release.indexOf("scripts/pack-twice.mjs") <
      release.indexOf("scripts/npm-smoke.mjs"),
    "pack-twice runs before the install step",
  );
});
