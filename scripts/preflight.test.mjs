import assert from "node:assert/strict";
import test from "node:test";
import { planPreflight, preflightNotes } from "./preflight.mjs";

const names = (steps) => steps.map((step) => step.name);

test("a docs-only change runs only the format check", () => {
  assert.deepEqual(names(planPreflight(["docs/outcomes.md"])), ["format"]);
});

test("an engine source change runs lint on it, the typecheck and the related engine tests", () => {
  const steps = planPreflight(["packages/engine/src/retro.ts"]);
  assert.deepEqual(names(steps), [
    "format",
    "lint",
    "typecheck",
    "engine tests",
  ]);
  assert.deepEqual(steps[1].args, ["eslint", "packages/engine/src/retro.ts"]);
  assert.deepEqual(steps[3], {
    name: "engine tests",
    command: "npx",
    args: ["vitest", "related", "--run", "src/retro.ts"],
    cwd: "packages/engine/",
  });
});

test("a changed engine test or spec also builds the engine and checks the specs", () => {
  assert.deepEqual(names(planPreflight(["specs/quality/delivery-retro.md"])), [
    "format",
    "build engine",
    "spec-check",
  ]);
  assert.deepEqual(
    names(planPreflight(["packages/engine/tests/retro.test.ts"])),
    [
      "format",
      "lint",
      "typecheck",
      "engine tests",
      "build engine",
      "spec-check",
    ],
  );
});

test("a changed lint configuration lints the whole repository", () => {
  const steps = planPreflight(["eslint.config.mjs"]);
  assert.deepEqual(steps[1], {
    name: "lint",
    command: "npm",
    args: ["run", "lint"],
  });
});

test("a changed script runs its own test file, and a changed test runs itself", () => {
  const steps = planPreflight([
    "scripts/preflight.mjs",
    "scripts/preflight.test.mjs",
  ]);
  const scripts = steps.find((step) => step.name === "script tests");
  assert.deepEqual(scripts.args, ["--test", "scripts/preflight.test.mjs"]);
});

test("a contracts change says the related engine tests do not cover it", () => {
  assert.equal(preflightNotes(["packages/contracts/src/index.ts"]).length, 1);
  assert.equal(preflightNotes(["packages/engine/src/cli.ts"]).length, 0);
});
