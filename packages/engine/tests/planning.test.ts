import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  LIKELY_FIX_CHECKS_PER_REPAIR,
  likelyWorkerTurns,
  requiresSecurityReview,
  routePlan,
} from "../src/planning.js";
import { VERIFY_FIX_LIMIT } from "../src/workers/review.js";

describe("security review floor", () => {
  it("recognizes source identifiers and rejects unrelated word fragments", () => {
    for (const objective of [
      "Fix SERVICE_API_KEY export",
      "Inspect serviceApiKey assignment",
      "Validate apiKey before export",
      "Rotate accessToken safely",
      "Review generateAccessToken(user.id)",
      "Update auth/session.ts",
    ])
      expect(requiresSecurityReview(objective)).toBe(true);
    for (const objective of [
      "Refactor tokenizer streaming",
      "Update secretary schedule",
      "Improve keyboard shortcuts",
      "Fix math.cjs addition",
    ])
      expect(requiresSecurityReview(objective)).toBe(false);
  });
});

describe("bounded routing", () => {
  it("uses deterministic defaults without model calls and preserves an explicit effort", async () => {
    const result = await routePlan({
      projectId: "test",
      objective: "Fix the failing addition test",
      provider: {
        id: "local",
        kind: "local",
        model: "test",
        efforts: ["low", "high"],
        defaultEffort: "low",
      },
      explicitEffort: "high",
      policy: DEFAULT_POLICY,
      providers: [],
      evidence: [],
    });
    expect(result).toEqual({
      workflow: "bug-fix",
      effort: "high",
      contextBudgetTokens: 11200,
      records: [],
      usage: [],
    });
  });
  it("never allocates more than the provider context limit", async () => {
    const result = await routePlan({
      projectId: "test",
      objective: "Refactor the helper",
      provider: {
        id: "local",
        kind: "local",
        model: "test",
        maxContextTokens: 2048,
      },
      policy: DEFAULT_POLICY,
      providers: [],
      evidence: [],
    });
    expect(result.workflow).toBe("refactor");
    expect(result.contextBudgetTokens).toBe(1433);
  });
});

describe("turn estimates", () => {
  it("counts model workers but not generator or template steps", () => {
    const plan = {
      steps: [{ kind: "generator" }, { kind: "template" }] as never,
    };
    expect(likelyWorkerTurns(plan, { reviewer: false, maxAttempts: 3 })).toBe(
      0,
    );
    expect(likelyWorkerTurns(plan, { reviewer: true, maxAttempts: 3 })).toBe(1);
    expect(
      likelyWorkerTurns(
        { steps: [...plan.steps, { kind: "worker" }] as never },
        { reviewer: true, maxAttempts: 3 },
      ),
    ).toBe(3 + 1 + 2 * (1 + LIKELY_FIX_CHECKS_PER_REPAIR) + 2 * 3);
  });

  it("reserves expected fix checks of earlier review findings per repair attempt", () => {
    const plan = { steps: [{ kind: "worker" }] as never };
    // Three per repair, never more than a review may check.
    expect(LIKELY_FIX_CHECKS_PER_REPAIR).toBe(3);
    expect(LIKELY_FIX_CHECKS_PER_REPAIR).toBeLessThanOrEqual(VERIFY_FIX_LIMIT);
    const reviewed = likelyWorkerTurns(plan, {
      reviewer: true,
      maxAttempts: 3,
    });
    const unreviewed = likelyWorkerTurns(plan, {
      reviewer: false,
      maxAttempts: 3,
    });
    // The first review, then per repair a review and three fix checks.
    expect(reviewed - unreviewed).toBe(1 + 2 * 4);
    // A single attempt has no retried review, so no fix checks.
    expect(
      likelyWorkerTurns(plan, { reviewer: true, maxAttempts: 1 }) -
        likelyWorkerTurns(plan, { reviewer: false, maxAttempts: 1 }),
    ).toBe(1);
  });
});
