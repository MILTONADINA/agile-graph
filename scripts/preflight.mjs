#!/usr/bin/env node
// A fast local check before a push: the cheap CI steps a change can fail,
// chosen from the files it changed, so a rejection costs minutes here
// instead of a 25-minute CI cycle. It never replaces CI or `npm run check`.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = "packages/engine/";
/** A file argument that can never be read as an option. */
const asPath = (file) => (file.startsWith("./") ? file : `./${file}`);
/** The JavaScript entry point each tool step runs with this Node. */
const TOOL_BINS = { eslint: "eslint", vitest: "vitest" };
const CONTRACTS = "packages/contracts/";
const DASHBOARD = "packages/dashboard/";
const BUILD_ENGINE = {
  name: "build engine",
  command: "npm",
  args: ["run", "build", "-w", "@agile-graph/engine"],
};
/** Script tests that load or run packages/engine/dist, so need it built. */
const NEEDS_BUILT_ENGINE = new Set([
  "scripts/readme-quickstart.test.mjs",
  "scripts/dist-freshness.test.mjs",
  "scripts/labelling.test.mjs",
  "evaluation/sealed/tests/aggregate-vault.test.mjs",
]);

/**
 * The steps to run for the repository paths a change added or modified
 * (`changed`) and deleted (`deleted`), in order. A deleted path chooses
 * steps (a deleted source still needs the typecheck that finds imports of
 * it) but is never passed to a tool. Each step is { name, command, args,
 * cwd? }; cwd is relative to the repository.
 */
export function planPreflight(changed, deleted = []) {
  const files = [...new Set(changed)].filter(Boolean).sort();
  const touched = [...new Set([...files, ...deleted])].filter(Boolean);
  const steps = [
    { name: "format", command: "npm", args: ["run", "format:check"] },
  ];
  const lintable = files.filter((file) => /\.(c|m)?[jt]sx?$/.test(file));
  if (touched.includes("eslint.config.mjs"))
    steps.push({ name: "lint", command: "npm", args: ["run", "lint"] });
  else if (lintable.length)
    steps.push({
      name: "lint",
      tool: "eslint",
      args: ["--max-warnings", "0", ...lintable.map(asPath)],
    });
  const typed = touched.some(
    (file) => /\.tsx?$/.test(file) || /(^|\/)tsconfig[^/]*\.json$/.test(file),
  );
  if (typed)
    steps.push({
      name: "typecheck",
      command: "npm",
      args: ["run", "typecheck"],
    });
  const engine = files
    .filter((file) => file.startsWith(ENGINE) && /\.tsx?$/.test(file))
    .map((file) => file.slice(ENGINE.length));
  if (engine.length)
    steps.push({
      name: "engine tests",
      tool: "vitest",
      args: ["related", "--run", ...engine.map(asPath)],
      cwd: ENGINE,
    });
  if (touched.some((file) => file.startsWith(DASHBOARD)))
    steps.push({
      name: "dashboard tests",
      command: "npm",
      args: ["test", "-w", "@agile-graph/dashboard"],
    });
  const scriptTests = [
    ...new Set(
      files
        .filter((file) => /^(scripts|evaluation)\/.+\.mjs$/.test(file))
        .map((file) =>
          file.endsWith(".test.mjs")
            ? file
            : file.replace(/\.mjs$/, ".test.mjs"),
        ),
    ),
  ].filter((file) => files.includes(file) || exists(file));
  if (scriptTests.some((file) => NEEDS_BUILT_ENGINE.has(file)))
    steps.push(BUILD_ENGINE);
  if (scriptTests.length)
    steps.push({
      name: "script tests",
      command: "node",
      args: ["--test", ...scriptTests],
    });
  if (
    touched.some(
      (file) =>
        file.startsWith("specs/") ||
        (file.startsWith(ENGINE) && file.includes("/tests/")),
    )
  ) {
    if (!steps.includes(BUILD_ENGINE)) steps.push(BUILD_ENGINE);
    steps.push({
      name: "spec-check",
      command: "node",
      args: ["packages/engine/dist/cli.js", "spec-check"],
    });
  }
  return steps;
}

/** Paths a contracts change can break beyond the related engine tests. */
export function preflightNotes(changed) {
  return changed.some((file) => file.startsWith(CONTRACTS))
    ? [
        "The contracts package changed: engine tests that use it through the package are not traced by `vitest related`; run `npm test` before pushing.",
      ]
    : [];
}

let root = process.cwd();
function exists(file) {
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${file}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** The bin script a package declares, resolved from the repository. */
function toolEntry(tool) {
  const manifest = createRequire(path.join(root, "package.json")).resolve(
    `${TOOL_BINS[tool]}/package.json`,
  );
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  return path.join(
    path.dirname(manifest),
    typeof bin === "string" ? bin : bin[tool],
  );
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Files changed since the merge base with `base`, committed or not. */
export function changedFiles(base = "origin/main") {
  const mergeBase = git(["merge-base", "HEAD", base])[0];
  return {
    changed: [
      ...git(["diff", "--name-only", "--diff-filter=ACMR", mergeBase]),
      ...git(["ls-files", "--others", "--exclude-standard"]),
    ],
    deleted: git(["diff", "--name-only", "--diff-filter=D", mergeBase]),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  root = git(["rev-parse", "--show-toplevel"])[0];
  const base = process.argv[2] ?? "origin/main";
  const { changed, deleted } = changedFiles(base);
  if (!changed.length && !deleted.length) {
    console.log(`Preflight: nothing changed since ${base}.`);
    process.exit(0);
  }
  const started = Date.now();
  for (const step of planPreflight(changed, deleted)) {
    const begun = Date.now();
    process.stdout.write(`Preflight: ${step.name}...\n`);
    // Tools run as `node <entry>` with no shell, so no path in the change
    // reaches a shell; only npm's fixed scripts use one, on Windows.
    const [command, args] = step.tool
      ? [process.execPath, [toolEntry(step.tool), ...step.args]]
      : [step.command, step.args];
    const result = spawnSync(command, args, {
      cwd: path.join(root, step.cwd ?? ""),
      stdio: "inherit",
      shell:
        !step.tool && step.command === "npm" && process.platform === "win32",
    });
    const seconds = ((Date.now() - begun) / 1000).toFixed(0);
    if (result.status !== 0) {
      console.error(`Preflight: ${step.name} failed after ${seconds}s.`);
      process.exit(1);
    }
    console.log(`Preflight: ${step.name} passed in ${seconds}s.`);
  }
  for (const note of preflightNotes([...changed, ...deleted]))
    console.log(`Preflight: ${note}`);
  console.log(
    `Preflight passed in ${((Date.now() - started) / 1000).toFixed(0)}s. CI still runs everything.`,
  );
}
