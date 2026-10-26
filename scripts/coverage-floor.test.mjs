// The coverage floor check: a json-summary below the committed floor fails, at
// or above passes, and an unreadable or malformed file fails. Synthetic
// summaries in temporary folders only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoverageFloor } from "./coverage-floor.mjs";

const script = fileURLToPath(new URL("./coverage-floor.mjs", import.meta.url));

async function fixture(summary, floor = { lines: 80 }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coverage-floor-test-"));
  const summaryPath = path.join(dir, "coverage-summary.json");
  const floorPath = path.join(dir, "coverage-floor.json");
  const text = (value) =>
    typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(summaryPath, text(summary));
  await writeFile(floorPath, text(floor));
  return { dir, summaryPath, floorPath };
}

const summary = (pct) => ({ total: { lines: { pct } } });

test("fails when line coverage is below the floor", async () => {
  const f = await fixture(summary(79.99));
  try {
    const result = await checkCoverageFloor(f.summaryPath, f.floorPath);
    assert.equal(result.ok, false);
    assert.match(result.message, /79\.99.*below.*80/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("passes at and above the floor", async () => {
  for (const pct of [80, 93.4]) {
    const f = await fixture(summary(pct));
    try {
      assert.equal(
        (await checkCoverageFloor(f.summaryPath, f.floorPath)).ok,
        true,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("fails on malformed summaries and floors", async () => {
  const bad = [
    ["not json", { lines: 80 }],
    [{}, { lines: 80 }],
    [{ total: { lines: { pct: "Unknown" } } }, { lines: 80 }],
    [{ total: { lines: { pct: 101 } } }, { lines: 80 }],
    [summary(90), "{"],
    [summary(90), { lines: "80" }],
    [summary(90), {}],
  ];
  for (const [s, floor] of bad) {
    const f = await fixture(s, floor);
    try {
      const result = await checkCoverageFloor(f.summaryPath, f.floorPath);
      assert.equal(result.ok, false, JSON.stringify([s, floor]));
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
  const missing = await checkCoverageFloor(
    "/nonexistent/a.json",
    "/nonexistent/b.json",
  );
  assert.equal(missing.ok, false);
});

test("the command exits 1 below the floor and 0 at it", async () => {
  const f = await fixture(summary(50));
  try {
    const run = (s, fl) =>
      spawnSync(process.execPath, [script, s, fl], { encoding: "utf8" });
    assert.equal(run(f.summaryPath, f.floorPath).status, 1);
    await writeFile(f.summaryPath, JSON.stringify(summary(80)));
    assert.equal(run(f.summaryPath, f.floorPath).status, 0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the committed floor is a whole percent from 1 to 100", async () => {
  const floor = JSON.parse(
    await readFile(new URL("./coverage-floor.json", import.meta.url), "utf8"),
  );
  assert.ok(
    Number.isInteger(floor.lines) && floor.lines >= 1 && floor.lines <= 100,
  );
});

// The floor reads the report the platform job's own engine test run writes;
// there is no second engine test pass just for coverage (issue #232).
const ci = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const vitestConfig = await readFile(
  new URL("../packages/engine/vitest.config.ts", import.meta.url),
  "utf8",
);

test("only the Ubuntu x64 entry collects coverage in the existing test run", () => {
  const check = /^( *)- run: npm run check\n((?:\1 {2}.*\n)*)/m.exec(ci);
  assert.ok(check, "the platform job runs npm run check");
  assert.match(
    check[2],
    /GRAPH_ENGINE_COVERAGE: \$\{\{ matrix\.os == 'ubuntu-24\.04' && '1' \|\| '' \}\}/,
  );
  assert.equal(ci.match(/GRAPH_ENGINE_COVERAGE/g).length, 1);
  assert.match(
    vitestConfig,
    /enabled: process\.env\.GRAPH_ENGINE_COVERAGE === "1"/,
  );
});

test("no second engine test pass runs for coverage", () => {
  assert.doesNotMatch(ci, /test:coverage|--coverage/);
  const step = /- name: Engine line coverage floor\n((?: {8}.*\n)+)/.exec(ci);
  assert.ok(step, "the floor step exists");
  assert.match(step[1], /runner\.os == 'Linux' && runner\.arch == 'X64'/);
  assert.match(step[1], /node scripts\/coverage-floor\.mjs/);
  assert.doesNotMatch(step[1], /vitest|npm (run )?test/);
});

test("the Ubuntu platform job timeout is back to 45 minutes", () => {
  assert.match(
    ci,
    /timeout-minutes: \$\{\{ matrix\.os == 'ubuntu-24\.04' && 45 \|\| 30 \}\}/,
  );
});
