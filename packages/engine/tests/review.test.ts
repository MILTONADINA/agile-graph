import { unwrapUntrusted } from "../src/workers/untrusted.js";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import {
  findingId,
  findingSignature,
  rejectionHistory,
  repeatedSignatures,
  invokeReviewWorker,
  invokeVerifyFix,
  priorBlockingFindings,
  reviewHistoryExportable,
  reviewRecordExportable,
  REVIEW_INSTRUCTIONS,
  reusableFixVerdicts,
  ADVISORY_FEEDBACK_LIMIT,
  ADVISORY_MESSAGE_LIMIT,
  checkScanRulings,
  scanFindingId,
  reviewOutcome,
  VERIFY_FIX_INSTRUCTIONS,
  type WorkerReview,
} from "../src/workers/review.js";
import {
  REVIEW_OUTPUT_TOKENS,
  inputTokenCeiling,
  tokensForBytes,
} from "../src/tokens.js";

const approve: WorkerReview = {
  verdict: "approve",
  summary: "Looks right",
  criteria: [{ criterion: "sum works", met: "yes", evidence: "a + b" }],
  findings: [{ severity: "advisory", path: null, line: null, message: "nit" }],
};

describe("review outcome", () => {
  it("passes only a clean approval", () => {
    expect(reviewOutcome(approve, ["sum works"])).toEqual({
      passed: true,
      feedback: "",
    });
    for (const review of [
      { ...approve, verdict: "request-changes" as const },
      {
        ...approve,
        criteria: [
          { criterion: "sum works", met: "unknown" as const, evidence: "" },
        ],
      },
      {
        ...approve,
        findings: [
          {
            severity: "blocking" as const,
            path: "a.ts",
            line: 3,
            message: "breaks",
          },
        ],
      },
    ])
      expect(reviewOutcome(review, ["sum works"]).passed).toBe(false);
    expect(
      reviewOutcome(
        {
          ...approve,
          criteria: [{ criterion: "sum works", met: "no", evidence: "a - b" }],
        },
        ["sum works"],
      ).feedback,
    ).toContain("Acceptance criterion not met: sum works (a - b)");
    // An approval that skips a criterion, or answers none, is not a pass.
    const empty = reviewOutcome({ ...approve, criteria: [] }, ["sum works"]);
    expect(empty.passed).toBe(false);
    expect(empty.feedback).toContain(
      "The review answered 0 of 1 acceptance criteria",
    );
    expect(reviewOutcome(approve, ["sum works", "tests added"]).passed).toBe(
      false,
    );
  });
});

