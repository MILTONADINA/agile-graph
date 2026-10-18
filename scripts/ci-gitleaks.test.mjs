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
