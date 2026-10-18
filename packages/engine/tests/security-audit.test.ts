import { afterEach, describe, expect, it, vi } from "vitest";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ProjectConfig } from "@agile-graph/contracts";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import { checked, hash, writeJson } from "../src/util.js";
import { viewing } from "./worker-view.js";
import { inputTokenCeiling, tokensForBytes } from "../src/tokens.js";
import { stoppedAtReview } from "../src/overview.js";
import { workspaceFingerprint } from "../src/execution/workspace.js";
import type { VerificationResult } from "../src/execution/docker.js";
import {
  DID_NOT_RUN_MARKERS,
  judgeReproducer,
  validateReproducer,
  type AuditReproducer,
  type ReproducerContext,
  type ReproducerRun,
} from "../src/security/reproducer.js";
import {
  assertVendoredPins,
  auditRecord,
  AuditNotSentError,
  candidateFingerprint,
  HUNTER_INSTRUCTIONS,
  huntSchema,
  invokeSecurityHunter,
  invokeSecurityVerifier,
  STATIC_TRACE_BLOCKER,
  validateFindings,
  vendoredPath,
  VERIFIER_INSTRUCTIONS,
  type AuditCandidate,
  type AuditVerification,
} from "../src/security/audit.js";

// The engine's pin check, passed through to the real one unless a test makes
// it refuse, to show it runs before anything else in an audit.
vi.mock("../src/security/audit.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/security/audit.js")>();
  return { ...actual, assertVendoredPins: vi.fn(actual.assertVendoredPins) };
});

const roots: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const candidate = (
  overrides: Partial<AuditCandidate> = {},
): AuditCandidate => ({
  attack_class: "injection",
  title: "Shell command built from input",
  description: "add() passes its argument to a shell.",
  claimed_root_cause: "The argument is interpolated into a shell command.",
  file: "math.cjs",
  line: 1,
  trace: [],
  ...overrides,
});
const confirmed: AuditVerification = {
  verdict: "confirmed",
  reason: "Nothing escapes the argument.",
  root_cause: "The argument is interpolated into a shell command.",
  intended_behavior: "add() only adds numbers.",
  trace: [
    {
      kind: "entrypoint",
      file: "math.cjs",
      line: 1,
      scope: "add",
      description: "Caller-controlled argument a.",
    },
    {
      kind: "sink",
      file: "math.cjs",
      line: 1,
      scope: "add",
      description: "a reaches execSync.",
    },
  ],
  evidence: [{ file: "math.cjs", line: 1, description: "execSync(a)" }],
  conditions: [
    { kind: "data_state", description: "The caller passes a string." },
  ],
  reproduction: {
    attacker_perspective: "A caller of add().",
    payloads: ["1; id"],
    instructions: ["Call add('1; id', 2)."],
    expected_result: "The shell runs id.",
  },
  remediation: "Do not run a shell; add the numbers.",
  severity: {
    likelihood: { score: "medium", reason: "Callers pass input." },
    impact: { score: "high", reason: "Command execution." },
    overall_severity: "high",
  },
  confidence: { score: "high", reason: "The sink is in the diff." },
  blockers: [],
  validation_plan: null,
};
const rejected: AuditVerification = {
  ...confirmed,
  verdict: "rejected",
  reason: "add() never reaches a shell.",
  reproduction: null,
  remediation: null,
  severity: null,
};
const changed = new Set(["math.cjs"]);

describe("audit records", () => {
  it("validates records with Cloudflare's vendored validator and report schema", () => {
    const good = auditRecord(candidate(), rejected, changed);
    expect(good.errors).toEqual([]);
    expect(validateFindings([good.record])).toEqual([]);
    const refuted = auditRecord(candidate(), rejected, changed);
    expect(refuted.errors).toEqual([]);
    expect(refuted.record).toMatchObject({
      verdict: "rejected",
      reason: "add() never reaches a shell.",
      claimed_root_cause: candidate().claimed_root_cause,
    });
    expect(refuted.record).not.toHaveProperty("severity");
    const pending = auditRecord(
      candidate(),
      {
        ...rejected,
        verdict: "needs_validation",
        blockers: ["Whether callers pass strings is not in the diff."],
        validation_plan: "Run add with a string in a local test.",
      },
      changed,
    );
    expect(pending.errors).toEqual([]);
    // Cloudflare's own checks: a trace not starting at an entrypoint and
    // ending at a sink, and a file outside the audited change, are refused.
    expect(
      auditRecord(
        candidate(),
        { ...confirmed, trace: [confirmed.trace[1]!, confirmed.trace[0]!] },
        changed,
      ).errors,
    ).not.toEqual([]);
    expect(
      auditRecord(candidate({ file: "../etc/passwd" }), rejected, changed)
        .errors,
    ).not.toEqual([]);
    expect(
      auditRecord(
        candidate(),
        {
          ...rejected,
          evidence: [{ file: "other.cjs", line: 2, description: "elsewhere" }],
        },
        changed,
      ).errors.join(" "),
    ).toContain("did not touch");
    // The document must be sorted and free of duplicates.
    expect(validateFindings([good.record, good.record])).not.toEqual([]);
  });
});

describe("statically traced findings", () => {
  it("reports a static trace as needs_validation with its full trace and expected result", () => {
    const traced = auditRecord(
      candidate(),
      {
        ...confirmed,
        trace: [
          confirmed.trace[0]!,
          {
            kind: "propagation",
            file: "math.cjs",
            line: 1,
            scope: "add",
            description: "a is interpolated into a command string.",
          },
          confirmed.trace[1]!,
        ],
      },
      changed,
    );
    expect(traced.errors).toEqual([]);
    expect(traced.record.verdict).toBe("needs_validation");
    expect(traced.record).toMatchObject({
      fingerprint: candidateFingerprint(candidate()),
      claimed_root_cause: confirmed.root_cause,
      blockers: [STATIC_TRACE_BLOCKER],
    });
    expect(
      (traced.record.trace as { kind: string }[]).map((entry) => entry.kind),
    ).toEqual(["entrypoint", "propagation", "sink"]);
    const plan = (traced.record.validation_plan as { local: string }).local;
    expect(plan).toContain("Nothing was executed");
    expect(plan).toContain("Expected result: The shell runs id.");
    expect(plan).toContain("Payloads: 1; id");
    // Fields Cloudflare reserves for a demonstrated finding are absent.
    for (const field of ["execution", "severity", "remediation", "root_cause"])
      expect(traced.record).not.toHaveProperty(field);
    expect(validateFindings([traced.record])).toEqual([]);
    // Without a reproduction the record still needs a local plan.
    const bare = auditRecord(
      candidate(),
      { ...confirmed, reproduction: null, severity: null },
      changed,
    );
    expect(bare.errors).toEqual([]);
    expect(bare.record.verdict).toBe("needs_validation");
  });
});

