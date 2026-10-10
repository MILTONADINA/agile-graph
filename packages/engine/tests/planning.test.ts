import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import type { RunEvent } from "@graph-engineering/contracts";
import {
  LIKELY_FIX_CHECKS_PER_REPAIR,
  acCoverage,
  likelyWorkerTurns,
  requiresSecurityReview,
  routePlan,
  unmetCriteria,
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

describe("acceptance-criteria coverage", () => {
  it("reports criteria no step covers and covers entries naming no criterion", () => {
    const acceptance = [
      "AC1: Invoices are listed",
      "AC2: Anonymous requests are refused",
      "AC3: Totals are in cents",
      "Without an ID, so never counted",
    ];
    expect(
      acCoverage(acceptance, [
        { covers: ["AC1", "AC9"] },
        {},
        { covers: ["AC3", "AC1", "ac2", "AC9"] },
      ]),
    ).toEqual({ uncovered: ["AC2"], unknown: ["AC9", "ac2"] });
    expect(acCoverage(acceptance, [{ covers: ["AC1", "AC2", "AC3"] }])).toEqual(
      { uncovered: [], unknown: [] },
    );
    expect(acCoverage(["No IDs here"], [{ covers: ["AC1"] }])).toEqual({
      uncovered: [],
      unknown: ["AC1"],
    });
  });
});

describe("unmet criteria for a follow-up", () => {
  const review = (data: Record<string, unknown>): RunEvent => ({
    version: "1.0.0",
    id: `event-${Math.random()}`,
    runId: "run",
    projectId: "toy",
    at: "2026-01-01T00:00:00.000Z",
    type: "review.completed",
    data,
  });
  it("takes the criteria the latest AI review did not find met, by position", () => {
    const acceptance = ["AC1: one", "AC2: two", "AC3: three", "AC4: four"];
    const events = [
      review({ criteria: [{ met: "no" }, { met: "no" }] }),
      review({
        criteria: [{ met: "yes" }, { met: "no" }, { met: "unknown" }],
      }),
      // A person's approval judges no criterion and is not the AI's review.
      review({ by: "person", passed: true }),
    ];
    // The fourth criterion went unanswered, which counts as unknown.
    expect(unmetCriteria(acceptance, events)).toEqual([
      "AC2: two",
      "AC3: three",
      "AC4: four",
    ]);
    expect(
      unmetCriteria(acceptance.slice(0, 1), [
        review({ criteria: [{ met: "yes" }] }),
      ]),
    ).toEqual([]);
    expect(
      unmetCriteria(acceptance, [review({ by: "person", passed: true })]),
    ).toBeUndefined();
  });
});
