import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, type DecisionRecord } from "@agile-graph/contracts";
import type {
  DecisionBatchOptions,
  DecisionBatchResult,
} from "../src/decision-batch.js";
import {
  REVIEW_PRIOR_FLAG_AT,
  reviewPrior,
  reviewPriorState,
  type ReviewPriorRound,
} from "../src/review-prior.js";
import { repeatAction, rejectionHistory } from "../src/workers/review.js";

// Synthetic toy data only: no real project, review or provider is involved.
const on = {
  ...DEFAULT_POLICY,
  decisionMaxCostUsd: 1,
  exportPaths: ["src/**"],
  reviewPrior: { enabled: true, exportAuthorized: true },
};
const session = (policy = on) => ({
  projectId: "unit-project",
  state: {},
  policy,
  providers: [],
});
const round = (...messages: string[]): ReviewPriorRound => ({
  summary: "Needs changes",
  findings: messages.map((message) => ({
    severity: "blocking" as const,
    path: "src/upload.ts",
    message,
  })),
});

const record = (
  id: string,
  yes: number | null,
  failure?: string,
): DecisionRecord => ({
  version: "1.0.0",
  id: `r-${id}`,
  projectId: "unit-project",
  category: "review_prior",
  candidates: ["no", "yes"],
  selected: yes === null ? null : yes >= 0.5 ? "yes" : "no",
  baseline: "no",
  provider: "jev",
  modelVersion: "fake",
  policyVersion: "p",
  confidence: yes === null ? null : yes >= 0.5 ? yes : 1 - yes,
  mode: "shadow",
  action: "review",
  createdAt: "2026-01-01T00:00:00.000Z",
  evidence: { questionId: id, ...(failure ? { failure } : {}) },
});
const answers =
  (scores: Record<string, number | null>, failure?: string) =>
  async (options: DecisionBatchOptions): Promise<DecisionBatchResult> => ({
    selections: {},
    usage: [],
    records: options.questions.map((question) =>
      record(question.id, scores[question.id] ?? null, failure),
    ),
  });

