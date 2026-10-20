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
    .replace(/^\s*(-\s+)?(run:\s*)?/, "")
    .split(/\|\||&&|;|\{|\}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function installCommands(workflow) {
  const found = [];
  workflow.lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    for (const command of commands(line)) {
      // Global installs of the npm client itself run no project dependency scripts.
      if (
        /^npm\s+(ci|install|i|add)\b/.test(command) &&
        !/\s(-g|--global)\b/.test(command)
      ) {
        found.push({ command, line: index + 1 });
      }
    }
  });
  return found;
}

function rebuildAllowlists(workflow) {
  const lists = [];
  for (const line of workflow.lines) {
    if (/^\s*#/.test(line)) continue;
    for (const command of commands(line)) {
      const match = /^npm\s+rebuild\s+(.+)$/.exec(command);
      if (match) lists.push(match[1].trim().split(/\s+/).sort());
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
    for (const { command, line } of installCommands(workflow)) {
      total += 1;
      assert.match(
        command,
        /(^|\s)--ignore-scripts(\s|$)/,
        `${workflow.name}:${line} runs "${command}" without --ignore-scripts`,
      );
    }
  }
  assert.ok(total > 0, "expected at least one npm ci in the workflows");
});

test("each workflow that installs rebuilds exactly the allowlist", () => {
  const expected = lockfileInstallScriptPackages();
  assert.ok(expected.length > 0, "lockfile lists no install-script packages");
  for (const workflow of workflows) {
    if (installCommands(workflow).length === 0) continue;
    const lists = rebuildAllowlists(workflow);
    assert.ok(
      lists.length > 0,
      `${workflow.name} installs without an npm rebuild`,
    );
    for (const list of lists) {
      assert.deepEqual(
        list,
        expected,
        `${workflow.name} rebuild list differs from package-lock.json install-script packages`,
      );
    }
  }
});
