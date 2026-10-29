import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Collapse line wraps and runs of spaces so a phrase can wrap in AGENTS.md.
const flat = (url) =>
  readFileSync(new URL(url, import.meta.url), "utf8").replace(/\s+/g, " ");

const agents = flat("../AGENTS.md");
const claude = flat("../CLAUDE.md");

const requiredRules = [
  [
    "autonomy sentence keeps its prohibition",
    "Nothing here permits authorizing memory export, enabling cloud run status, choosing or changing a Jev session cap, creating or reading keys or asking for passphrases, downloading models, pushing to `main`, pushing tags, publishing to npm, or changing the `decisionMode`, `promotedCategories` or `maxCostUsd` settings in `.graph/project.json`.",
  ],
  ["never push to main", "never push to `main` directly"],
  ["no pushing to main in autonomy", "pushing to `main`, pushing tags"],
  ["no publishing to npm", "publishing to npm"],
  ["no memory export", "authorizing memory export"],
  ["no enabling cloud run status", "enabling cloud run status"],
  ["no creating or reading keys", "creating or reading keys"],
  [
    "never sign with or read promotion keys",
    "Never create, sign with or read the owner's promotion keys",
  ],
  [
    "no changing the cost cap settings",
    "changing the `decisionMode`, `promotedCategories` or `maxCostUsd`",
  ],
  ["never clear a cost cap", "never clear a cap to get past a cost error"],
  ["no downloading models", "downloading models"],
  ["no downloading another Qwen", "Do not download another Qwen"],
  [
    "no metered Jev without a cap",
    "metered Jev without an operator-selected numeric session cap",
  ],
  ["no git add -A", "never `git add -A` or `git add .`"],
];

test("AGENTS.md keeps every safety rule", () => {
  for (const [name, phrase] of requiredRules) {
    assert.ok(
      agents.includes(phrase),
      `AGENTS.md must keep the rule "${name}": ${phrase}`,
    );
  }
});

test("AGENTS.md does not instruct reading the handover before every task", () => {
  assert.doesNotMatch(agents, /before working,? read/i);
  assert.doesNotMatch(
    agents,
    /read[^.]{0,80}start here[^.]{0,120}(before|first)/i,
  );
  assert.doesNotMatch(
    agents,
    /read[^.]{0,80}handover[^.]{0,40}before (working|every|any|you)/i,
  );
  const preamble = agents.split("## Where to look")[0];
  assert.doesNotMatch(preamble, /handover/i);
  assert.doesNotMatch(preamble, /\bread\b[^.]*\b(first|before)\b/i);
});

test("AGENTS.md points to the handover by situation", () => {
  assert.match(agents, /## Where to look/);
  assert.ok(agents.includes("[agent handover](docs/claude-code-handover.md)"));
});

test("CLAUDE.md still imports AGENTS.md and adds no read-first rule", () => {
  assert.ok(claude.includes("@AGENTS.md"));
  assert.doesNotMatch(claude, /before working,? read/i);
});
