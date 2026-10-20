import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflowDir = `${root}.github/workflows/`;
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({
    name,
    lines: readFileSync(workflowDir + name, "utf8").split("\n"),
  }));

// Statements split on shell separators so `a || { b; }` is checked per command.
function commands(line) {
  return line
    .replace(/\s#.*$/, "")
    .replace(/^\s*(-\s+)?(run:\s*)?/, "")
    .split(/\|\||&&|;|\{|\}/)
    .map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, ""))
    .filter(Boolean);
}

// Workflow jobs: the lines under each two-space-indented key below `jobs:`.
function jobs(workflow) {
  const result = [];
  let inJobs = false;
  workflow.lines.forEach((line, index) => {
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    else if (/^\S/.test(line)) inJobs = false;
    const header = inJobs && /^ {2}([\w-]+):\s*$/.exec(line);
    if (header)
      result.push({ name: `${workflow.name}:${header[1]}`, entries: [] });
    else if (inJobs && result.length > 0)
      result.at(-1).entries.push({ line, number: index + 1 });
  });
  return result;
}

function installCommands(job) {
  const found = [];
  for (const { line, number } of job.entries) {
    if (/^\s*#/.test(line)) continue;
    for (const command of commands(line)) {
      if (/^(yarn|pnpm|bun)\s+(install|add|i)\b/.test(command)) {
        found.push({ command, line: number });
      } else if (
        /^npm\s+(ci|install|i|add)\b/.test(command) &&
        // Only the npm client itself may be installed globally without the flag.
        !(/\s(-g|--global)\b/.test(command) && /\snpm@/.test(command))
      ) {
        found.push({ command, line: number });
      }
    }
  }
  return found;
}

function rebuildAllowlists(job) {
  const lists = [];
  for (const { line, number } of job.entries) {
    if (/^\s*#/.test(line)) continue;
    for (const command of commands(line)) {
      const match = /^npm\s+rebuild\b(.*)$/.exec(command);
      if (match) {
        lists.push({
          line: number,
          list: match[1].trim().split(/\s+/).filter(Boolean).sort(),
        });
      }
    }
  }
  return lists;
}

function lockfileInstallScriptPackages() {
  const lock = JSON.parse(readFileSync(`${root}package-lock.json`, "utf8"));
  const names = new Set();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.startsWith("node_modules/") && entry.hasInstallScript) {
      names.add(
        path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
      );
    }
  }
  return [...names].sort();
}

test("every workflow dependency install ignores lifecycle scripts", () => {
  let total = 0;
  for (const workflow of workflows) {
    for (const job of jobs(workflow)) {
      for (const { command, line } of installCommands(job)) {
        total += 1;
        assert.match(
          command,
          /^npm\s/,
          `${job.name}:${line} uses "${command}"; use npm ci --ignore-scripts`,
        );
        assert.match(
          command,
          /(^|\s)--ignore-scripts(\s|$)/,
          `${job.name}:${line} runs "${command}" without --ignore-scripts`,
        );
      }
    }
  }
  assert.ok(total > 0, "expected at least one npm ci in the workflows");
});

test("each job that installs rebuilds exactly the allowlist", () => {
  const expected = lockfileInstallScriptPackages();
  assert.ok(expected.length > 0, "lockfile lists no install-script packages");
  for (const workflow of workflows) {
    for (const job of jobs(workflow)) {
      if (installCommands(job).length === 0) continue;
      const lists = rebuildAllowlists(job);
      assert.ok(
        lists.length > 0,
        `${job.name} installs without an npm rebuild`,
      );
      for (const { line, list } of lists) {
        assert.deepEqual(
          list,
          expected,
          `${job.name}:${line} rebuild list differs from package-lock.json install-script packages`,
        );
      }
    }
  }
});
