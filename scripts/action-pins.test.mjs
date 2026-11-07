import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// #290: every action a workflow runs is pinned to a full commit SHA with a
// version comment, so a tag that moves cannot change what runs with a job
// token. Local actions and reusable workflows (`./`) run code from this
// commit and need no pin.
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d[\w.-]*$/;

export function unpinnedUses(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*(.*?)\s*$/.exec(line);
    if (!match) return;
    // A quoted reference is refused: none is used, and a "# v1" inside the
    // quotes would be part of the reference, not a comment.
    const ref = match[1];
    if (ref.startsWith("./")) return;
    if (!PINNED.test(ref)) problems.push(`${index + 1}: ${ref}`);
  });
  return problems;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const workflowDir = `${root}.github/workflows/`;
const workflows = readdirSync(workflowDir).filter((name) =>
  /\.ya?ml$/.test(name),
);

test("every workflow uses line pins a full SHA with a version comment", () => {
  assert.ok(workflows.length > 0);
  let seen = 0;
  for (const name of workflows) {
    const text = readFileSync(workflowDir + name, "utf8");
    seen += text
      .split("\n")
      .filter((line) => /^\s*(-\s+)?uses:/.test(line)).length;
    assert.deepEqual(unpinnedUses(text), [], name);
  }
  assert.ok(seen > 0, "the check read at least one uses line");
});

test("the check refuses tags, short SHAs, branches and missing comments", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  for (const ref of [
    "actions/checkout@v4",
    "actions/checkout@v4.1.1 # v4.1.1",
    `actions/checkout@${sha.slice(0, 7)} # v7.0.1`,
    "actions/checkout@main # v7.0.1",
    `actions/checkout@${sha}`,
    `actions/checkout@${sha} # pinned`,
    `actions/checkout@${sha.toUpperCase()} # v7.0.1`,
    "docker://alpine:3.20",
    "actions/checkout",
    `"actions/checkout@${sha}" # v7.0.1`,
  ]) {
    assert.equal(
      unpinnedUses(`      - uses: ${ref}\n`).length,
      1,
      `refused: ${ref}`,
    );
  }
});

test("the check accepts pinned, nested and local references", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  const text = [
    `      - uses: actions/checkout@${sha} # v7.0.1`,
    `        uses: github/codeql-action/init@${sha} # v3.29.0`,
    "      - uses: ./.github/actions/setup",
    "    uses: ./.github/workflows/reusable.yml",
    "      # uses: actions/checkout@v4 (a comment is not a step)",
  ].join("\n");
  assert.deepEqual(unpinnedUses(text), []);
});
