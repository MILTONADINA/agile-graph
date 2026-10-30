import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publishingMd = readFileSync(
  new URL("../docs/publishing.md", import.meta.url),
  "utf8",
);

const securityMd = readFileSync(
  new URL("../SECURITY.md", import.meta.url),
  "utf8",
);

const enginePkg = JSON.parse(
  readFileSync(
    new URL("../packages/engine/package.json", import.meta.url),
    "utf8",
  ),
);

test("publishing.md contains Versioning and support heading", () => {
  assert.ok(
    publishingMd.includes("## Versioning and support"),
    "docs/publishing.md must contain the '## Versioning and support' section heading",
  );
});

test("SECURITY.md links to the publishing.md versioning section", () => {
  assert.ok(
    securityMd.includes("docs/publishing.md#versioning-and-support"),
    "SECURITY.md must link to docs/publishing.md#versioning-and-support",
  );
});

test("Node.js range in publishing.md matches engines.node", () => {
  const nodeRange = enginePkg.engines.node;
  const match = publishingMd.match(/The supported Node\.js range is `([^`]+)`/);
  assert.ok(match, "publishing.md must state the Node.js range in backticks");
  assert.equal(
    match[1],
    nodeRange,
    `publishing.md Node range "${match[1]}" must equal engines.node "${nodeRange}"`,
  );
});

const readText = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Release sections of the changelog: `## [x.y.z]`, never `[Unreleased]`. */
function releaseSections(changelog) {
  const parts = changelog.split(/^(?=## \[)/m);
  const sections = [];
  for (const part of parts) {
    const head = part.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (head) sections.push({ version: head[1], body: part });
  }
  return sections;
}

/** A section that changes hashes or breaks something needs upgrade notes. */
const NEEDS_UPGRADE_NOTES = /\b(hash(es)?|breaking)\b/i;

function missingUpgradeHeadings(changelog, upgrading) {
  const headings = upgrading.split("\n").filter((line) => /^##+ /.test(line));
  return releaseSections(changelog)
    .filter(({ body }) => NEEDS_UPGRADE_NOTES.test(body))
    .map(({ version }) => version)
    .filter(
      (version) =>
        !headings.some((h) =>
          new RegExp(
            `(^|[^\\d.])${version.replaceAll(".", "\\.")}($|[^\\d.])`,
          ).test(h),
        ),
    );
}

test("docs/upgrading.md has a heading for every changelog release that mentions hashes or breaking changes", () => {
  const missing = missingUpgradeHeadings(
    readText("CHANGELOG.md"),
    readText("docs/upgrading.md"),
  );
  assert.deepEqual(
    missing,
    [],
    `docs/upgrading.md needs a heading for: ${missing.join(", ")}`,
  );
});

test("a release section that mentions hashes needs an upgrading heading, one that does not is exempt", () => {
  const changelog = [
    "## [Unreleased]\n\n- hashes change\n",
    "## [2.0.0] - 2026-01-01\n\n- Breaking: flag removed\n",
    "## [1.1.0] - 2025-01-01\n\n- MCP tool hashes change\n",
    "## [1.0.0] - 2024-01-01\n\n- First release\n",
  ].join("\n");
  assert.deepEqual(
    releaseSections(changelog).map((s) => s.version),
    ["2.0.0", "1.1.0", "1.0.0"],
  );
  assert.deepEqual(missingUpgradeHeadings(changelog, "## Unreleased\n"), [
    "2.0.0",
    "1.1.0",
  ]);
  assert.deepEqual(
    missingUpgradeHeadings(changelog, "## 2.0.0\n\n### 1.1.0 notes\n"),
    [],
  );
  assert.deepEqual(
    missingUpgradeHeadings(changelog, "## 12.0.0\n## 1.1.01\n"),
    ["2.0.0", "1.1.0"],
  );
});

test("the real changelog requires 0.3.0 and not 0.2.0", () => {
  const needing = releaseSections(readText("CHANGELOG.md"))
    .filter(({ body }) => NEEDS_UPGRADE_NOTES.test(body))
    .map(({ version }) => version);
  assert.ok(needing.includes("0.3.0"));
  assert.ok(!needing.includes("0.2.0"));
});

test("Node.js range in upgrading.md matches engines.node", () => {
  const match = readText("docs/upgrading.md").match(
    /The supported Node\.js range is `([^`]+)`/,
  );
  assert.ok(match, "upgrading.md must state the Node.js range in backticks");
  assert.equal(match[1], enginePkg.engines.node);
});

test("README.md and publishing.md link docs/upgrading.md", () => {
  assert.ok(readText("README.md").includes("docs/upgrading.md"));
  assert.ok(publishingMd.includes("upgrading.md"));
  assert.ok(readText("docs/README.md").includes("upgrading.md"));
});
