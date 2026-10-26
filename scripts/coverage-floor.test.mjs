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
