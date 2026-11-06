import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  changedFiles,
  linkedTestFiles,
  planPreflight as planWithLinks,
  preflightNotes,
} from "./preflight.mjs";

const names = (steps) => steps.map((step) => step.name);
/** Plans with no spec-linked tests, so the cases do not depend on specs/. */
const planPreflight = (changed, deleted = []) =>
  planWithLinks(changed, deleted, new Set());

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

test("the engine build runs before script tests that need the built engine", () => {
  for (const test of [
    "scripts/readme-quickstart.test.mjs",
    "scripts/dist-freshness.test.mjs",
    "scripts/labelling.test.mjs",
    "evaluation/sealed/tests/aggregate-vault.test.mjs",
  ]) {
    const list = names(planPreflight([test]));
    assert.ok(list.includes("build engine"), test);
    assert.ok(
      list.indexOf("build engine") < list.indexOf("script tests"),
      test,
    );
    assert.equal(list.filter((name) => name === "build engine").length, 1);
  }
  // A changed script whose test needs the build is covered too.
  const steps = names(planPreflight(["scripts/labelling.mjs"]));
  assert.ok(steps.indexOf("build engine") < steps.indexOf("script tests"));
});

test("no engine build is added for script tests that do not need it", () => {
  assert.ok(
    !names(planPreflight(["scripts/preflight.test.mjs"])).includes(
      "build engine",
    ),
  );
});

test("a spec change with a dist-dependent script test builds once, before the script tests and spec-check", () => {
  assert.deepEqual(
    names(
      planPreflight([
        "specs/release/npm-packages.md",
        "scripts/readme-quickstart.test.mjs",
      ]),
    ),
    ["format", "lint", "build engine", "script tests", "spec-check"],
  );
});

test("a changed or deleted test file that a spec links builds the engine and checks the specs", () => {
  const linked = new Set(["scripts/npm-packages.test.mjs"]);
  assert.deepEqual(
    names(planWithLinks(["scripts/npm-packages.test.mjs"], [], linked)),
    ["format", "lint", "script tests", "build engine", "spec-check"],
  );
  assert.deepEqual(
    names(planWithLinks([], ["scripts/npm-packages.test.mjs"], linked)),
    ["format", "build engine", "spec-check"],
  );
  assert.ok(
    !names(
      planWithLinks(["scripts/license-allowlist.test.mjs"], [], linked),
    ).includes("spec-check"),
  );
});

test("linked test files are read the way spec-check reads them", () => {
  const files = linkedTestFiles([
    "- AC1: x\n  - Test: scripts/a.test.mjs :: does a\r\n  - Test: packages/engine/tests/b.test.ts :: does b",
    "- Test: scripts/unindented.test.mjs :: not a link\n  Test: scripts/no-dash.test.mjs :: nor this",
  ]);
  assert.deepEqual([...files].sort(), [
    "packages/engine/tests/b.test.ts",
    "scripts/a.test.mjs",
  ]);
});

test("a change to scripts/npm-packages.test.mjs runs spec-check, because the repository's specs link it", () => {
  assert.ok(
    names(planWithLinks(["scripts/npm-packages.test.mjs"])).includes(
      "spec-check",
    ),
  );
});

test("a renamed file counts as its old path deleted and its new path added", () => {
  // The repository and an empty global git config live side by side, so
  // the developer's own settings (commit signing, hooks, a default branch)
  // cannot change what the test does.
  const scratch = mkdtempSync(path.join(tmpdir(), "preflight-rename-"));
  const repo = path.join(scratch, "repo");
  const globalConfig = path.join(scratch, "gitconfig");
  mkdirSync(repo);
  writeFileSync(globalConfig, "");
  try {
    const git = (...args) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        {
          cwd: repo,
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
    git("init", "-q", "-b", "main");
    mkdirSync(path.join(repo, "scripts"));
    writeFileSync(path.join(repo, "scripts/old.test.mjs"), "export {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("mv", "scripts/old.test.mjs", "scripts/new.test.mjs");
    git("commit", "-q", "-m", "rename");
    const { changed, deleted } = changedFiles("HEAD~1", repo);
    assert.deepEqual(changed, ["scripts/new.test.mjs"]);
    assert.deepEqual(deleted, ["scripts/old.test.mjs"]);
    const linked = new Set(["scripts/old.test.mjs"]);
    assert.ok(
      names(planWithLinks(changed, deleted, linked)).includes("spec-check"),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
