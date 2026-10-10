import type {
  DecisionRecord,
  ExecutionPlan,
  ProjectPolicy,
  ProviderConfig,
  RunEvent,
} from "@graph-engineering/contracts";
import {
  decideBatch,
  type DecisionBudget,
  type DecisionCallUsage,
  type DecisionQuestion,
  type DecisionProvider,
  type PromotionEvidence,
} from "./decisions.js";
import type { PromotionDispatchBinding } from "./promotion-authority.js";
import { VERIFY_FIX_LIMIT } from "./workers/review.js";

export const WORKFLOWS = {
  "bug-fix":
    "Reproduce from supplied evidence, locate the smallest causal change, preserve unrelated behavior, and add regression coverage.",
  feature:
    "Implement the stated acceptance criteria using existing project conventions and add focused tests.",
  refactor:
    "Preserve observable behavior and public contracts. Make the smallest coherent structural change and retain regression coverage.",
  investigate:
    "Investigate the supplied evidence. Request missing source explicitly. Do not invent facts or modify unrelated code.",
} as const;
export type Workflow = keyof typeof WORKFLOWS;

// Safety floors cannot depend on a decision model recognizing identifier
// boundaries. Word boundaries alone miss SERVICE_API_KEY and serviceApiKey.
export function requiresSecurityReview(objective: string): boolean {
  return (
    /\b(?:auth|authentication|authorization|credentials?|security|permissions?|tokens?|crypto|cryptography|secrets?|passwords?|api[- ]?keys?|private[- ]?keys?)\b/i.test(
      objective,
    ) ||
    /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|private[_-]?key|secret|password)(?=$|[^A-Za-z0-9])/i.test(
      objective,
    ) ||
    /(?:ApiKey|AccessToken|PrivateKey|Secret|Password)(?=$|[^a-z])/.test(
      objective,
    ) ||
    /(?:^|[^A-Za-z0-9])(?:apiKey|accessToken|privateKey)(?=$|[^a-z])/.test(
      objective,
    )
  );
}

/** These are bounded routing choices, never permissions or replacements for required checks. */
export async function routePlan(options: {
  projectId: string;
  objective: string;
  provider: ProviderConfig;
  explicitEffort?: string;
  policy: ProjectPolicy;
  providers: DecisionProvider[];
  evidence: PromotionEvidence[];
  promotionBinding?: PromotionDispatchBinding;
  cloudState?: Record<string, unknown>;
  budget?: DecisionBudget;
  signal?: AbortSignal;
}): Promise<{
  workflow: Workflow;
  effort?: string;
  contextBudgetTokens: number;
  records: DecisionRecord[];
  usage: DecisionCallUsage[];
}> {
  const { objective, provider, policy } = options;
  const baseline: Workflow = /\b(fix|bug|fail|regression)\b/i.test(objective)
    ? "bug-fix"
    : /\brefactor\b/i.test(objective)
      ? "refactor"
      : /\b(investigate|explain|find|inspect)\b/i.test(objective)
        ? "investigate"
        : "feature";
  const contextLimit = Math.max(
    1,
    Math.floor(
      Math.min(
        policy.maxContextTokens,
        provider.maxContextTokens ?? policy.maxContextTokens,
      ) * 0.7,
    ),
  );
  const budgets = [
    ...new Set(
      [2048, 4096, 8192, contextLimit].filter((value) => value <= contextLimit),
    ),
  ];
  const effort = options.explicitEffort ?? provider.defaultEffort;
  const specs: DecisionQuestion[] = [
    {
      id: "workflow",
      category: "workflow",
      candidates: {
        "bug-fix": "Reproduce and fix a defect",
        feature: "Implement acceptance criteria",
        refactor: "Preserve behavior while restructuring",
        investigate: "Gather and explain evidence",
      },
      baseline,
      exportable: true,
    },
    {
      id: "context-budget",
      exportable: true,
      category: "context-budget",
      candidates: Object.fromEntries(
        budgets.map((value) => [
          String(value),
          `At most ${value} conservatively estimated source-context tokens`,
        ]),
      ),
      baseline: String(contextLimit),
    },
    ...(!options.explicitEffort && provider.efforts?.length
      ? [
          {
            id: "effort",
            exportable: true,
            category: "effort",
            candidates: Object.fromEntries(
              ["default", ...provider.efforts].map((value) => [
                value,
                value === "default"
                  ? "Configured model default"
                  : `Supported effort: ${value}`,
              ]),
            ),
            baseline: effort ?? "default",
          },
        ]
      : []),
  ];
  const result = await decideBatch({
    ...options,
    questions: specs,
    state: {
      objective: objective.slice(0, 800),
      model: provider.model,
      workerKind: provider.kind,
      maxContextTokens: contextLimit,
    },
    stateTruncated: objective.length > 800,
  });
  const selected = (category: string, fallback: string) =>
    result.selections[category] ?? fallback;
  const selectedEffort = selected("effort", effort ?? "default");
  return {
    workflow: selected("workflow", baseline) as Workflow,
    effort: selectedEffort === "default" ? undefined : selectedEffort,
    contextBudgetTokens: Number(
      selected("context-budget", String(contextLimit)),
    ),
    records: result.records,
    usage: result.usage,
  };
}