const reproducer: AuditReproducer = {
  path: "math.test.cjs",
  content:
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./math.cjs');\ntest('add', () => assert.equal(add(2, 3), 5, ['injected', 'command', 'ran'].join(' ')));\n",
  argv: ["node", "--test", "math.test.cjs"],
  image: null,
  expected: "injected command ran",
};
const sandboxResult = (
  overrides: Partial<VerificationResult> = {},
): VerificationResult => ({
  argv: reproducer.argv,
  image: "node:24-alpine",
  imageId: `sha256:${"b".repeat(64)}`,
  code: 1,
  stdout: "not ok 1 - add\n  injected command ran\n",
  stderr: "",
  snapshotHash: "snapshot",
  ...overrides,
});
const demonstrated: ReproducerRun = {
  outcome: "demonstrated",
  note: "The reproducer failed with exit code 1 and the expected failure text.",
  path: reproducer.path,
  argv: reproducer.argv,
  expected: reproducer.expected,
  image: "node:24-alpine",
  imageId: `sha256:${"b".repeat(64)}`,
  snapshotHash: "snapshot-hash",
  exitCode: 1,
  excerpt: "not ok 1 - add\n  injected command ran",
};

describe("audit reproducer demonstration", () => {
  it("confirms only a demonstrated failure: a non-zero exit with the expected signal and no did-not-run marker", () => {
    expect(
      judgeReproducer([sandboxResult()], reproducer.expected),
    ).toMatchObject({
      outcome: "demonstrated",
      exitCode: 1,
      imageId: `sha256:${"b".repeat(64)}`,
    });
    // Line endings are normalized and stderr counts too.
    expect(
      judgeReproducer(
        [
          sandboxResult({
            stdout: "",
            stderr: "AssertionError:\r\n  injected\r\ncommand ran",
          }),
        ],
        "injected\ncommand ran",
      ).outcome,
    ).toBe("demonstrated");
    const confirmedRecord = auditRecord(
      candidate(),
      { ...confirmed, reproducer },
      changed,
      demonstrated,
    );
    expect(confirmedRecord.errors).toEqual([]);
    expect(confirmedRecord.record.verdict).toBe("confirmed");
    // Only a verifier-confirmed trace can be confirmed by a reproducer.
    expect(
      auditRecord(
        candidate(),
        {
          ...rejected,
          verdict: "needs_validation",
          blockers: ["A caller is not shown."],
          validation_plan: "Run add with a string.",
        },
        changed,
        demonstrated,
      ).record.verdict,
    ).toBe("needs_validation");
    // A demonstration the verifier gave no remediation for stays
    // needs_validation, saying what is missing.
    const partial = auditRecord(
      candidate(),
      { ...confirmed, remediation: null },
      changed,
      demonstrated,
    );
    expect(partial.errors).toEqual([]);
    expect(partial.record.verdict).toBe("needs_validation");
    expect((partial.record.blockers as string[]).join(" ")).toContain(
      "needs the verifier's remediation",
    );
  });

  it("keeps needs_validation when the reproducer passes, cannot start, errors before running, times out or misses the signal", () => {
    const judge = (overrides: Partial<VerificationResult>) =>
      judgeReproducer([sandboxResult(overrides)], reproducer.expected);
    expect(judge({ code: 0 })).toMatchObject({
      outcome: "not_demonstrated",
      note: expect.stringContaining("passed"),
    });
    for (const code of [125, 126, 127])
      expect(judge({ code }).note).toContain("could not start");
    expect(judge({ code: 137 }).note).toContain("killed");
    for (const marker of DID_NOT_RUN_MARKERS)
      expect(
        judge({ stdout: `${marker}\ninjected command ran\n` }).outcome,
      ).toBe("not_demonstrated");
    expect(
      judge({
        stdout: "",
        stderr:
          "file:///workspace/math.test.cjs:1\nSyntaxError: Unexpected token\ninjected command ran",
      }).note,
    ).toContain("errored before its test ran");
    expect(
      judge({ stdout: "not ok 1 - add\n  expected 5, got -1\n" }).note,
    ).toContain("not with the expected failure text");
    // No result, or more than one, is never a demonstration.
    expect(judgeReproducer([], reproducer.expected).outcome).toBe("error");
    expect(
      judgeReproducer([sandboxResult(), sandboxResult()], reproducer.expected)
        .outcome,
    ).toBe("error");
    // Each such outcome is recorded as needs_validation with a blocker.
    const missed: ReproducerRun = {
      ...demonstrated,
      outcome: "not_demonstrated",
      note: "The reproducer passed (exit code 0), so nothing failed.",
      exitCode: 0,
    };
    const record = auditRecord(candidate(), confirmed, changed, missed);
    expect(record.errors).toEqual([]);
    expect(record.record.verdict).toBe("needs_validation");
    expect(record.record.blockers).toEqual([
      STATIC_TRACE_BLOCKER,
      "Reproducer not demonstrated: The reproducer passed (exit code 0), so nothing failed.",
    ]);
    expect(
      (record.record.validation_plan as { local: string }).local,
    ).toContain("The sandboxed reproducer did not demonstrate");
  });

  it("fills a confirmed record's execution evidence from what ran", () => {
    const { record, errors } = auditRecord(
      candidate(),
      { ...confirmed, reproducer },
      changed,
      demonstrated,
    );
    expect(errors).toEqual([]);
    expect(validateFindings([record])).toEqual([]);
    expect(record).toMatchObject({
      verdict: "confirmed",
      root_cause: confirmed.root_cause,
      intended_behavior: confirmed.intended_behavior,
      conditions: confirmed.conditions,
      remediation: { strategy: confirmed.remediation },
      severity: confirmed.severity,
      confidence: confirmed.confidence,
    });
    const execution = record.execution as {
      attacker_perspective: string;
      payloads: string[];
      instructions: string[];
      observed_result: string;
    };
    expect(execution.attacker_perspective).toBe(
      confirmed.reproduction!.attacker_perspective,
    );
    expect(execution.payloads).toEqual(["1; id"]);
    const ran = execution.instructions.at(-1)!;
    for (const fact of [
      "node --test math.test.cjs",
      "node:24-alpine",
      `sha256:${"b".repeat(64)}`,
      "--network=none",
      "snapshot-hash",
      "math.test.cjs",
    ])
      expect(ran).toContain(fact);
    for (const fact of [
      "Exit code 1",
      '"injected command ran"',
      `Image ID sha256:${"b".repeat(64)}`,
      "Output excerpt (redacted): not ok 1 - add",
    ])
      expect(execution.observed_result).toContain(fact);
    // Fields Cloudflare forbids on a confirmed record are absent.
    for (const field of [
      "claimed_root_cause",
      "blockers",
      "validation_plan",
      "reason",
    ])
      expect(record).not.toHaveProperty(field);
    // A reproduction without payloads names the reproducer as its payload.
    const bare = auditRecord(
      candidate(),
      {
        ...confirmed,
        reproduction: { ...confirmed.reproduction!, payloads: [] },
      },
      changed,
      demonstrated,
    );
    expect(bare.errors).toEqual([]);
    expect((bare.record.execution as { payloads: string[] }).payloads).toEqual([
      "math.test.cjs",
    ]);
  });
});

