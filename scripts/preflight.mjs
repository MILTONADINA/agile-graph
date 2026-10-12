#!/usr/bin/env node
// A fast local check before a push: the cheap CI steps a change can fail,
// chosen from the files it changed, so a rejection costs minutes here
// instead of a 25-minute CI cycle. It never replaces CI or `npm run check`.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = "packages/engine/";
const CONTRACTS = "packages/contracts/";
const DASHBOARD = "packages/dashboard/";

/**
 * The steps to run for a set of changed repository paths, in order. Each
 * step is { name, command, args, cwd? }; cwd is relative to the repository.
 */
export function planPreflight(changed) {
  const files = [...new Set(changed)].filter(Boolean).sort();
  const steps = [
    { name: "format", command: "npm", args: ["run", "format:check"] },
  ];
  const lintable = files.filter((file) => /\.(c|m)?[jt]sx?$/.test(file));
  if (files.includes("eslint.config.mjs"))
    steps.push({ name: "lint", command: "npm", args: ["run", "lint"] });
  else if (lintable.length)
    steps.push({ name: "lint", command: "npx", args: ["eslint", ...lintable] });
  const typed = files.some(
    (file) => /\.tsx?$/.test(file) || file.startsWith("tsconfig"),
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
      command: "npx",
      args: ["vitest", "related", "--run", ...engine],
      cwd: ENGINE,
    });
  if (files.some((file) => file.startsWith(DASHBOARD)))
    steps.push({
      name: "dashboard tests",
      command: "npm",
      args: ["test", "-w", "@agile-graph/dashboard"],
    });
  const scriptTests = [
    ...new Set(
      files
        .filter((file) => /^(scripts|evaluation)\/[^/]+\.mjs$/.test(file))
        .map((file) =>
          file.endsWith(".test.mjs")
            ? file
            : file.replace(/\.mjs$/, ".test.mjs"),
        ),
    ),
  ].filter((file) => files.includes(file) || exists(file));
  if (scriptTests.length)
    steps.push({
      name: "script tests",
      command: "node",
      args: ["--test", ...scriptTests],
    });
  if (
    files.some(
      (file) =>
        file.startsWith("specs/") ||
        (file.startsWith(ENGINE) && file.includes("/tests/")),
    )
  )
    steps.push(
      {
        name: "build engine",
        command: "npm",
        args: ["run", "build", "-w", "@agile-graph/engine"],
      },
      {
        name: "spec-check",
        command: "node",
        args: ["packages/engine/dist/cli.js", "spec-check"],
      },
    );
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

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Files changed since the merge base with `base`, committed or not. */
export function changedFiles(base = "origin/main") {
  const mergeBase = git(["merge-base", "HEAD", base])[0];
  return [
    ...git(["diff", "--name-only", "--diff-filter=ACMR", mergeBase]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  root = git(["rev-parse", "--show-toplevel"])[0];
  const base = process.argv[2] ?? "origin/main";
  const changed = changedFiles(base);
  if (!changed.length) {
    console.log(`Preflight: nothing changed since ${base}.`);
    process.exit(0);
  }
  const started = Date.now();
  for (const step of planPreflight(changed)) {
    const begun = Date.now();
    process.stdout.write(`Preflight: ${step.name}...\n`);
    const result = spawnSync(step.command, step.args, {
      cwd: path.join(root, step.cwd ?? ""),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    const seconds = ((Date.now() - begun) / 1000).toFixed(0);
    if (result.status !== 0) {
      console.error(`Preflight: ${step.name} failed after ${seconds}s.`);
      process.exit(1);
    }
    console.log(`Preflight: ${step.name} passed in ${seconds}s.`);
  }
  for (const note of preflightNotes(changed)) console.log(`Preflight: ${note}`);
  console.log(
    `Preflight passed in ${((Date.now() - started) / 1000).toFixed(0)}s. CI still runs everything.`,
  );
}
