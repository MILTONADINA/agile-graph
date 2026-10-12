import type { ProjectPolicy, RunRecord, Usage } from "@agile-graph/contracts";
import type { DecisionBudget } from "./decision-batch.js";

export interface AccountingGroup {
  totals: Usage;
  callCount: number;
  settledCallCount: number;
  unresolvedCallCount: number;
  unknownCostCallCount: number;
  estimatedCallCount: number;
  /** Partial subtotal only when any call has unknown cost. Includes reserves. */
  knownCostUsd: number;
  /** Unsettled conservative reserves, not confirmed provider charges. */
  unresolvedReservedCostUsd: number;
}

export interface AccountingSummary extends AccountingGroup {
  source: "inference-call-ledger";
  untrackedRunCount: number;
  planningOnly: AccountingGroup & {
    savedPlanCallCount: number;
    unsavedPlanCallCount: number;
  };
}

interface InferenceRow {
  owner_id: string;
  reserved: number | null;
  usage_json: string | null;
}

const emptyGroup = (): AccountingGroup => ({
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
  callCount: 0,
  settledCallCount: 0,
  unresolvedCallCount: 0,
  unknownCostCallCount: 0,
  estimatedCallCount: 0,
  knownCostUsd: 0,
  unresolvedReservedCostUsd: 0,
});

function add(group: AccountingGroup, row: InferenceRow): void {
  const usage: Usage = row.usage_json
    ? JSON.parse(row.usage_json)
    : {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        costUsd: row.reserved,
        estimated: true,
      };
  group.callCount += 1;
  if (row.usage_json) group.settledCallCount += 1;
  else {
    group.unresolvedCallCount += 1;
    group.unresolvedReservedCostUsd += row.reserved ?? 0;
  }
  if (usage.costUsd === null) group.unknownCostCallCount += 1;
  else group.knownCostUsd += usage.costUsd;
  if (usage.estimated) group.estimatedCallCount += 1;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "costUsd",
  ] as const)
    group.totals[key] =
      group.totals[key] === null || usage[key] === null
        ? null
        : group.totals[key]! + usage[key]!;
  group.totals.estimated ||= usage.estimated;
}

/** Never add RunRecord.usage: a run is a view over these same call rows. */
export function summarizeInferenceCalls(
  rows: InferenceRow[],
  savedPlanIds: string[],
  runs: RunRecord[],
): AccountingSummary {
  const saved = new Set(savedPlanIds);
  const runOwners = new Set(runs.flatMap((run) => [run.plan.id, run.id]));
  const ledgerOwners = new Set(rows.map((row) => row.owner_id));
  const summary: AccountingSummary = {
    ...emptyGroup(),
    source: "inference-call-ledger",
    untrackedRunCount: 0,
    planningOnly: {
      ...emptyGroup(),
      savedPlanCallCount: 0,
      unsavedPlanCallCount: 0,
    },
  };
  for (const row of rows) {
    add(summary, row);
    if (!runOwners.has(row.owner_id)) {
      add(summary.planningOnly, row);
      if (saved.has(row.owner_id)) summary.planningOnly.savedPlanCallCount += 1;
      else summary.planningOnly.unsavedPlanCallCount += 1;
    }
  }
  // Legacy/untracked usage must not silently become a measured zero. Do not
  // import its totals here: adding aggregate run counters risks double billing.
  summary.untrackedRunCount = runs.filter(
    (run) =>
      !ledgerOwners.has(run.plan.id) &&
      !ledgerOwners.has(run.id) &&
      (run.usage.costUsd !== 0 ||
        run.usage.inputTokens !== 0 ||
        run.usage.outputTokens !== 0 ||
        run.usage.cachedTokens !== 0),
  ).length;
  if (summary.untrackedRunCount) {
    summary.totals = {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      estimated: true,
    };
  }
  return summary;
}

/**
 * The reservation ledger for hosted typed decisions. With
 * policy.decisionMaxCostUsd set, every decision call in the project shares
 * one ledger per UTC day (`decisions-YYYY-MM-DD`) under that cap instead of
 * the run's ledger under maxCostUsd, so a zero worker cap still lets
 * decisions run and worker spend never draws on the decision cap. Each call
 * settles on the ledger it reserved on, even across midnight.
 */
export function decisionLedgerBudget(input: {
  store: {
    reserveCall(
      ownerId: string,
      callId: string,
      provider: string,
      reservedUsd: number | null,
      ceiling: number | null,
    ): void;
    settleCall(
      ownerId: string,
      callId: string,
      provider: string,
      usage: Usage,
    ): void;
  };
  policy: () => Pick<ProjectPolicy, "maxCostUsd" | "decisionMaxCostUsd">;
  ownerId: string;
  nowMs: () => number;
}): DecisionBudget {
  const owners = new Map<string, string>();
  const ledger = () => {
    const policy = input.policy();
    if (policy.decisionMaxCostUsd === undefined)
      return { owner: input.ownerId, ceiling: policy.maxCostUsd };
    const day = new Date(input.nowMs()).toISOString().slice(0, 10);
    return { owner: `decisions-${day}`, ceiling: policy.decisionMaxCostUsd };
  };
  return {
    reserve: async ({ callId, provider, amountUsd }) => {
      const { owner, ceiling } = ledger();
      input.store.reserveCall(owner, callId, provider, amountUsd, ceiling);
      owners.set(callId, owner);
    },
    settle: async (usage) => {
      const owner = owners.get(usage.callId) ?? ledger().owner;
      owners.delete(usage.callId);
      input.store.settleCall(owner, usage.callId, usage.provider, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: 0,
        costUsd: usage.chargedUsd,
        // The debit is conservative: a reviewed price or a reservation
        // above the reported charge is an estimate, not a measured cost.
        estimated:
          usage.reportedCostUsd === null ||
          usage.chargedUsd !== usage.reportedCostUsd,
      });
    },
  };
}