describe("audit reproducer validation", () => {
  const context = (
    overrides: Partial<ReproducerContext> = {},
  ): ReproducerContext => ({
    policy: DEFAULT_POLICY,
    testFiles: ["**/*.test.*", "**/tests/**"],
    changedFiles: ["src/math.cjs"],
    existingFiles: new Set(["src/math.cjs", "src/old.test.cjs"]),
    verification: [
      { image: "node:24-alpine", argv: ["npm", "test"] },
      { image: "toy-lint", argv: ["lint"], optional: true },
    ],
    cloud: false,
    ...overrides,
  });
  const valid: AuditReproducer = {
    ...reproducer,
    path: "src/math.test.cjs",
    argv: ["node", "--test", "src/math.test.cjs"],
  };

  it("refuses invalid reproducers before running them", () => {
    expect(validateReproducer(valid, context())).toEqual({
      ok: true,
      image: "node:24-alpine",
    });
    expect(
      validateReproducer({ ...valid, image: "toy-lint" }, context()),
    ).toEqual({ ok: true, image: "toy-lint" });
    const refused = (
      change: Partial<AuditReproducer>,
      reason: string,
      overrides: Partial<ReproducerContext> = {},
    ) => {
      const result = validateReproducer(
        { ...valid, ...change },
        context(overrides),
      );
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain(reason);
    };
    const pathCase = (file: string, reason: string) =>
      refused({ path: file, argv: ["node", "--test", file] }, reason);
    pathCase("../escape.test.cjs", "not a safe relative project path");
    pathCase("src/../escape.test.cjs", "not a safe relative project path");
    pathCase("/tmp/escape.test.cjs", "not a safe relative project path");
    pathCase("src\\math.test.cjs", "not a safe relative project path");
    pathCase(".env.test.js", "not a safe relative project path");
    pathCase(".graph/run.test.js", "not a safe relative project path");
    pathCase("src/math.cjs", "does not match the project's test file globs");
    pathCase("docs/math.test.cjs", "outside the area the run changed");
    pathCase("src/old.test.cjs", "already exists");
    refused({ content: "  \n" }, "content is empty");
    refused({ content: "x".repeat(65_537) }, "larger than 65536 bytes");
    refused({ content: "test\0" }, "NUL byte");
    refused({ argv: [] }, "1 to 32 arguments");
    refused(
      { argv: [...Array(32).fill("x"), "src/math.test.cjs"] },
      "1 to 32 arguments",
    );
    for (const argument of [
      "src/math.test.cjs;id",
      "$(id)",
      "`id`",
      "a|b",
      "a&b",
      "a>b",
      "a b",
      "'quoted'",
      "a\nb",
      "*.test.cjs",
    ])
      refused(
        { argv: ["node", argument, "src/math.test.cjs"] },
        "shell metacharacter",
      );
    refused(
      { argv: ["/bin/sh", "-c", "src/math.test.cjs"] },
      "starts with a shell",
    );
    refused({ argv: ["env", "src/math.test.cjs"] }, "starts with a shell");
    refused(
      { argv: ["node", "--test"] },
      "does not name the reproducer's path",
    );
    refused({ expected: "ab" }, "12 to 500 characters");
    expect(
      validateReproducer({ ...valid, expected: "twelve chars" }, context()).ok,
    ).toBe(true);
    refused({ expected: "eleven char" }, "12 to 500 characters");
    refused({ expected: "x".repeat(501) }, "12 to 500 characters");
    // A signal the runner could echo without the finding is refused.
    refused(
      {
        content:
          "const assert = require('node:assert');\nassert.fail('injected command ran');\n",
      },
      "appears in its content",
    );
    // A crash's code frame echoes a source line holding the signal.
    refused(
      {
        content:
          "const t = require('node:test');\nt('x', () => { undefined.f(); /* injected command ran */ });\n",
      },
      "appears in its content",
    );
    refused(
      {
        content:
          "const assert = require('node:assert');\r\nassert.fail('injected\r\ncommand ran');\r\n",
        expected: "injected\ncommand ran",
      },
      "appears in its content",
    );
    refused({ expected: "src/math.test.cjs" }, "part of its path or argv");
    refused({ expected: "math.test.cjs" }, "part of its path or argv");
    refused(
      {
        argv: [
          "node",
          "--test-name-pattern=injected-command-ran",
          "src/math.test.cjs",
        ],
        expected: "injected-command-ran",
      },
      "part of its path or argv",
    );
    refused({ expected: "SyntaxError: x" }, "load or syntax error");
    refused(
      { image: "attacker/image:latest" },
      "not a registered verification image",
    );
    refused({ image: null }, "no registered verification image", {
      verification: [],
    });
  });

  it("refuses a cloud auditor's reproducer outside the export paths and any reproducer holding a potential secret", () => {
    const cloud = context({
      cloud: true,
      policy: { ...DEFAULT_POLICY, exportPaths: ["src/math.cjs"] },
    });
    expect(validateReproducer(valid, cloud)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("policy.exportPaths"),
    });
    expect(
      validateReproducer(
        valid,
        context({
          cloud: true,
          policy: { ...DEFAULT_POLICY, exportPaths: ["src/**"] },
        }),
      ),
    ).toMatchObject({ ok: true });
    // A local auditor's reproducer needs no export path.
    expect(validateReproducer(valid, context())).toMatchObject({ ok: true });
    const secret = `const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";\n`;
    for (const cloudAuditor of [false, true])
      expect(
        validateReproducer(
          { ...valid, content: secret + valid.content },
          context({
            cloud: cloudAuditor,
            policy: { ...DEFAULT_POLICY, exportPaths: ["src/**"] },
          }),
        ),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("potential secret"),
      });
  });
});

