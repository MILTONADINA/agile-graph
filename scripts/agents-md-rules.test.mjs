import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Collapse line wraps and runs of spaces so a phrase can wrap in AGENTS.md.
const flat = (url) =>
  readFileSync(new URL(url, import.meta.url), "utf8").replace(/\s+/g, " ");

const agents = flat("../AGENTS.md");
const claude = flat("../CLAUDE.md");

// Positive rules are exact phrases on purpose: rewording a safety rule must
// be a visible, reviewed change. Negative rules are patterns, because they
// have to catch many wordings of a read-first instruction.
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

// A gap of up to n characters that a sentence end stops, but a dot inside a
// file name or number (not followed by a space) does not.
const gap = (n) => `(?:[^.]|\\.(?!\\s)){0,${n}}`;
const readFirstPatterns = [
  new RegExp(`read${gap(80)}start here${gap(120)}(before|first)`, "i"),
  new RegExp(
    `read${gap(80)}handover${gap(40)}before (working|every|any|you)`,
    "i",
  ),
];

test("read-first patterns see through dots in file names", () => {
  const text = "Read docs/claude-code-handover.md Start here before any task.";
  assert.ok(readFirstPatterns.some((re) => re.test(text)));
  assert.ok(
    !readFirstPatterns.some((re) => re.test("Read it. Start here before.")),
  );
});

test("AGENTS.md does not instruct reading the handover before every task", () => {
  assert.doesNotMatch(agents, /before working,? read/i);
  for (const re of readFirstPatterns) assert.doesNotMatch(agents, re);
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
