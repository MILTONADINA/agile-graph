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
  assert.deepEqual(steps[1], {
    name: "lint",
    tool: "eslint",
    args: ["--max-warnings", "0", "./packages/engine/src/retro.ts"],
  });
  assert.deepEqual(steps[3], {
    name: "engine tests",
    tool: "vitest",
    args: ["related", "--run", "./src/retro.ts"],
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

test("a deleted source file still runs the typecheck, and is never passed to a tool", () => {
  const steps = planPreflight([], ["packages/engine/src/old.ts"]);
  assert.deepEqual(names(steps), ["format", "typecheck"]);
  const both = planPreflight(
    ["packages/engine/src/new.ts"],
    ["packages/engine/src/old.ts"],
  );
  assert.ok(!JSON.stringify(both).includes("old.ts"));
});

test("a changed test in a nested script directory runs", () => {
  const steps = planPreflight([
    "evaluation/guest-runtime/cloud-graph.test.mjs",
  ]);
  assert.deepEqual(steps.find((step) => step.name === "script tests").args, [
    "--test",
    "evaluation/guest-runtime/cloud-graph.test.mjs",
  ]);
});

test("a package's TypeScript configuration runs the typecheck", () => {
  assert.ok(
    names(planPreflight(["packages/engine/tsconfig.json"])).includes(
      "typecheck",
    ),
  );
});

test("a file named like an option is always passed as a path", () => {
  const steps = planPreflight(["--config=evil.mjs", "packages/engine/--x.ts"]);
  assert.deepEqual(steps.find((step) => step.name === "lint").args, [
    "--max-warnings",
    "0",
    "./--config=evil.mjs",
    "./packages/engine/--x.ts",
  ]);
  assert.deepEqual(steps.find((step) => step.name === "engine tests").args, [
    "related",
    "--run",
    "./--x.ts",
  ]);
});