describe("review findings", () => {
  it("gives each finding a stable ID that ignores whitespace", () => {
    const finding = { path: "a.ts", line: 3, message: "breaks  the\nsum " };
    const id = findingId(finding);
    expect(id).toMatch(/^R[0-9a-f]{10}$/);
    expect(findingId({ ...finding, message: "breaks the sum" })).toBe(id);
    expect(findingId({ ...finding, line: 4 })).not.toBe(id);
    expect(findingId({ ...finding, path: null })).not.toBe(id);
    // Parts are separated, so moving text between them changes the ID.
    expect(findingId({ path: "a.ts3", line: null, message: "x" })).not.toBe(
      findingId({ path: "a.ts", line: 3, message: "x" }),
    );
    // A failing review names each blocking finding by its ID.
    expect(
      reviewOutcome(
        {
          ...approve,
          findings: [{ severity: "blocking", ...finding }],
        },
        ["sum works"],
      ).feedback,
    ).toContain(`Blocking in a.ts:3: breaks  the\nsum  (finding ${id})`);
  });

  it("keeps advisory findings as optional feedback when a review fails", () => {
    const failed = reviewOutcome(
      {
        ...approve,
        verdict: "request-changes",
        findings: [
          { severity: "advisory", path: "a.ts", line: 2, message: "rename x" },
          { severity: "blocking", path: null, line: null, message: "breaks" },
        ],
      },
      ["sum works"],
    );
    expect(failed.passed).toBe(false);
    const lines = failed.feedback.split("\n");
    const heading = lines.indexOf(
      "Optional advisory findings (not required to pass review):",
    );
    expect(heading).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith("Blocking: breaks")),
    );
    expect(lines[heading + 1]).toBe(
      `- Advisory in a.ts:2: rename x (finding ${findingId({ path: "a.ts", line: 2, message: "rename x" })})`,
    );
    // A passing review sends nothing back, advisory findings included.
    expect(reviewOutcome(approve, ["sum works"]).feedback).toBe("");
  });

  it("bounds the optional advisory feedback so it cannot crowd out the required repair", () => {
    const advisory = Array.from({ length: 12 }, (_, index) => ({
      severity: "advisory" as const,
      path: "a.ts",
      line: index + 1,
      message: `suggestion ${index} ${"x".repeat(4000)}`,
    }));
    const failed = reviewOutcome(
      {
        ...approve,
        verdict: "request-changes",
        findings: [
          ...advisory,
          { severity: "blocking", path: null, line: null, message: "breaks" },
        ],
      },
      ["sum works"],
    );
    const lines = failed.feedback.split("\n");
    expect(lines.filter((line) => line.startsWith("- Advisory"))).toHaveLength(
      ADVISORY_FEEDBACK_LIMIT,
    );
    expect(lines).toContain(
      `- and ${12 - ADVISORY_FEEDBACK_LIMIT} more advisory finding(s), omitted`,
    );
    expect(
      Math.max(
        ...lines
          .filter((line) => line.startsWith("- Advisory"))
          .map((line) => line.length),
      ),
    ).toBeLessThan(ADVISORY_MESSAGE_LIMIT + 120);
    expect(failed.feedback).toContain("Blocking: breaks");
  });

  it("reuses only fixed verdicts recorded for the same snapshot", () => {
    const check = (data: Record<string, unknown>) => ({
      type: "review.verify_fix",
      data: { verdict: "fixed", evidence: "gone", snapshotHash: "s1", ...data },
    });
    const reusable = reusableFixVerdicts(
      [
        check({ findingId: "Rsame" }),
        check({ findingId: "Rother", snapshotHash: "s0" }),
        check({ findingId: "Rpresent", verdict: "still_present" }),
        check({ findingId: "Runsure", verdict: "inconclusive" }),
        check({ findingId: "Rlegacy", snapshotHash: undefined }),
        { type: "review.completed", data: { findingId: "Rreview" } },
      ],
      "s1",
    );
    expect([...reusable]).toEqual([["Rsame", "gone"]]);
    expect(
      reusableFixVerdicts([check({ findingId: "Rsame" })], "s2").size,
    ).toBe(0);
  });

  it("re-checks only the blocking findings of the latest AI review that asked for changes", () => {
    const findings = [
      {
        severity: "blocking",
        path: "a.ts",
        line: 1,
        message: "[REDACTED]",
        id: "R0123456789",
      },
      { severity: "advisory", path: null, line: null, message: "nit" },
      { severity: "blocking", path: null, line: null, message: "breaks" },
    ];
    expect(priorBlockingFindings({ passed: false, findings })).toEqual([
      { id: "R0123456789", path: "a.ts", line: 1, message: "[REDACTED]" },
      {
        id: findingId({ path: null, line: null, message: "breaks" }),
        path: null,
        line: null,
        message: "breaks",
      },
    ]);
    expect(priorBlockingFindings({ passed: true, findings })).toEqual([]);
    expect(
      priorBlockingFindings({ passed: true, by: "person", findings }),
    ).toEqual([]);
    expect(priorBlockingFindings(undefined)).toEqual([]);
  });
});

