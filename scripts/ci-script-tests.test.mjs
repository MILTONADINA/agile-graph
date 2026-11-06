import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

// #323: CI names each scripts/*.test.mjs file in its own step, so a new file
// that no step names never runs. Every one must be named by a workflow.
const root = path.resolve(import.meta.dirname, "..");

test("every scripts test file is run by a CI workflow step", async () => {
  const dir = path.join(root, ".github", "workflows");
  const workflows = (
    await Promise.all(
      (await readdir(dir))
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => readFile(path.join(dir, name), "utf8")),
    )
  ).join("\n");
  const files = (await readdir(path.join(root, "scripts")))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
  assert.ok(files.length > 0);
  const missing = files.filter(
    (name) =>
      !new RegExp(`\\bscripts/${name.replaceAll(".", "\\.")}\\b`).test(
        workflows,
      ),
  );
  assert.deepEqual(
    missing,
    [],
    `not run by any workflow: ${missing.join(", ")}`,
  );
});
