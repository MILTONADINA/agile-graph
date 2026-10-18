import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requiredChecks } from "./branch-protection-policy.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const start = workflow.indexOf("\n  gitleaks:\n");
const rest = workflow.slice(start + 1);
const next = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n/);
const job = start === -1 ? "" : next === -1 ? rest : rest.slice(0, next + 1);

test("CI has a gitleaks job scanning the full history", () => {
  assert.notEqual(start, -1, "gitleaks job is missing");
  assert.match(job, /fetch-depth: 0/);
  assert.match(job, /gitleaks" git /);
});

test("the gitleaks job pins a release version and its SHA-256", () => {
  assert.match(job, /GITLEAKS_VERSION: "\d+\.\d+\.\d+"/);
  assert.match(job, /GITLEAKS_SHA256: "[0-9a-f]{64}"/);
  assert.match(job, /sha256sum -c -/);
  assert.match(job, /releases\/download\/v\$\{GITLEAKS_VERSION\}\//);
  assert.doesNotMatch(job, /gitleaks\/gitleaks-action/);
  assert.doesNotMatch(job, /GITLEAKS_LICENSE/);
});

test("the gitleaks job redacts and fails on findings", () => {
  assert.match(job, /--redact/);
  assert.match(job, /--exit-code 1/);
  assert.doesNotMatch(job, /--exit-code 0|continue-on-error/);
});

test("the gitleaks job stays a non-required check", () => {
  for (const [branch, checks] of Object.entries(requiredChecks))
    assert.ok(!checks.includes("gitleaks"), `${branch} must not require it`);
});

test("the gitleaks job pin matches the scanner Dockerfile pin", () => {
  const docker = readFileSync(
    new URL("../sidecars/security/Dockerfile", import.meta.url),
    "utf8",
  );
  const version = job.match(/GITLEAKS_VERSION: "([^"]+)"/)?.[1];
  const sum = job.match(/GITLEAKS_SHA256: "([0-9a-f]{64})"/)?.[1];
  assert.ok(docker.includes(`GITLEAKS_VERSION=${version}`));
  assert.ok(docker.includes(`GITLEAKS_SHA256_AMD64=${sum}`));
});

test("CI audits production dependencies and fails on high advisories", () => {
  assert.match(
    workflow,
    /^ {6}- name: Audit production dependencies\n(?: {8}if: .*\n)? {8}run: npm audit --omit=dev --audit-level=high$/m,
  );
  assert.doesNotMatch(
    workflow,
    /npm audit[^\n]*(\|\| true|--audit-level=(low|moderate))/,
  );
});

test("the update bot runs weekly for npm and GitHub Actions", () => {
  const bot = readFileSync(
    new URL("../.github/dependabot.yml", import.meta.url),
    "utf8",
  );
  assert.match(bot, /^version: 2$/m);
  for (const eco of ["npm", "github-actions"]) {
    const block = bot
      .split(/^ {2}- /m)
      .find((b) => b.includes(`package-ecosystem: ${eco}\n`));
    assert.ok(block, `${eco} ecosystem is missing`);
    assert.match(block, /directory: "\/"/);
    assert.match(block, /interval: "weekly"/);
    assert.match(block, /groups:\n\s+[\w-]+:\n\s+(update-types|patterns):/);
  }
  const npm = bot.split(/^ {2}- /m).find((b) => b.includes("ecosystem: npm\n"));
  assert.match(npm, /^ {4}open-pull-requests-limit: 5$/m);
  assert.match(bot, /hash-pinned/);
});