describe("security audit workers", () => {
  const local = { id: "reviewer", kind: "local" as const, model: "m" };
  const policy = { ...DEFAULT_POLICY, providers: ["reviewer"] };
  const reply = (content: unknown) =>
    new Response(
      JSON.stringify({
        model: "auditor-model",
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    );

  it("never lets the hunter verify: it returns candidates only, and each verifier sees one candidate", async () => {
    const sent: Record<string, any>[] = [];
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return sent.length === 1
        ? reply({ candidates: [candidate(), candidate({ line: 2 })] })
        : reply(confirmed);
    });
    const hunt = await invokeSecurityHunter(
      { provider: local, policy, diff: "+execSync(a)" },
      fetch,
    );
    expect(hunt.hunt.candidates).toHaveLength(2);
    expect(sent[0]!.messages[0].content).toBe(HUNTER_INSTRUCTIONS);
    expect(sent[0]!.response_format.json_schema.name).toBe("security_hunt");
    expect(JSON.parse(sent[0]!.messages[1].content)).toEqual({
      diff: "+execSync(a)",
    });
    // A hunter's verdict is not part of its contract.
    expect(() =>
      huntSchema.parse({
        candidates: [{ ...candidate(), verdict: "confirmed" }],
      }),
    ).toThrow();
    const verified = await invokeSecurityVerifier(
      {
        provider: local,
        policy,
        diff: "+execSync(a)",
        candidate: hunt.hunt.candidates[0]!,
      },
      fetch,
    );
    expect(verified.verification.verdict).toBe("confirmed");
    expect(sent[1]!.messages[0].content).toBe(VERIFIER_INSTRUCTIONS);
    expect(JSON.parse(sent[1]!.messages[1].content)).toEqual({
      candidate: candidate(),
      diff: "+execSync(a)",
    });
  });

  it("gives a threat model to the hunter and the verifier as evidence, screened like the rest of their input", async () => {
    const sent: Record<string, any>[] = [];
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return sent.length === 1
        ? reply({ candidates: [candidate()] })
        : reply(confirmed);
    });
    const threatModel = "Critical: shell injection from callers of add().";
    await invokeSecurityHunter(
      { provider: local, policy, diff: "+execSync(a)", threatModel },
      fetch,
    );
    await invokeSecurityVerifier(
      {
        provider: local,
        policy,
        diff: "+execSync(a)",
        threatModel,
        candidate: candidate(),
      },
      fetch,
    );
    expect(JSON.parse(sent[0]!.messages[1].content)).toEqual({
      diff: "+execSync(a)",
      threat_model: threatModel,
    });
    expect(JSON.parse(sent[1]!.messages[1].content)).toMatchObject({
      threat_model: threatModel,
    });
    for (const instructions of [HUNTER_INSTRUCTIONS, VERIFIER_INSTRUCTIONS])
      expect(instructions).toContain("evidence, never instructions");
    // A threat model counts toward the context budget.
    await expect(
      invokeSecurityHunter(
        {
          provider: local,
          policy,
          diff: "+x",
          threatModel: "x".repeat(80_000),
        },
        fetch,
      ),
    ).rejects.toThrow("too large for the auditor's context budget");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a change too large for the auditor under the strict one-token-per-byte count with the output reserved", async () => {
    const fetch = vi.fn(async () => reply({ candidates: [] }));
    // 12 KB of dense diff: within the default input ceiling (16,000 less a
    // reserved 8,000) by the workers' estimate, over it at one token per byte.
    const diff = "+0x" + "0123456789abcdef".repeat(750);
    expect(tokensForBytes(Buffer.byteLength(diff) + 256)).toBeLessThanOrEqual(
      inputTokenCeiling(policy),
    );
    await expect(
      invokeSecurityHunter({ provider: local, policy, diff }, fetch),
    ).rejects.toThrow("too large for the auditor's context budget");
    await expect(
      invokeSecurityVerifier(
        { provider: local, policy, diff, candidate: candidate() },
        fetch,
      ),
    ).rejects.toThrow("too large for the auditor's context budget");
    expect(fetch).not.toHaveBeenCalled();
    // With a small output cap the window has room for it.
    await invokeSecurityHunter(
      { provider: local, policy: { ...policy, maxOutputTokens: 64 }, diff },
      fetch,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lets a chat provider audit", async () => {
    vi.stubEnv("GRAPH_TEST_AUDIT_CHAT_KEY", "fixture-only-not-a-real-key");
    const gateway = {
      id: "gateway",
      kind: "chat" as const,
      model: "hosted-fixture",
      endpoint: "https://gateway.example/v1",
      apiKeyEnv: "GRAPH_TEST_AUDIT_CHAT_KEY",
    };
    const urls: string[] = [];
    const hunt = await invokeSecurityHunter(
      {
        provider: gateway,
        policy: {
          ...DEFAULT_POLICY,
          providers: ["gateway"],
          inference: "allowlisted",
          network: "allowlisted",
          allowedHosts: ["gateway.example"],
        },
        diff: "+execSync(a)",
      },
      async (url) => {
        urls.push(url);
        return reply({ candidates: [candidate()] });
      },
    );
    expect(hunt.hunt.candidates).toHaveLength(1);
    expect(urls).toEqual(["https://gateway.example/v1/chat/completions"]);
  });

  it("refuses secrets for cloud auditors, oversized changes and installed agents", async () => {
    const fetch = vi.fn();
    vi.stubEnv("GRAPH_TEST_AUDIT_KEY", "test-key-value");
    const cloud = {
      id: "cloud",
      kind: "openai" as const,
      model: "m",
      apiKeyEnv: "GRAPH_TEST_AUDIT_KEY",
    };
    const cloudPolicy = {
      ...DEFAULT_POLICY,
      providers: ["cloud"],
      inference: "allowlisted" as const,
      network: "allowlisted" as const,
      allowedHosts: ["api.openai.com"],
    };
    const secret = `+const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`;
    await expect(
      invokeSecurityHunter(
        { provider: cloud, policy: cloudPolicy, diff: secret },
        fetch,
      ),
    ).rejects.toThrow("a cloud auditor cannot receive it");
    await expect(
      invokeSecurityVerifier(
        {
          provider: cloud,
          policy: cloudPolicy,
          diff: "+x",
          candidate: candidate({ description: secret }),
        },
        fetch,
      ),
    ).rejects.toThrow("a cloud auditor cannot receive it");
    await expect(
      invokeSecurityHunter(
        {
          provider: cloud,
          policy: cloudPolicy,
          diff: "+x",
          threatModel: secret,
        },
        fetch,
      ),
    ).rejects.toThrow("a cloud auditor cannot receive it");
    await expect(
      invokeSecurityHunter(
        { provider: local, policy, diff: "+x\n".repeat(20_000) },
        fetch,
      ),
    ).rejects.toThrow("too large for the auditor's context budget");
    await expect(
      invokeSecurityHunter(
        {
          provider: { id: "reviewer", kind: "claude", model: "m" },
          policy,
          diff: "+x",
        },
        fetch,
      ),
    ).rejects.toThrow("installed agents cannot audit");
    // Each is refused before sending, so the audit can give back its
    // reservation.
    await expect(
      invokeSecurityHunter(
        { provider: local, policy, diff: "+x\n".repeat(20_000) },
        fetch,
      ),
    ).rejects.toBeInstanceOf(AuditNotSentError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("security audit of a run", () => {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  };
  type Review =
    NonNullable<EngineDependencies["review"]> extends (
      ...args: never[]
    ) => Promise<infer R>
      ? R extends { review: infer V }
        ? V
        : never
      : never;
  const approve: Review = {
    verdict: "approve",
    summary: "Looks right",
    criteria: [{ criterion: "2 + 3 is 5", met: "yes", evidence: "a + b" }],
    findings: [],
  };
  const changes: Review = { ...approve, verdict: "request-changes" };

  async function finishedRun(
    options: {
      review?: Review;
      configure?: (config: ProjectConfig) => void;
      hunter?: EngineDependencies["securityHunter"];
      verifier?: EngineDependencies["securityVerifier"];
      providers?: Parameters<typeof configureProvider>[1][];
      /** The sandbox for an audit reproducer, a call with added files. */
      reproduce?: NonNullable<EngineDependencies["verify"]>;
      /** The run creates a file in one call instead of reading then editing. */
      creates?: boolean;
    } = {},
  ) {
    // Docker is up for the run; a test may take it away before an audit.
    const state = { docker: true };
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-audit-"));
    roots.push(root);
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
    await checked("git", ["config", "core.autocrlf", "false"], { cwd: root });
    await checked("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    await writeFile(
      path.join(root, "math.cjs"),
      "exports.add = (a, b) => a - b;\n",
    );
    const config = await initializeProject(root);
    config.policy.providers = ["local", "reviewer"];
    config.policy.maxAttempts = 1;
    config.verification = [
      { image: "node:24-alpine", argv: ["node", "-e", "0"] },
    ];
    config.review = { providerId: "reviewer" };
    options.configure?.(config);
    await writeJson(path.join(root, PROJECT_FILE), config);
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "test: initial fixture"], {
      cwd: root,
    });
    const data = projectDataDir(config.projectId);
    roots.push(data);
    for (const id of ["local", "reviewer"])
      await configureProvider(data, {
        id,
        kind: "local",
        model: "fixture",
        endpoint: "http://127.0.0.1:11434/v1",
      });
    for (const provider of options.providers ?? [])
      await configureProvider(data, provider);
    const hunter = vi.fn(
      options.hunter ??
        (async () => ({
          hunt: { candidates: [candidate()] },
          model: "auditor",
          usage,
        })),
    );
    const verifier = vi.fn(
      options.verifier ??
        (async () => ({ verification: confirmed, model: "auditor", usage })),
    );
    const reproduce = vi.fn(
      options.reproduce ??
        (async () => {
          throw new Error("No reproducer sandbox in this test");
        }),
    );
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => state.docker,
      worker: (options.creates
        ? (fn: Parameters<typeof viewing>[1]) => fn
        : (fn: Parameters<typeof viewing>[1]) => viewing(["math.cjs"], fn))(
        async () => ({
          model: "fixture",
          proposal: {
            summary: "Fix addition",
            requests: [],
            changes: options.creates
              ? [{ path: "added.cjs", before: null, after: "exports.x = 1;\n" }]
              : [{ path: "math.cjs", before: "a - b", after: "a + b" }],
          },
          usage,
        }),
      ),
      verify: async (workspace, checks, policy, snapshotHash, signal, extra) =>
        extra?.added
          ? reproduce(workspace, checks, policy, snapshotHash, signal, extra)
          : checks.map((check) => ({
              ...check,
              code: 0,
              stdout: "passed",
              stderr: "",
              snapshotHash,
            })),
      review: async () => ({
        review: options.review ?? approve,
        model: "reviewer",
        usage,
      }),
      securityHunter: hunter,
      securityVerifier: verifier,
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["2 + 3 is 5"],
    });
    const run = await engine.wait(
      (await engine.start(plan.id, { approvedByPerson: true })).id,
    );
    return {
      root,
      data,
      config,
      engine,
      run,
      hunter,
      verifier,
      reproduce,
      state,
    };
  }

  it("keeps an unknown token count unknown in the audit's usage total", async () => {
    const unknown = { ...usage, inputTokens: null, cachedTokens: null };
    const { engine, run } = await finishedRun({
      verifier: async () => ({
        verification: confirmed,
        model: "auditor",
        usage: unknown,
      }),
    });
    const result = await engine.securityAudit(run.id);
    expect(result.usage).toMatchObject({
      inputTokens: null,
      cachedTokens: null,
      outputTokens: 2,
    });
  });

  it("is advisory only: it records security.audit_completed and never changes the run's status, outcome or review gate", async () => {
    const { engine, run } = await finishedRun();
    expect(run.status).toBe("succeeded");
    const outcomes = engine.store.outcomes(run.id);
    const result = await engine.securityAudit(run.id);
    expect(result).toMatchObject({
      advisory: true,
      providerId: "reviewer",
      files: 1,
      candidates: 1,
      verified: 1,
      counts: { needs_validation: 1, traced: 1, rejected: 0, invalid: 0 },
    });
    // Without a reproducer nothing is demonstrated, so nothing is confirmed.
    expect(result.counts.confirmed).toBe(0);
    expect(result.reproducers).toEqual([]);
    // No threat model in the project is fine.
    expect(result.threatModel).toBeNull();
    expect(result.findings.map((item) => item.verdict)).toEqual([
      "needs_validation",
    ]);
    expect(validateFindings(result.findings)).toEqual([]);
    expect(engine.store.run(run.id).status).toBe("succeeded");
    expect(engine.store.outcomes(run.id)).toEqual(outcomes);
    const completed = engine.store
      .events(run.id)
      .filter((event) => event.type === "security.audit_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data).toMatchObject({
      advisory: true,
      counts: { traced: 1 },
    });
    // A run stopped at code review still stopped there after an audit, and
    // a person can still approve it in the reviewer's place.
    const stopped = await finishedRun({ review: changes });
    expect(stopped.run.status).toBe("failed");
    expect(stoppedAtReview(stopped.engine.store.events(stopped.run.id))).toBe(
      true,
    );
    await stopped.engine.securityAudit(stopped.run.id);
    expect(stopped.engine.store.run(stopped.run.id).status).toBe("failed");
    expect(stoppedAtReview(stopped.engine.store.events(stopped.run.id))).toBe(
      true,
    );
    await expect(
      stopped.engine.approveReview(stopped.run.id, "I reviewed it myself"),
    ).resolves.toBeUndefined();
  });

  it("verifies each candidate in a separate call, at most 10, with verification reserved before the hunt", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      candidate({ line: 1, title: `Candidate ${index}` }),
    );
    const { engine, run, hunter, verifier } = await finishedRun({
      hunter: async () => ({
        hunt: { candidates: [...many, many[0]!] },
        model: "auditor",
        usage,
      }),
      verifier: async (input) => ({
        verification:
          input.candidate.title === "Candidate 0" ? confirmed : rejected,
        model: "auditor",
        usage,
      }),
    });
    const result = await engine.securityAudit(run.id);
    expect(hunter).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(10);
    // Each verifier call carries exactly one candidate: no verdict is ever
    // taken from the hunter.
    expect(verifier.mock.calls.map(([input]) => input.candidate.title)).toEqual(
      many.slice(0, 10).map((item) => item.title),
    );
    expect(result).toMatchObject({
      candidates: 12,
      verified: 10,
      unverified: 2,
      counts: { needs_validation: 1, traced: 1, rejected: 9 },
    });
    const fingerprints = result.findings.map((item) => item.fingerprint);
    expect(fingerprints).toEqual([...fingerprints].sort());
    const started = engine.store
      .events(run.id)
      .find((event) => event.type === "security.audit_started");
    expect(started?.data.verifierCallsReserved).toBe(10);

    // Under a tighter turn budget the verification still comes first: the
    // hunt gets one call and verification the rest, and no candidate
    // beyond them is verified.
    const tight = await finishedRun({
      configure: (config) => {
        config.policy.maxTurns = 4;
      },
      hunter: async () => ({
        hunt: { candidates: many },
        model: "auditor",
        usage,
      }),
      verifier: async () => ({
        verification: rejected,
        model: "auditor",
        usage,
      }),
    });
    const limited = await tight.engine.securityAudit(tight.run.id);
    expect(limited).toMatchObject({ verified: 3, unverified: 9 });
    expect(tight.verifier).toHaveBeenCalledTimes(3);
    // A budget with no room for a verification refuses before hunting.
    const none = await finishedRun({
      creates: true,
      configure: (config) => {
        config.policy.maxTurns = 1;
      },
    });
    await expect(none.engine.securityAudit(none.run.id)).rejects.toThrow(
      "reached the turn limit, policy.maxTurns (1 model calls a day), leaving no room for a hunt and one verification",
    );
    expect(none.hunter).not.toHaveBeenCalled();
    // A cost cap names the cost cap, not the turn limit.
    const priced = await finishedRun({
      providers: [
        {
          id: "auditor",
          kind: "local",
          model: "fixture",
          endpoint: "http://127.0.0.1:11434/v1",
          inputCostPerMillion: 1,
          outputCostPerMillion: 1,
        },
      ],
    });
    await writeJson(path.join(priced.root, PROJECT_FILE), {
      ...priced.engine.config,
      audit: { providerId: "auditor" },
      policy: {
        ...priced.engine.config.policy,
        providers: ["local", "reviewer", "auditor"],
        maxCostUsd: 0.000001,
      },
    });
    await expect(priced.engine.securityAudit(priced.run.id)).rejects.toThrow(
      "reached the cost cap, policy.maxCostUsd (0.000001 USD",
    );
    expect(priced.hunter).not.toHaveBeenCalled();
  });

  it("gives back verifier reservations a hunt did not use", async () => {
    const { engine, run } = await finishedRun();
    await engine.securityAudit(run.id);
    // The first audit sent two calls of the day's twelve and gave back its
    // nine unused verifications, so the next reserves nine and its hunt.
    await engine.securityAudit(run.id);
    const reserved = engine.store
      .events(run.id)
      .filter((event) => event.type === "security.audit_started")
      .map((event) => event.data.verifierCallsReserved);
    expect(reserved).toEqual([10, 9]);
  });

  it("refuses a cloud auditor for a change outside the export paths, sending nothing", async () => {
    const { root, data, engine, run, hunter, verifier } = await finishedRun();
    vi.stubEnv("GRAPH_TEST_AUDIT_KEY", "test-key-value");
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "m",
      apiKeyEnv: "GRAPH_TEST_AUDIT_KEY",
    });
    const config = engine.config;
    await writeJson(path.join(root, PROJECT_FILE), {
      ...config,
      review: { providerId: "cloud" },
      policy: {
        ...config.policy,
        providers: ["local", "reviewer", "cloud"],
        inference: "allowlisted",
        network: "allowlisted",
        allowedHosts: ["api.openai.com"],
        exportPaths: ["README.md"],
      },
    });
    await expect(engine.securityAudit(run.id)).rejects.toThrow(
      "paths a cloud auditor may not receive",
    );
    expect(hunter).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "security.audit_refused"),
    ).toHaveLength(1);
    expect(engine.store.run(run.id).status).toBe("succeeded");
  });

  it("gives back the reservation of a call the auditor refused before sending", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("No request may be sent");
    });
    const { root, engine, run } = await finishedRun({
      configure: (config) => {
        // A hunt and one verification a day.
        config.policy.maxTurns = 2;
        config.policy.providers.push("auditor");
        config.audit = { providerId: "auditor" };
      },
      providers: [
        {
          id: "auditor",
          kind: "local",
          model: "fixture",
          endpoint: "http://127.0.0.1:11434/v1",
          maxContextTokens: 512,
        },
      ],
      // The auditor's own context budget refuses the hunt before sending;
      // the reviewer answers.
      hunter: async (input) =>
        input.provider.id === "auditor"
          ? invokeSecurityHunter(input, fetch)
          : { hunt: { candidates: [candidate()] }, model: "auditor", usage },
    });
    await expect(engine.securityAudit(run.id)).rejects.toThrow(
      "too large for the auditor's context budget",
    );
    expect(fetch).not.toHaveBeenCalled();
    // Had the refused hunt kept its reservation, the day's second turn would
    // leave no room for a hunt and a verification.
    const { audit: _audit, ...config } = engine.config;
    await writeJson(path.join(root, PROJECT_FILE), config);
    const result = await engine.securityAudit(run.id);
    expect(result).toMatchObject({ providerId: "reviewer", verified: 1 });
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "security.audit_started")
        .map((event) => event.data.verifierCallsReserved),
    ).toEqual([1, 1]);
  });

  it("uses its own auditor setting, falls back to the reviewer and refuses with neither", async () => {
    const { root, engine, run, hunter } = await finishedRun({
      configure: (config) => {
        config.policy.providers.push("auditor");
        config.audit = { providerId: "auditor" };
      },
      providers: [
        {
          id: "auditor",
          kind: "local",
          model: "fixture",
          endpoint: "http://127.0.0.1:11434/v1",
        },
      ],
    });
    expect(await engine.securityAudit(run.id)).toMatchObject({
      providerId: "auditor",
    });
    expect(hunter.mock.calls[0]![0].provider.id).toBe("auditor");
    // The audit key sits beside the policy, so it never enters a plan's
    // policy hash: a project's plans are unchanged by setting it.
    const { audit: _audit, ...withoutAudit } = engine.config;
    expect(hash(withoutAudit.policy)).toBe(run.plan.policyHash);
    await writeJson(path.join(root, PROJECT_FILE), withoutAudit);
    expect(await engine.securityAudit(run.id)).toMatchObject({
      providerId: "reviewer",
    });
    const { review: _review, ...neither } = withoutAudit;
    await writeJson(path.join(root, PROJECT_FILE), neither);
    await expect(engine.securityAudit(run.id)).rejects.toThrow(
      "Configure a security auditor (graph-engine auditor <providerId>) or a reviewer",
    );
  });

  it("checks the vendored files' pins before anything else", async () => {
    const { root, engine, run, hunter } = await finishedRun();
    const { review: _review, ...neither } = engine.config;
    // Even with no auditor configured, the pin refusal comes first.
    await writeJson(path.join(root, PROJECT_FILE), neither);
    vi.mocked(assertVendoredPins).mockImplementationOnce(() => {
      throw new Error(
        "Vendored Cloudflare audit file validate-findings.cjs does not match its pinned digest",
      );
    });
    await expect(engine.securityAudit(run.id)).rejects.toThrow(
      "does not match its pinned digest",
    );
    expect(hunter).not.toHaveBeenCalled();
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type.startsWith("security.audit")),
    ).toEqual([]);
    expect(assertVendoredPins).toHaveBeenCalled();
    // The real check refuses a tampered copy, naming the file.
    const copy = await mkdtemp(path.join(os.tmpdir(), "graph-audit-pins-"));
    roots.push(copy);
    await cp(path.dirname(vendoredPath("LICENSE")), copy, { recursive: true });
    expect(() => assertVendoredPins(copy)).not.toThrow();
    await writeFile(
      path.join(copy, "validate-findings.cjs"),
      "module.exports = { validateDocument: () => [] };\n",
    );
    expect(() => assertVendoredPins(copy)).toThrow(
      "validate-findings.cjs does not match its pinned digest",
    );
  });

  it("gives the project's threat model to the hunter and every verifier and records its path and sha256", async () => {
    const { root, engine, run, hunter, verifier } = await finishedRun();
    const text = "# Threat model\n\nCritical: shell injection from callers.\n";
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "threat-model.md"), text);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const result = await engine.securityAudit(run.id);
    expect(result.threatModel).toEqual({
      path: "docs/threat-model.md",
      sha256,
    });
    expect(hunter.mock.calls[0]![0].threatModel).toBe(text);
    expect(verifier.mock.calls[0]![0].threatModel).toBe(text);
    const completed = engine.store
      .events(run.id)
      .find((event) => event.type === "security.audit_completed");
    expect(completed?.data.threatModel).toEqual({
      path: "docs/threat-model.md",
      sha256,
    });
    // audit.threatModel takes precedence over the default locations, and a
    // configured one must exist.
    await writeFile(path.join(root, "threat_model.md"), "Root model\n");
    await mkdir(path.join(root, "security"));
    await writeFile(path.join(root, "security", "model.md"), "Configured\n");
    await writeJson(path.join(root, PROJECT_FILE), {
      ...engine.config,
      audit: { threatModel: "security/model.md" },
    });
    expect((await engine.securityAudit(run.id)).threatModel?.path).toBe(
      "security/model.md",
    );
    expect(hunter.mock.calls[1]![0].threatModel).toBe("Configured\n");
    await writeJson(path.join(root, PROJECT_FILE), {
      ...engine.config,
      audit: { threatModel: "security/missing.md" },
    });
    await expect(engine.securityAudit(run.id)).rejects.toThrow(
      "The configured threat model security/missing.md cannot be read",
    );
    expect(hunter).toHaveBeenCalledTimes(2);
  });

  it("refuses a cloud auditor a threat model outside the export paths, sending nothing", async () => {
    const { root, data, engine, run, hunter } = await finishedRun();
    vi.stubEnv("GRAPH_TEST_AUDIT_KEY", "test-key-value");
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "m",
      apiKeyEnv: "GRAPH_TEST_AUDIT_KEY",
    });
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "threat-model.md"), "Private\n");
    const config = engine.config;
    await writeJson(path.join(root, PROJECT_FILE), {
      ...config,
      audit: { providerId: "cloud" },
      policy: {
        ...config.policy,
        providers: ["local", "reviewer", "cloud"],
        inference: "allowlisted",
        network: "allowlisted",
        allowedHosts: ["api.openai.com"],
        // The change is exportable; the threat model is not.
        exportPaths: ["math.cjs"],
      },
    });
    await expect(engine.securityAudit(run.id)).rejects.toThrow(
      "the threat model docs/threat-model.md is outside policy.exportPaths",
    );
    expect(hunter).not.toHaveBeenCalled();
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "security.audit_refused"),
    ).toHaveLength(1);
  });

  const confirmedWith = (proposal: AuditReproducer = reproducer) =>
    (async () => ({
      verification: { ...confirmed, reproducer: proposal },
      model: "auditor",
      usage,
    })) satisfies EngineDependencies["securityVerifier"];
  const sandboxReply =
    (
      overrides: Partial<VerificationResult> = {},
    ): NonNullable<EngineDependencies["verify"]> =>
    async (_workspace, checks, _policy, snapshotHash) =>
      checks.map((check) =>
        sandboxResult({ ...check, snapshotHash, ...overrides }),
      );

  it("runs a verifier's reproducer only through the offline sandbox, with a registered image, on a copy of the run's snapshot", async () => {
    const { root, config, engine, run, hunter, verifier, reproduce } =
      await finishedRun({
        verifier: confirmedWith(),
        reproduce: sandboxReply(),
      });
    const snapshot = await workspaceFingerprint(run.workspace!, config.policy);
    const before = engine.store.events(run.id).length;
    const result = await engine.securityAudit(run.id);
    expect(reproduce).toHaveBeenCalledTimes(1);
    const [workspace, checks, policy, snapshotHash, , extra] =
      reproduce.mock.calls[0]!;
    // The sandbox copies the run's retained workspace into its own temporary
    // view; the checkout is never its source.
    expect(workspace).toBe(run.workspace);
    expect(path.resolve(workspace)).not.toBe(path.resolve(root));
    expect(checks).toEqual([
      { image: "node:24-alpine", argv: reproducer.argv },
    ]);
    expect(extra).toEqual({
      added: [{ path: reproducer.path, content: reproducer.content }],
    });
    expect(snapshotHash).toBe(snapshot);
    // Bounded by the policy timeout even where verification has none.
    expect(policy.verificationTimeoutSeconds).toBe(
      config.policy.verificationTimeoutSeconds ?? config.policy.timeoutSeconds,
    );
    expect(result.counts).toMatchObject({
      confirmed: 1,
      needs_validation: 0,
      traced: 0,
    });
    expect(result.findings.map((item) => item.verdict)).toEqual(["confirmed"]);
    expect(validateFindings(result.findings)).toEqual([]);
    expect(result.reproducers).toEqual([
      expect.objectContaining({
        fingerprint: candidateFingerprint(candidate()),
        outcome: "demonstrated",
        image: "node:24-alpine",
        imageId: `sha256:${"b".repeat(64)}`,
        snapshotHash: snapshot,
        exitCode: 1,
      }),
    ]);
    // Running it costs no model call.
    expect(hunter).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(1);
    // The verifier was told where a reproducer may run.
    expect(verifier.mock.calls[0]![0].sandbox).toEqual({
      images: ["node:24-alpine"],
      testFiles: expect.arrayContaining(["**/*.test.*"]),
    });
    expect(
      engine.store
        .events(run.id)
        .slice(before)
        .map((event) => event.type),
    ).toEqual(["security.audit_started", "security.audit_completed"]);
    // An unregistered image never runs, and neither does a reproducer
    // proposed with a verdict other than confirmed.
    const other = await finishedRun({
      verifier: confirmedWith({ ...reproducer, image: "attacker/image:1" }),
      reproduce: sandboxReply(),
    });
    const refused = await other.engine.securityAudit(other.run.id);
    expect(other.reproduce).not.toHaveBeenCalled();
    expect(refused.reproducers[0]).toMatchObject({
      outcome: "refused",
      note: expect.stringContaining("not a registered verification image"),
    });
    expect(refused.counts).toMatchObject({ confirmed: 0, traced: 1 });
    const skipped = await finishedRun({
      verifier: async () => ({
        verification: {
          ...rejected,
          verdict: "needs_validation",
          blockers: ["A caller is not shown."],
          validation_plan: "Run add with a string.",
          reproducer,
        },
        model: "auditor",
        usage,
      }),
      reproduce: sandboxReply(),
    });
    const notRun = await skipped.engine.securityAudit(skipped.run.id);
    expect(skipped.reproduce).not.toHaveBeenCalled();
    expect(notRun.reproducers[0]?.outcome).toBe("skipped");
  });

  it("never writes the reproducer to the run workspace or the checkout", async () => {
    const seen: boolean[] = [];
    const exists = async (file: string) =>
      access(file).then(
        () => true,
        () => false,
      );
    let workspacePath = "";
    let rootPath = "";
    const { root, config, engine, run } = await finishedRun({
      verifier: confirmedWith(),
      reproduce: async (
        workspace,
        checks,
        policy,
        snapshotHash,
        signal,
        extra,
      ) => {
        seen.push(
          await exists(path.join(workspacePath, reproducer.path)),
          await exists(path.join(rootPath, reproducer.path)),
        );
        return sandboxReply()(
          workspace,
          checks,
          policy,
          snapshotHash,
          signal,
          extra,
        );
      },
    });
    workspacePath = run.workspace!;
    rootPath = root;
    const before = await workspaceFingerprint(run.workspace!, config.policy);
    const result = await engine.securityAudit(run.id);
    expect(result.counts.confirmed).toBe(1);
    expect(seen).toEqual([false, false]);
    expect(await exists(path.join(run.workspace!, reproducer.path))).toBe(
      false,
    );
    expect(await exists(path.join(root, reproducer.path))).toBe(false);
    expect(await workspaceFingerprint(run.workspace!, config.policy)).toBe(
      before,
    );
    // A path that exists in the run's workspace is refused, even when Git
    // ignores it.
    await writeFile(path.join(run.workspace!, "math.test.cjs"), "old\n");
    const again = await engine.securityAudit(run.id);
    expect(again.reproducers[0]).toMatchObject({
      outcome: "refused",
      note: expect.stringContaining("already exists"),
    });
  });

  it("keeps a confirmed finding advisory: the run's status, outcome and review gate are unchanged", async () => {
    const { engine, run } = await finishedRun({
      verifier: confirmedWith(),
      reproduce: sandboxReply(),
    });
    const outcomes = engine.store.outcomes(run.id);
    const result = await engine.securityAudit(run.id);
    expect(result.counts.confirmed).toBe(1);
    expect(result.advisory).toBe(true);
    expect(engine.store.run(run.id).status).toBe("succeeded");
    expect(engine.store.outcomes(run.id)).toEqual(outcomes);
    const stopped = await finishedRun({
      review: changes,
      verifier: confirmedWith(),
      reproduce: sandboxReply(),
    });
    const events = stopped.engine.store.events(stopped.run.id).length;
    const audited = await stopped.engine.securityAudit(stopped.run.id);
    expect(audited.counts.confirmed).toBe(1);
    // Only the audit's own advisory events were added: nothing a gate,
    // status, completion or review reads.
    expect(
      stopped.engine.store
        .events(stopped.run.id)
        .slice(events)
        .map((event) => event.type),
    ).toEqual(["security.audit_started", "security.audit_completed"]);
    expect(stopped.engine.store.run(stopped.run.id).status).toBe("failed");
    expect(stoppedAtReview(stopped.engine.store.events(stopped.run.id))).toBe(
      true,
    );
    await expect(
      stopped.engine.approveReview(stopped.run.id, "I reviewed it myself"),
    ).resolves.toBeUndefined();
  });

  it("keeps needs_validation with a note when Docker is unavailable", async () => {
    const { engine, run, state, reproduce } = await finishedRun({
      verifier: confirmedWith(),
      reproduce: sandboxReply(),
    });
    state.docker = false;
    const result = await engine.securityAudit(run.id);
    expect(reproduce).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({ confirmed: 0, traced: 1 });
    expect(result.reproducers[0]).toMatchObject({
      outcome: "unavailable",
      note: expect.stringContaining("Docker is not available"),
    });
    expect(result.findings[0]!.blockers).toEqual([
      STATIC_TRACE_BLOCKER,
      expect.stringContaining("Docker is not available"),
    ]);
    // A sandbox that times out is an error, never a demonstration.
    state.docker = true;
    reproduce.mockImplementation(async () => {
      throw new Error("Command terminated (timeout or cancellation)");
    });
    const timedOut = await engine.securityAudit(run.id);
    expect(timedOut.counts).toMatchObject({ confirmed: 0, traced: 1 });
    expect(timedOut.reproducers[0]).toMatchObject({
      outcome: "error",
      note: expect.stringContaining("timeout"),
    });
  });

  it("never reproduces on a workspace changed after the audited diff was built", async () => {
    let workspacePath = "";
    const { config, engine, run, reproduce } = await finishedRun({
      // The workspace is edited while the verifier traces the diff: after
      // the diff was built, before the first reproducer.
      verifier: async (...args) => {
        await writeFile(
          path.join(workspacePath, "math.cjs"),
          "exports.add = (a, b) => a + b + 0;\n",
        );
        return confirmedWith()(...args);
      },
      reproduce: sandboxReply(),
    });
    workspacePath = run.workspace!;
    const audited = await workspaceFingerprint(run.workspace!, config.policy);
    const result = await engine.securityAudit(run.id);
    expect(reproduce).not.toHaveBeenCalled();
    expect(result.snapshotHash).toBe(audited);
    expect(await workspaceFingerprint(run.workspace!, config.policy)).not.toBe(
      audited,
    );
    expect(result.counts).toMatchObject({
      confirmed: 0,
      needs_validation: 1,
      traced: 1,
    });
    expect(result.findings.map((item) => item.verdict)).toEqual([
      "needs_validation",
    ]);
    expect(result.reproducers[0]).toMatchObject({
      outcome: "error",
      snapshotHash: audited,
      note: expect.stringContaining(
        "workspace changed since the audited diff was built",
      ),
    });
  });

  it("redacts the reproducer's output before recording it", async () => {
    const token = "Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd";
    const { engine, run } = await finishedRun({
      verifier: confirmedWith(),
      reproduce: sandboxReply({
        stdout: `const serviceToken = "${token}";\ninjected command ran\n`,
      }),
    });
    const result = await engine.securityAudit(run.id);
    expect(result.counts.confirmed).toBe(1);
    const completed = engine.store
      .events(run.id)
      .find((event) => event.type === "security.audit_completed")!;
    expect(JSON.stringify(completed.data)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.reproducers[0]!.excerpt).toContain("[REDACTED]");
    expect(
      (result.findings[0]!.execution as { observed_result: string })
        .observed_result,
    ).toContain("[REDACTED]");
  });
});
