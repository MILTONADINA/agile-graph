import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  findingId,
  invokeReviewWorker,
  invokeVerifyFix,
  priorBlockingFindings,
  REVIEW_INSTRUCTIONS,
  reviewOutcome,
  VERIFY_FIX_INSTRUCTIONS,
  type WorkerReview,
} from "../src/workers/review.js";

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
    expect(JSON.parse(sent.messages[1].content)).toMatchObject({
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
    expect(JSON.parse(sent.messages[1].content)).toEqual({
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
