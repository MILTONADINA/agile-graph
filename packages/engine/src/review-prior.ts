import type { DecisionRecord, ProjectPolicy } from "@agile-graph/contracts";
import {
  decideBatch,
  type DecisionBatchOptions,
  type DecisionBatchResult,
  type DecisionQuestion,
} from "./decision-batch.js";
import { decisionCostCap, isAllowedPath, redact } from "./policy.js";

/**
 * Optional review-round priors from a typed decision provider (Jev). The
 * scores are advisory data only: nothing here reads or sets a review verdict,
 * and the result is never an input to a merge check or to ACCEPT. The call is
 * off unless the operator turns it on, sets a numeric decision cost cap above
 * 0 and authorizes the review text for export. Any failure is reported and
 * the review goes on unchanged.
 */
export const REVIEW_PRIOR_CATEGORY = "review_prior";
export const REVIEW_PRIOR_SCORES = [
  "same_class",
  "already_ruled",
  "substantive",
  "owner_needed",
] as const;
export type ReviewPriorScore = (typeof REVIEW_PRIOR_SCORES)[number];
/** same_class at or above this is flagged as a likely patch-by-case loop. */
export const REVIEW_PRIOR_FLAG_AT = 0.7;
/** Rounds sent: the current review and up to this many before it. */
const ROUNDS_SENT = 4;
const FINDINGS_PER_ROUND = 6;
const TEXT_LIMIT = 240;

/** One review round as the prior sees it: oldest first, current last. */
export interface ReviewPriorRound {
  summary: string;
  findings: {
    severity: "blocking" | "advisory";
    path: string | null;
    message: string;
  }[];
}

export type ReviewPriorOutcome =
  /** Not turned on, or nothing earlier to compare: no call, no event. */
  | { status: "off" }
  /** Turned on but a gate refused; nothing was sent. */
  | { status: "skipped"; reason: string }
  /** The call failed; the review is unchanged. */
  | {
      status: "failed";
      reason: string;
      result?: DecisionBatchResult;
    }
  | {
      status: "scored";
      scores: Record<ReviewPriorScore, number | null>;
      /** same_class reached REVIEW_PRIOR_FLAG_AT. Advisory only. */
      flagged: boolean;
      result: DecisionBatchResult;
    };

const binary = (yes: string, no: string) => ({ no, yes });
const QUESTIONS: Record<
  ReviewPriorScore,
  { instructions: string; candidates: Record<string, string> }
> = {
  same_class: {
    instructions:
      "Do the blocking findings of the current review belong to the same defect class as findings of the previous reviews, even where the wording or location differs?",
    candidates: binary(
      "The current findings repeat a defect class raised before",
      "The current findings are a different class from earlier ones",
    ),
  },
  already_ruled: {
    instructions:
      "Did a previous review already rule on the point the current blocking findings raise?",
    candidates: binary(
      "An earlier review already ruled on this point",
      "No earlier review ruled on this point",
    ),
  },
  substantive: {
    instructions:
      "Are the current blocking findings substantive correctness, security or acceptance problems, not style or preference?",
    candidates: binary(
      "At least one current finding is substantive",
      "The current findings are not substantive",
    ),
  },
  owner_needed: {
    instructions:
      "Do the current findings need a decision only the project owner can make?",
    candidates: binary(
      "A decision belongs to the owner",
      "The worker can resolve the findings",
    ),
  },
};

/** The prior's questions, in a fixed order. Never exportable by default. */
export function reviewPriorQuestions(): DecisionQuestion[] {
  return REVIEW_PRIOR_SCORES.map((id) => ({
    id,
    category: REVIEW_PRIOR_CATEGORY,
    candidates: QUESTIONS[id].candidates,
    baseline: "no",
    instructions: QUESTIONS[id].instructions,
    exportable: true,
  }));
}

/** The probability of "yes" from one record, or null for no usable answer. */
export function priorScore(record: DecisionRecord): number | null {
  if (
    record.evidence.failure !== undefined ||
    record.selected === null ||
    record.confidence === null
  )
    return null;
  return record.selected === "yes" ? record.confidence : 1 - record.confidence;
}

/** The review text sent: redacted, bounded, and only exportable paths. */
export function reviewPriorState(
  rounds: readonly ReviewPriorRound[],
  policy: ProjectPolicy,
): { rounds: Record<string, unknown>[] } {
  const clip = (text: string) =>
    redact(text).replace(/\s+/g, " ").slice(0, TEXT_LIMIT);
  return {
    rounds: rounds.slice(-ROUNDS_SENT).map((round, index, kept) => ({
      round: index + 1,
      current: index === kept.length - 1,
      summary: clip(round.summary),
      findings: round.findings.slice(0, FINDINGS_PER_ROUND).map((finding) => ({
        severity: finding.severity,
        path:
          finding.path !== null && isAllowedPath(finding.path, policy, true)
            ? finding.path
            : null,
        message: clip(finding.message),
      })),
    })),
  };
}

export async function reviewPrior(input: {
  /** The run's decision session: policy, providers, ledger and signal. */
  session: Omit<DecisionBatchOptions, "questions">;
  /** Oldest first; the last is the current review. */
  rounds: readonly ReviewPriorRound[];
  /**
   * False when the review text may quote a path or scan result the project's
   * export policy does not allow to leave the machine.
   */
  exportable: boolean;
  /** The decision client; tests inject a fake. Defaults to decideBatch. */
  decide?: (options: DecisionBatchOptions) => Promise<DecisionBatchResult>;
}): Promise<ReviewPriorOutcome> {
  const policy = input.session.policy;
  if (policy.reviewPrior?.enabled !== true) return { status: "off" };
  if (input.rounds.length < 2) return { status: "off" };
  const cap = decisionCostCap(policy);
  if (typeof cap !== "number" || !(cap > 0))
    return {
      status: "skipped",
      reason:
        "a numeric decision cost cap above 0 is required (policy.decisionMaxCostUsd, or maxCostUsd when it is absent)",
    };
  if (policy.reviewPrior.exportAuthorized !== true)
    return {
      status: "skipped",
      reason:
        "policy.reviewPrior.exportAuthorized is not true: the operator has not authorized the review text for export",
    };
  if (!input.exportable)
    return {
      status: "skipped",
      reason:
        "the review text may quote paths or scan results the export policy does not allow",
    };
  let result: DecisionBatchResult;
  try {
    const state = reviewPriorState(input.rounds, policy);
    // No promotion evidence or binding: every answer stays in shadow.
    const { evidence: _e, promotionBinding: _p, ...session } = input.session;
    result = await (input.decide ?? decideBatch)({
      ...session,
      state,
      cloudState: state,
      stateTruncated: false,
      questions: reviewPriorQuestions(),
    });
  } catch (error) {
    return {
      status: "failed",
      reason: redact(error instanceof Error ? error.message : String(error)),
    };
  }
  const scores = Object.fromEntries(
    REVIEW_PRIOR_SCORES.map((id) => {
      const record = result.records.find(
        (item) => item.evidence.questionId === id,
      );
      return [id, record ? priorScore(record) : null];
    }),
  ) as Record<ReviewPriorScore, number | null>;
  if (REVIEW_PRIOR_SCORES.every((id) => scores[id] === null))
    return {
      status: "failed",
      reason: redact(
        String(
          result.records.find((record) => record.evidence.failure)?.evidence
            .failure ?? "the provider returned no usable answer",
        ),
      ).slice(0, 300),
      result,
    };
  return {
    status: "scored",
    scores,
    flagged:
      scores.same_class !== null && scores.same_class >= REVIEW_PRIOR_FLAG_AT,
    result,
  };
}
