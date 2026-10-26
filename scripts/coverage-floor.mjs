#!/usr/bin/env node
// Fails when the engine's line coverage is below the committed floor.
//
//   node scripts/coverage-floor.mjs [summary.json] [floor.json]
//
// Defaults: packages/engine/coverage/coverage-summary.json (vitest's
// json-summary reporter) and scripts/coverage-floor.json ({"lines": N}, a
// whole percent). The floor only moves up, in the PR that raises coverage.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const defaultSummary = fileURLToPath(
  new URL("../packages/engine/coverage/coverage-summary.json", import.meta.url),
);
const defaultFloor = fileURLToPath(
  new URL("./coverage-floor.json", import.meta.url),
);

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or not JSON: ${error.message}`);
  }
}

const percent = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;

export async function checkCoverageFloor(
  summaryPath = defaultSummary,
  floorPath = defaultFloor,
) {
  try {
    const floor = (await readJson(floorPath, "coverage floor"))?.lines;
    if (!percent(floor))
      throw new Error("coverage floor needs a numeric `lines` from 0 to 100");
    const actual = (await readJson(summaryPath, "coverage summary"))?.total
      ?.lines?.pct;
    if (!percent(actual))
      throw new Error("coverage summary has no numeric total.lines.pct");
    if (actual < floor)
      return {
        ok: false,
        message: `Line coverage ${actual}% is below the floor of ${floor}%.`,
      };
    return {
      ok: true,
      message: `Line coverage ${actual}% meets the floor of ${floor}%.`,
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkCoverageFloor(process.argv[2], process.argv[3]);
  (result.ok ? console.log : console.error)(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
