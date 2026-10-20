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
