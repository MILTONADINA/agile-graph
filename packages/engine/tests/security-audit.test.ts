import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import { checked, hash, writeJson } from "../src/util.js";
import { stoppedAtReview } from "../src/overview.js";
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
  it("never reports confirmed: a verifier's static trace is needs_validation with its full trace and expected result", () => {
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
    } = {},
  ) {
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
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => ({
        model: "fixture",
        proposal: {
          summary: "Fix addition",
          requests: [],
          changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
        },
        usage,
      }),
      verify: async (_workspace, checks, _policy, snapshotHash) =>
        checks.map((check) => ({
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
    return { root, data, config, engine, run, hunter, verifier };
  }

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
    expect(result.counts).not.toHaveProperty("confirmed");
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
});