/**
 * The fix checks a plan's turn estimate reserves for each repair attempt
 * with a reviewer. A retried review first checks each earlier blocking
 * finding in its own call, up to VERIFY_FIX_LIMIT; a review that holds a
 * change back usually names a handful, so the estimate expects three rather
 * than the cap. It only sizes the warning; the run's budget counts every
 * call actually made.
 */
export const LIKELY_FIX_CHECKS_PER_REPAIR = Math.min(VERIFY_FIX_LIMIT, 3);

/**
 * A rough count of the model calls a plan needs: a few turns per worker
 * step (read, request, propose), one per review, a few per repair attempt
 * and, with a reviewer, the fix checks of earlier findings before each
 * repeated review. Used only to warn when policy.maxTurns looks too small.
 */
export function likelyWorkerTurns(
  plan: Pick<ExecutionPlan, "steps">,
  options: { reviewer: boolean; maxAttempts: number },
): number {
  const workers = plan.steps.filter((step) => step.kind === "worker").length;
  // A plan with no implementer cannot dispatch a repair worker after checks.
  const repairs = workers ? Math.max(0, options.maxAttempts - 1) : 0;
  return (
    workers * 3 +
    (options.reviewer ? 1 + repairs * (1 + LIKELY_FIX_CHECKS_PER_REPAIR) : 0) +
    repairs * 3
  );
}

/**
 * Which acceptance criteria no step says it covers, and which `covers`
 * entries name no criterion. IDs come from the `ACn:` prefixes that plans
 * made from specs carry; criteria without one cannot be covered by ID and
 * are left out. Advisory only: a step's own claim is not evidence that the
 * work satisfies the criterion, which stays the reviewer's to judge.
 */
export function acCoverage(
  acceptance: readonly string[],
  steps: readonly Pick<ExecutionPlan["steps"][number], "covers">[],
): { uncovered: string[]; unknown: string[] } {
  const ids = acceptance.flatMap(
    (criterion) => /^(AC\d+):/.exec(criterion)?.[1] ?? [],
  );
  const covered = new Set(steps.flatMap((step) => step.covers ?? []));
  return {
    uncovered: ids.filter((criterionId) => !covered.has(criterionId)),
    unknown: [...covered].filter((entry) => !ids.includes(entry)),
  };
}

/** Whether any step of a plan names the criteria it covers. */
export const namesCoverage = (
  steps: readonly Pick<ExecutionPlan["steps"][number], "covers">[],
): boolean => steps.some((step) => step.covers?.length);

/**
 * The acceptance criteria a run's latest AI review did not find met ("no"
 * or "unknown"), in plan order. A review answers the plan's criteria by
 * position, and a missing answer counts as unknown, as when the run was
 * judged. A person's approval stands in for the reviewer's verdict but
 * judges no criterion, so it is skipped. Undefined when no AI review
 * completed.
 */
export function unmetCriteria(
  acceptance: readonly string[],
  events: readonly RunEvent[],
): string[] | undefined {
  const review = events.findLast(
    (event) => event.type === "review.completed" && event.data.by !== "person",
  );
  if (!review) return undefined;
  const answers = Array.isArray(review.data.criteria)
    ? (review.data.criteria as { met?: unknown }[])
    : [];
  return acceptance.filter((_, index) => answers[index]?.met !== "yes");
}
