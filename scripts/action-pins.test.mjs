import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// #290: every action a workflow runs is pinned to a full commit SHA with a
// version comment, so a tag that moves cannot change what runs with a job
// token. Local actions and reusable workflows (`./`) run code from this commit
// and need no pin. No YAML parser is installed, so the check fails closed: any
// line that mentions a `uses` key must be exactly the block form below. A
// flow mapping (`{uses: ...}`), a quoted key or value, or a `uses:` inside a
// `run:` script is refused rather than read.
const SHA_REF = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d[\w.-]*$/;
const DIGEST_REF = /^docker:\/\/[\w./:-]+@sha256:[0-9a-f]{64}$/;
const BLOCK = /^\s*(?:-\s+)?uses:\s(\S.*?)\s*$/;
const MENTION = /(?:^|[\s{,[])["']?uses["']?\s*:/;

export function unpinnedUses(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*#/.test(line) || !MENTION.test(line)) return;
    const ref = BLOCK.exec(line)?.[1];
    const ok =
      ref !== undefined &&
      (ref.startsWith("./") || SHA_REF.test(ref) || DIGEST_REF.test(ref));
    if (!ok) problems.push(`${index + 1}: ${line.trim()}`);
  });
  return problems;
}

const root = fileURLToPath(new URL("../", import.meta.url));

// Workflows, plus any composite action this repository adds under
// .github/actions/.
function yamlFiles() {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, ".github", "workflows"));
  walk(path.join(root, ".github", "actions"));
  return files;
}

test("every workflow uses line pins a full SHA with a version comment", () => {
  const files = yamlFiles();
  assert.ok(files.length > 0);
  let seen = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    seen += text.split("\n").filter((line) => MENTION.test(line)).length;
    assert.deepEqual(unpinnedUses(text), [], path.relative(root, file));
  }
  assert.ok(seen > 0, "the check read at least one uses line");
});

test("the check refuses tags, short SHAs, branches and missing comments", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  for (const line of [
    "      - uses: actions/checkout@v4",
    "      - uses: actions/checkout@v4.1.1 # v4.1.1",
    `      - uses: actions/checkout@${sha.slice(0, 7)} # v7.0.1`,
    "      - uses: actions/checkout@main # v7.0.1",
    `      - uses: actions/checkout@${sha}`,
    `      - uses: actions/checkout@${sha} # pinned`,
    `      - uses: actions/checkout@${sha.toUpperCase()} # v7.0.1`,
    "      - uses: actions/checkout",
    "      - uses: docker://alpine:3.20",
    "    uses: octo-org/shared/.github/workflows/ci.yml@v1",
  ]) {
    assert.equal(unpinnedUses(`${line}\n`).length, 1, `refused: ${line}`);
  }
});

test("the check refuses uses forms it does not read", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  for (const line of [
    "      - {uses: actions/checkout@v4}",
    `      - { uses: actions/checkout@${sha} } # v7.0.1`,
    '      - "uses": actions/checkout@v4',
    "      - 'uses': actions/checkout@v4",
    `      - uses: "actions/checkout@${sha}" # v7.0.1`,
    `      - uses: 'actions/checkout@${sha}' # v7.0.1`,
    "      - name: x\n        with: {uses: actions/checkout@v4}",
    "          echo uses: actions/checkout@v4",
  ]) {
    assert.ok(unpinnedUses(`${line}\n`).length >= 1, `refused: ${line}`);
  }
});

test("the check accepts pinned, nested and local references", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  const digest = "a".repeat(64);
  const text = [
    `      - uses: actions/checkout@${sha} # v7.0.1`,
    `        uses: github/codeql-action/init@${sha} # v3.29.0`,
    `      - uses: docker://alpine@sha256:${digest}`,
    "      - uses: ./.github/actions/setup",
    "    uses: ./.github/workflows/reusable.yml",
    "      # uses: actions/checkout@v4 (a comment is not a step)",
    "      - name: Uses a cache",
    "        run: echo reuses",
  ].join("\n");
  assert.deepEqual(unpinnedUses(text), []);
});