describe("reviewPrior", () => {
  it("takes the first usable answer per question when one provider fails", async () => {
    const outcome = await reviewPrior({
      session: session(),
      rounds: [round("a"), round("b")],
      exportable: true,
      decide: async (options) => ({
        selections: {},
        usage: [],
        records: options.questions.flatMap((question) => [
          { ...record(question.id, null, "refused"), provider: "first" },
          { ...record(question.id, 0.9), provider: "second" },
        ]),
      }),
    });
    expect(outcome).toMatchObject({
      status: "scored",
      flagged: true,
      scores: { same_class: 0.9, substantive: 0.9 },
    });
  });

  it("makes no call unless on, capped by a number, export-authorized and exportable", async () => {
    const rounds = [round("a"), round("b")];
    const cases: [string, Parameters<typeof session>[0], boolean][] = [
      ["absent", { ...on, reviewPrior: undefined }, true],
      ["disabled", { ...on, reviewPrior: { enabled: false } }, true],
      ["no decision cap", { ...on, decisionMaxCostUsd: undefined }, true],
      ["null cap", { ...on, decisionMaxCostUsd: null }, true],
      ["zero cap", { ...on, decisionMaxCostUsd: 0 }, true],
      [
        "no export authorization",
        { ...on, reviewPrior: { enabled: true } },
        true,
      ],
      ["unexportable text", on, false],
    ];
    for (const [label, policy, exportable] of cases) {
      const decide = vi.fn(answers({}));
      const outcome = await reviewPrior({
        session: session(policy as typeof on),
        rounds,
        exportable,
        decide,
      });
      expect(decide, label).not.toHaveBeenCalled();
      expect(outcome.status, label).toMatch(/off|skipped/);
    }
  });

  it("needs an earlier review to compare with", async () => {
    const decide = vi.fn(answers({}));
    const outcome = await reviewPrior({
      session: session(),
      rounds: [round("a")],
      exportable: true,
      decide,
    });
    expect(outcome).toEqual({ status: "off" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("scores the four priors as the probability of yes and flags same_class", async () => {
    const outcome = await reviewPrior({
      session: session(),
      rounds: [round("a"), round("b")],
      exportable: true,
      decide: answers({
        same_class: 0.9,
        already_ruled: 0.2,
        substantive: 0.8,
        owner_needed: 0.1,
      }),
    });
    expect(outcome.status).toBe("scored");
    if (outcome.status !== "scored") return;
    expect(outcome.scores.same_class).toBeCloseTo(0.9);
    expect(outcome.scores.already_ruled).toBeCloseTo(0.2);
    expect(outcome.flagged).toBe(true);
  });

  it("never sends promotion evidence, so no answer is promoted", async () => {
    const decide = vi.fn(answers({ same_class: 0.5 }));
    await reviewPrior({
      session: {
        ...session(),
        evidence: [{ category: "review_prior" } as never],
        promotionBinding: {} as never,
      },
      rounds: [round("a"), round("b")],
      exportable: true,
      decide,
    });
    const sent = decide.mock.calls[0]![0];
    expect(sent.evidence).toBeUndefined();
    expect(sent.promotionBinding).toBeUndefined();
  });

  it("fails open when the call throws or answers nothing", async () => {
    const thrown = await reviewPrior({
      session: session(),
      rounds: [round("a"), round("b")],
      exportable: true,
      decide: async () => {
        throw new Error("Decision provider HTTP 503");
      },
    });
    expect(thrown).toEqual({
      status: "failed",
      reason: "Decision provider HTTP 503",
    });
    const refused = await reviewPrior({
      session: session(),
      rounds: [round("a"), round("b")],
      exportable: true,
      decide: answers({}, "Decision request timed out"),
    });
    expect(refused).toMatchObject({
      status: "failed",
      reason: "Decision request timed out",
    });
  });

  it("sends redacted, bounded text and withholds paths outside exportPaths", () => {
    const state = reviewPriorState(
      [
        {
          summary: "s".repeat(1000),
          findings: [
            { severity: "blocking", path: "src/a.ts", message: "ok" },
            { severity: "blocking", path: ".env", message: "x" },
          ],
        },
      ],
      on,
    );
    const first = state.rounds[0] as { summary: string; findings: any[] };
    expect(first.summary.length).toBeLessThanOrEqual(240);
    expect(first.findings.map((finding) => finding.path)).toEqual([
      "src/a.ts",
      null,
    ]);
  });
});

describe("backtest: patch-by-case loop", () => {
  // Each round fixes one case of the same bug class (path traversal in a
  // toy upload helper) and the reviewer words the next case differently, so
  // no two findings share a signature.
  const traversal = [
    "Reject dot-dot segments in the upload name",
    "Encoded %2e%2e sequences still escape the upload folder",
    "Backslash separators bypass the check on Windows-style names",
    "A leading drive letter names an absolute location",
    "Symlinked entries inside an archive leave the folder",
  ];
  const sequence = traversal.map((message) => round(message));
  // A deterministic fake provider: same_class is high when the current and
  // the previous review both name a traversal-style case.
  const marker = /dot-dot|%2e|separator|drive letter|symlink/i;
  const fakeJev = async (options: DecisionBatchOptions) => {
    const rounds = (
      options.state as { rounds: { findings: { message: string }[] }[] }
    ).rounds;
    const hits = rounds.filter((item) =>
      item.findings.some((finding) => marker.test(finding.message)),
    ).length;
    return answers({
      same_class: hits >= 2 ? 0.92 : 0.1,
      already_ruled: 0.3,
      substantive: 0.8,
      owner_needed: 0.05,
    })(options);
  };
  /** First 1-based round the prior flags, or undefined. */
  const priorFlagRound = async (rounds: ReviewPriorRound[]) => {
    for (let index = 1; index <= rounds.length; index++) {
      const outcome = await reviewPrior({
        session: session(),
        rounds: rounds.slice(0, index),
        exportable: true,
        decide: fakeJev,
      });
      if (outcome.status === "scored" && outcome.flagged) return index;
    }
    return undefined;
  };
  /** First 1-based round the repeated-signature rule acts, or undefined. */
  const signatureFlagRound = (rounds: ReviewPriorRound[]) => {
    const events = rounds.map((item) => ({
      type: "review.completed",
      data: { passed: false, findings: item.findings },
    }));
    for (let index = 1; index <= rounds.length; index++) {
      const history = rejectionHistory(events.slice(0, index - 1));
      const current = rejectionHistory(events.slice(index - 1, index))[0]!;
      if (repeatAction(history, current)) return index;
    }
    return undefined;
  };

  it("flags a loop of differently worded findings that the signature rule never flags", async () => {
    expect(signatureFlagRound(sequence)).toBeUndefined();
    expect(await priorFlagRound(sequence)).toBe(2);
  });

  it("flags at least one round before the signature rule when a finding finally recurs", async () => {
    const recurring = [
      sequence[0]!,
      sequence[1]!,
      sequence[2]!,
      // The exact first finding comes back: the signature rule acts on the
      // round after it was raised twice in a row (here round 4 raises the
      // same finding as round 3).
      round(traversal[2]!),
    ];
    const bySignature = signatureFlagRound(recurring);
    const byPrior = await priorFlagRound(recurring);
    expect(bySignature).toBe(4);
    expect(byPrior).toBeDefined();
    expect(byPrior!).toBeLessThanOrEqual(bySignature! - 1);
    expect(REVIEW_PRIOR_FLAG_AT).toBeLessThan(0.92);
  });
});
