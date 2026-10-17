// The published packages: their metadata, license files, optional peers and
// the exact files each tarball holds, and the release workflow's safeguards.
// Run after npm run build. It copies the dashboard and scanner files into the
// engine package as its prepack does, without rebuilding dist.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = async (directory) =>
  JSON.parse(await read(`${directory}/package.json`));
const GITHUB = "git+https://github.com/MILTONADINA/agile-graph.git";
const OPTIONAL_PEERS = ["@cursor/sdk", "@huggingface/transformers"];

function packed(workspace) {
  const [result] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--workspace",
        workspace,
      ],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  return result.files.map((file) => file.path).sort();
}

test("both packages are public, MIT-licensed and point at this repository", async () => {
  const contracts = await manifest("packages/contracts");
  const engine = await manifest("packages/engine");
  for (const [directory, value] of [
    ["packages/contracts", contracts],
    ["packages/engine", engine],
  ]) {
    assert.equal(value.private, undefined, `${directory} must be publishable`);
    assert.equal(value.license, "MIT");
    assert.equal(value.author, "Milton Adina");
    // npm trusted publishing requires this URL to match the repository.
    assert.deepEqual(value.repository, {
      type: "git",
      url: GITHUB,
      directory,
    });
    assert.deepEqual(value.engines, { node: "^22.14.0 || >=24 <27" });
    assert.deepEqual(value.publishConfig, { access: "public" });
    assert.ok(value.description && value.files?.length);
  }
  assert.equal(contracts.version, engine.version);
  assert.equal(
    engine.dependencies["@agile-graph/contracts"],
    contracts.version,
  );
  assert.equal((await manifest("packages/dashboard")).private, true);
  assert.equal((await manifest(".")).private, true);
});

test("each package carries the repository's license, and the engine its notice", async () => {
  const license = await read("LICENSE");
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Milton Adina\n/);
  assert.equal(await read("packages/contracts/LICENSE"), license);
  assert.equal(await read("packages/engine/LICENSE"), license);
  assert.equal(await read("packages/engine/NOTICE"), await read("NOTICE"));
});

test("heavy integrations are optional peers, never installed for everyone", async () => {
  const engine = await manifest("packages/engine");
  for (const name of OPTIONAL_PEERS) {
    assert.equal(engine.dependencies[name], undefined, name);
    assert.ok(engine.peerDependencies[name], name);
    assert.deepEqual(engine.peerDependenciesMeta[name], { optional: true });
  }
});

test("a release tag names the packages' version", async (t) => {
  const tag = process.env.GRAPH_ENGINE_RELEASE_TAG;
  if (!tag) return t.skip("no release tag");
  assert.equal(tag, `v${(await manifest("packages/engine")).version}`);
});

test("the contracts tarball holds only its compiled code, README and license", () => {
  assert.deepEqual(packed("packages/contracts"), [
    "LICENSE",
    "README.md",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
  ]);
});

test("the engine tarball holds its compiled code and runtime files, never sources or tests", () => {
  // npm pack runs the full prepack, a clean rebuild of dist; this copies only
  // the dashboard and scanner files, so it can run beside tests that use dist.
  execFileSync(
    "node",
    ["packages/engine/scripts/prepack.mjs", "--assets-only"],
    {
      cwd: repository,
      stdio: "inherit",
    },
  );
  const files = packed("packages/engine");
  const allowed = [
    /^dist\/.+\.(js|d\.ts)$/,
    /^dist\/build-source\.json$/,
    /^dashboard\//,
    /^scanner\/Dockerfile$/,
    /^security\/dart-analyzer-seccomp\.json$/,
    /^vendor\/cloudflare-security-audit\//,
    /^(README\.md|LICENSE|NOTICE|package\.json)$/,
  ];
  for (const file of files)
    assert.ok(
      allowed.some((pattern) => pattern.test(file)),
      `unexpected file in the engine tarball: ${file}`,
    );
  for (const file of [
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/build-source.json",
    "dashboard/index.html",
    "scanner/Dockerfile",
    "security/dart-analyzer-seccomp.json",
    "vendor/cloudflare-security-audit/LICENSE",
    "vendor/cloudflare-security-audit/report-schema.json",
    "vendor/cloudflare-security-audit/validate-findings.cjs",
    "vendor/cloudflare-security-audit/validate-coverage-ledger.cjs",
    "README.md",
    "LICENSE",
    "NOTICE",
  ])
    assert.ok(files.includes(file), `missing from the engine tarball: ${file}`);
  assert.ok(!files.some((file) => /^dist\/.*template/.test(file)));
});

test("the release workflow publishes only reviewed commits from main, without a stored token", async () => {
  const workflow = await read(".github/workflows/release.yml");
  assert.match(workflow, /^\s+id-token: write$/m);
  assert.match(workflow, /^\s+environment: npm$/m);
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/,
  );
  assert.doesNotMatch(workflow, /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.match(workflow, /node --test scripts\/npm-packages\.test\.mjs/);
  assert.match(workflow, /node scripts\/npm-smoke\.mjs/);
});
