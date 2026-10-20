// The production-licence allowlist check and its CI wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("license-allowlist.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "license-allowlist-"));

function run(packages, allowlist = { MIT: "r", "Apache-2.0": "r" }) {
  const lock = join(dir, `lock-${Math.random()}.json`);
  const allow = join(dir, `allow-${Math.random()}.json`);
  writeFileSync(lock, JSON.stringify({ packages }));
  writeFileSync(allow, JSON.stringify(allowlist));
  return spawnSync(process.execPath, [script, lock, allow], {
    encoding: "utf8",
  });
}
const pkg = (license, extra = {}) => ({ version: "1.0.0", license, ...extra });

test("allowed licences pass", () => {
  const r = run({
    "": { name: "root" },
    "node_modules/a": pkg("MIT"),
    "node_modules/b": pkg("Apache-2.0"),
  });
  assert.equal(r.status, 0, r.stderr);
});

test("GPL-3.0 is rejected and named", () => {
  const r = run({ "node_modules/g": pkg("GPL-3.0") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /node_modules\/g@1\.0\.0.*GPL-3\.0/);
});

test("a missing licence is rejected", () => {
  const r = run({ "node_modules/n": { version: "1.0.0" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no licence/);
});

test("OR passes when one side is allowed; AND needs both", () => {
  assert.equal(run({ "node_modules/o": pkg("GPL-3.0 OR MIT") }).status, 0);
  assert.equal(run({ "node_modules/o": pkg("MIT OR Apache") }).status, 0);
  assert.equal(run({ "node_modules/o": pkg("GPL-3.0 OR AGPL-3.0") }).status, 1);
  assert.equal(run({ "node_modules/o": pkg("MIT AND GPL-3.0") }).status, 1);
});

test("dev, link and workspace entries are skipped", () => {
  const r = run({
    "node_modules/d": pkg("GPL-3.0", { dev: true }),
    "node_modules/l": { link: true, resolved: "packages/x" },
    "packages/x": { version: "1.0.0" },
  });
  assert.equal(r.status, 0, r.stderr);
});

test("unreadable input fails", () => {
  const r = spawnSync(process.execPath, [script, join(dir, "absent.json")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
});

test("the committed lock passes the committed allowlist", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("ci.yml runs the script after the audit step", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const audit = ci.indexOf("npm audit --omit=dev");
  const step = ci.indexOf("node scripts/license-allowlist.mjs");
  assert.ok(audit > 0 && step > audit);
});