describe("review worker", () => {
  const local = { id: "reviewer", kind: "local" as const, model: "m" };
  const input = (overrides = {}) => ({
    provider: local,
    policy: { ...DEFAULT_POLICY, providers: ["reviewer"] },
    objective: "Fix the sum",
    acceptance: ["sum works"],
    diff: "-a - b\n+a + b",
    checks: "test: exit 0",
    ...overrides,
  });

  it("asks for a structured review and parses it", async () => {
    let sent: Record<string, any> = {};
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: "reviewer-model",
          choices: [{ message: { content: JSON.stringify(approve) } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      );
    });
    const result = await invokeReviewWorker(input(), fetch);
    expect(result.review).toEqual(approve);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(sent.messages[0].content).toBe(REVIEW_INSTRUCTIONS);
    expect(sent.response_format.json_schema.name).toBe("code_review");
    expect(
      JSON.parse(unwrapUntrusted(sent.messages[1].content)!),
    ).toMatchObject({
      diff: "-a - b\n+a + b",
      checks: "test: exit 0",
    });
  });

  it("refuses secrets for cloud reviewers, oversized changes and installed agents", async () => {
    const fetch = vi.fn();
    const cloudPolicy = {
      ...DEFAULT_POLICY,
      providers: ["cloud"],
      inference: "allowlisted" as const,
      network: "allowlisted" as const,
      allowedHosts: ["api.openai.com"],
    };
    await expect(
      invokeReviewWorker(
        input({
          provider: { id: "cloud", kind: "openai", model: "m" },
          policy: cloudPolicy,
          diff: `+const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
        }),
        fetch,
      ),
    ).rejects.toThrow("a cloud reviewer cannot receive it");
    await expect(
      invokeReviewWorker(input({ diff: "+x\n".repeat(20_000) }), fetch),
    ).rejects.toThrow("too large for the reviewer's context budget");
    await expect(
      invokeReviewWorker(
        input({
          provider: { id: "reviewer", kind: "claude", model: "m" },
        }),
        fetch,
      ),
    ).rejects.toThrow("installed agents cannot review yet");
    expect(fetch).not.toHaveBeenCalled();
  });

  const fixInput = (overrides = {}) => ({
    provider: local,
    policy: { ...DEFAULT_POLICY, providers: ["reviewer"] },
    objective: "Fix the sum",
    finding: {
      id: "R0123456789",
      path: "sum.ts",
      line: 1,
      message: "subtracts",
    },
    diff: "-a - b\n+a + b",
    ...overrides,
  });

  it("reserves only a verdict-sized output for review, so an 8 KB diff fits the default policy and the request asks for at most that output", async () => {
    const fetch = vi.fn(
      async (_url: string | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "reviewer-model",
            choices: [{ message: { content: JSON.stringify(approve) } }],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
            request: JSON.parse(String(init?.body ?? "{}")),
          }),
        ),
    );
    // Over the worker ceiling's half-window reservation, under the review's.
    const diff = "+" + "a".repeat(8_000);
    await expect(
      invokeReviewWorker(input({ diff }), fetch),
    ).resolves.toMatchObject({ review: approve });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.max_tokens ?? body.max_output_tokens).toBe(
      REVIEW_OUTPUT_TOKENS,
    );
  });

  it("refuses a change too large for the reviewer under the strict one-token-per-byte count with the output reserved, never truncating it", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "reviewer-model",
            choices: [{ message: { content: JSON.stringify(approve) } }],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
          }),
        ),
    );
    // 12 KB of dense diff: within the default policy's input ceiling by the
    // workers' two-bytes-per-token estimate, but over the gate's ceiling
    // (16,000 less the review's 4,096-token output reservation) at one token
    // per byte, so the gate refuses it.
    const diff = "+0x" + "0123456789abcdef".repeat(750);
    expect(tokensForBytes(Buffer.byteLength(diff) + 256)).toBeLessThanOrEqual(
      inputTokenCeiling(DEFAULT_POLICY),
    );
    await expect(invokeReviewWorker(input({ diff }), fetch)).rejects.toThrow(
      "too large for the reviewer's context budget",
    );
    await expect(invokeVerifyFix(fixInput({ diff }), fetch)).rejects.toThrow(
      "too large for the reviewer's context budget",
    );
    expect(fetch).not.toHaveBeenCalled();
    // The same diff fits once the output reservation is small.
    const roomy = {
      ...DEFAULT_POLICY,
      providers: ["reviewer"],
      maxOutputTokens: 64,
    };
    await expect(
      invokeReviewWorker(input({ diff, policy: roomy }), fetch),
    ).resolves.toMatchObject({ review: approve });
    // ...but not when the output cap would leave too little of the window.
    await expect(
      invokeReviewWorker(
        input({ diff, policy: { ...roomy, maxOutputTokens: 4000 } }),
        fetch,
      ),
    ).rejects.toThrow("too large for the reviewer's context budget");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks one earlier finding in a fresh structured call", async () => {
    let sent: Record<string, any> = {};
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: "reviewer-model",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "fixed",
                  evidence: "now adds",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
    });
    const result = await invokeVerifyFix(fixInput(), fetch);
    expect(result.result).toEqual({ verdict: "fixed", evidence: "now adds" });
    expect(sent.messages[0].content).toBe(VERIFY_FIX_INSTRUCTIONS);
    expect(sent.response_format.json_schema.name).toBe("finding_fix_check");
    // Only that finding, the task and the current diff are sent.
    expect(JSON.parse(unwrapUntrusted(sent.messages[1].content)!)).toEqual({
      task: "Fix the sum",
      finding: { path: "sum.ts", line: 1, message: "subtracts" },
      diff: "-a - b\n+a + b",
    });
  });

  it("refuses the same inputs for a fix check as for a review", async () => {
    const fetch = vi.fn();
    await expect(
      invokeVerifyFix(
        fixInput({
          provider: { id: "cloud", kind: "openai", model: "m" },
          policy: {
            ...DEFAULT_POLICY,
            providers: ["cloud"],
            inference: "allowlisted" as const,
            network: "allowlisted" as const,
            allowedHosts: ["api.openai.com"],
          },
          diff: `+const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
        }),
        fetch,
      ),
    ).rejects.toThrow("a cloud reviewer cannot receive it");
    await expect(
      invokeVerifyFix(fixInput({ diff: "+x\n".repeat(20_000) }), fetch),
    ).rejects.toThrow("too large for the reviewer's context budget");
    await expect(
      invokeVerifyFix(
        fixInput({ provider: { id: "reviewer", kind: "claude", model: "m" } }),
        fetch,
      ),
    ).rejects.toThrow("installed agents cannot review yet");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("finding signature", () => {
  const base = {
    path: "src/a.ts",
    line: 10,
    message: "Missing null check at line 10 in parse()",
  };

  it("ignores line numbers, numbers in the text and whitespace", () => {
    const moved = {
      path: "./src/a.ts",
      line: 42,
      message: "  Missing   null check\nat line 42 in parse()  ",
    };
    expect(findingSignature(moved)).toBe(findingSignature(base));
    expect(findingSignature(base)).toMatch(/^S[0-9a-f]{12}$/);
  });

  it("differs for another file or another message", () => {
    expect(findingSignature({ ...base, path: "src/b.ts" })).not.toBe(
      findingSignature(base),
    );
    expect(
      findingSignature({ ...base, message: "Unused import in parse()" }),
    ).not.toBe(findingSignature(base));
    expect(findingSignature({ ...base, path: null })).not.toBe(
      findingSignature(base),
    );
  });

  it("reads rejections from events and finds the repeats", () => {
    const rejected = (message: string) => ({
      type: "review.completed",
      data: {
        passed: false,
        findings: [{ severity: "blocking", path: "a.ts", line: 3, message }],
      },
    });
    const history = rejectionHistory([
      rejected("Fix 1"),
      { type: "review.completed", data: { by: "person", passed: true } },
      rejected("Other"),
    ]);
    expect(history).toHaveLength(2);
    expect(history[0]![0]!.text).toBe("Fix 1");
    expect(
      repeatedSignatures(history.at(-1)!, [
        {
          signature: findingSignature({
            path: "a.ts",
            line: 9,
            message: "Other",
          }),
        },
      ]),
    ).toHaveLength(1);
    expect(repeatedSignatures(history[0]!, history.at(-1)!)).toHaveLength(0);
    // A rejection with no blocking finding is still a round.
    const gap = rejectionHistory([
      rejected("Same"),
      { type: "review.completed", data: { passed: false, findings: [] } },
      rejected("Same"),
    ]);
    expect(repeatedSignatures(gap[1]!, gap[2]!)).toHaveLength(0);
    // The recorded signature survives a redacted stored message.
    const [kept] = priorBlockingFindings({
      passed: false,
      findings: [
        {
          severity: "blocking",
          path: "a.ts",
          line: 1,
          message: "Remove [REDACTED]",
          signature: "Sabc",
        },
      ],
    });
    expect(kept!.signature).toBe("Sabc");
    // A stop on a repeat breaks the run: a resume compares afresh.
    const resumed = rejectionHistory([
      rejected("Same"),
      { type: "review.repeated_finding", data: {} },
    ]);
    expect(repeatedSignatures(resumed.at(-1)!, history[0]!)).toHaveLength(0);
  });
});

describe("scan rulings", () => {
  const items = [{ id: "Fone" }, { id: "Ftwo" }];
  const ruling = (id: string, kind = "raised", reason = "because") => ({
    id,
    ruling: kind as "raised" | "dropped",
    reason,
  });

  it("derives a stable ID from a fingerprint and a different one for a repeat", () => {
    expect(scanFindingId("abc")).toBe(scanFindingId("abc"));
    expect(scanFindingId("abc")).not.toBe(scanFindingId("abc#2"));
    expect(scanFindingId("abc")).toMatch(/^F[0-9a-f]{10}$/);
  });

  it("accepts one ruling per given ID, in any order, and keeps the reasons", () => {
    expect(
      checkScanRulings(items, [
        ruling("Ftwo", "dropped", " a note "),
        ruling("Fone"),
      ]),
    ).toEqual([
      { id: "Ftwo", ruling: "dropped", reason: "a note" },
      { id: "Fone", ruling: "raised", reason: "because" },
    ]);
    expect(checkScanRulings([], undefined)).toEqual([]);
  });

  it("fails when an ID is omitted", () => {
    expect(() => checkScanRulings(items, [ruling("Fone")])).toThrow(
      /omitted.*Ftwo/,
    );
    expect(() => checkScanRulings(items, undefined)).toThrow(/omitted/);
  });

  it("fails on an ID it was not given, or one ruled twice", () => {
    expect(() =>
      checkScanRulings(items, [ruling("Fone"), ruling("Ftwo"), ruling("Fx")]),
    ).toThrow(/not given.*Fx/);
    expect(() => checkScanRulings([], [ruling("Fone")])).toThrow(/not given/);
    expect(() =>
      checkScanRulings(items, [ruling("Fone"), ruling("Fone"), ruling("Ftwo")]),
    ).toThrow(/more than once/);
  });

  it("fails on an empty or blank reason", () => {
    expect(() =>
      checkScanRulings(items, [
        ruling("Fone", "dropped", "  "),
        ruling("Ftwo"),
      ]),
    ).toThrow(/reason/);
  });

  it("sends the findings with their IDs and asks for rulings", async () => {
    let sent: Record<string, any> = {};
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: "m",
          choices: [{ message: { content: JSON.stringify(approve) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
    await invokeReviewWorker(
      {
        provider: { id: "reviewer", kind: "local", model: "m" },
        policy: { ...DEFAULT_POLICY, providers: ["reviewer"] },
        objective: "o",
        acceptance: ["a"],
        diff: "d",
        checks: "c",
        scanFindings: [
          {
            id: "Fone",
            tool: "semgrep",
            rule: "r",
            path: "a.js",
            line: 1,
            message: "m",
            status: "baselined",
          },
        ],
      },
      fetch,
    );
    expect(
      JSON.parse(unwrapUntrusted(sent.messages[1].content)!),
    ).toMatchObject({
      scanFindings: [{ id: "Fone", status: "baselined" }],
    });
    expect(sent.response_format.json_schema.schema.required).toContain(
      "scanRulings",
    );
    expect(REVIEW_INSTRUCTIONS).toContain("scanRulings");
  });

  describe("scan ruling output budget", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `F${String(index).padStart(10, "0")}`,
        tool: "semgrep",
        rule: "r",
        path: "a.js",
        line: index,
        message: "",
        status: "baselined" as const,
      }));
    const call = (count: number, maxOutputTokens: number) => {
      const bodies: Record<string, any>[] = [];
      const fetch = vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            model: "m",
            choices: [{ message: { content: JSON.stringify(approve) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
      return {
        bodies,
        fetch,
        run: () =>
          invokeReviewWorker(
            {
              provider: { id: "reviewer", kind: "local", model: "m" },
              policy: {
                ...DEFAULT_POLICY,
                providers: ["reviewer"],
                maxContextTokens: 200_000,
                maxOutputTokens,
              },
              objective: "o",
              acceptance: ["a"],
              diff: "d",
              checks: "c",
              scanFindings: many(count),
            },
            fetch,
          ),
      };
    };

    it("refuses up front, naming the remedy, when the policy's output cap cannot hold 210 rulings", async () => {
      const { fetch, run } = call(210, 4000);
      await expect(run()).rejects.toThrow(/210 scan results.*maxOutputTokens/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("grows the requested output with the number of scan results when the policy allows", async () => {
      const small = call(2, 20_000);
      await small.run();
      const large = call(210, 20_000);
      await large.run();
      const asked = (body: Record<string, any>) =>
        body.max_tokens ?? body.max_output_tokens;
      expect(asked(small.bodies[0]!)).toBeLessThan(asked(large.bodies[0]!));
      expect(asked(large.bodies[0]!)).toBeGreaterThan(REVIEW_OUTPUT_TOKENS);
    });
  });
});

describe("reviewRecordExportable", () => {
  it("allows a record that never saw scanner results", () => {
    expect(reviewRecordExportable(undefined)).toBe(true);
    expect(reviewRecordExportable({ passed: false, findings: [] })).toBe(true);
  });

  it("follows the stored flag", () => {
    const scanRulings = [{ id: "F1", ruling: "raised", reason: "x" }];
    expect(reviewRecordExportable({ scanRulings, scanExportable: true })).toBe(
      true,
    );
    expect(reviewRecordExportable({ scanRulings, scanExportable: false })).toBe(
      false,
    );
  });

  it("fails closed when a record with scan rulings lacks a boolean flag", () => {
    const scanRulings = [{ id: "F1", ruling: "raised", reason: "x" }];
    expect(reviewRecordExportable({ scanRulings })).toBe(false);
    expect(reviewRecordExportable({ scanRulings, scanExportable: "yes" })).toBe(
      false,
    );
    expect(reviewRecordExportable({ scanExportable: "yes" })).toBe(false);
  });
});

describe("reviewHistoryExportable", () => {
  const ruled = {
    type: "review.completed",
    data: { scanRulings: [{ id: "F1", ruling: "raised", reason: "x" }] },
  };
  // Written before records carried the flag: inherited findings, no rulings.
  const legacyVerifyFix = {
    type: "review.completed",
    data: { stage: "verify-fix", passed: false, findings: [{ path: "a" }] },
  };
  it("stays unsafe when a legacy verify-fix record follows a ruled one", () => {
    expect(reviewRecordExportable(legacyVerifyFix.data)).toBe(true);
    expect(reviewHistoryExportable([ruled, legacyVerifyFix])).toBe(false);
  });
  it("ignores a person's record and other events", () => {
    expect(
      reviewHistoryExportable([
        { type: "review.started", data: {} },
        { type: "review.completed", data: { by: "person", scanRulings: [{}] } },
        legacyVerifyFix,
      ]),
    ).toBe(true);
    expect(reviewHistoryExportable([])).toBe(true);
  });
});
