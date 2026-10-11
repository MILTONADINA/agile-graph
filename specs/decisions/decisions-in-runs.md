# Hosted decisions in runs, a decision-only cap and context insights

- ID: decisions-in-runs
- Status: implemented
- Area: decisions

## Problem

Jev abstained on every context-selection question in runs with "Hosted
decisions require explicitly exportable state and questions": the run never
marked those questions exportable, even when every label was a path the
policy lets leave the machine. Hosted decisions were also charged against
`policy.maxCostUsd`, which owners keep at 0 so no worker spends money, so a
priced Jev call was always refused. And there was no local way to see what
context selection saved or how well each decision provider answered.

## Design decisions

Asked Jev and Laya with design text only; Jev's answer was taken.

| Question                                                          | Jev                                   | Laya                                              | Taken                  |
| ----------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- | ---------------------- |
| Mixed exportable and local-only candidates in one selection group | split (0.85)                          | whole group local (0.60, entropy confidence 0.03) | split by exportability |
| Where decision spend is recorded under the decision cap           | daily decision ledger only (0.99)     | same (0.60, 0.03)                                 | daily ledger only      |
| How to expose the report                                          | new `insights-context` command (0.98) | same (0.71, 0.13)                                 | new command            |

## Acceptance criteria

- AC1: A run's context items become selection candidates that are exportable only when the item is not memory, has a source, and its path is exportable under policy. Candidates are grouped by exportability, so a hosted provider decides every exportable candidate while a non-exportable candidate stays local-only; the hosted privacy guard is unchanged.
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: marks only context items on exportable paths as exportable selection candidates
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: sends an all-exportable context selection to a hosted decision provider
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: keeps a non-exportable candidate local-only while exportable candidates still reach the hosted provider
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: sends a run's hosted context selection only exportable path labels
- AC2: Optional `policy.decisionMaxCostUsd` (number at least 0, or null for no cap) is absent from `DEFAULT_POLICY` and validated. When set, hosted decisions are capped by it instead of `maxCostUsd`, and their spend is reserved on one project ledger per UTC day (`decisions-YYYY-MM-DD`), chosen when each call is sent, an unpriced one under no cap too, so a call that returns after midnight settles on the day it was sent; workers, planners, reviews and audits stay under `maxCostUsd`. When absent, decisions keep the run's ledger under `maxCostUsd`.
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: lets Jev decide under decisionMaxCostUsd while workers keep maxCostUsd 0
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: refuses hosted decisions under a zero decisionMaxCostUsd even when maxCostUsd allows spend
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: validates decisionMaxCostUsd and leaves it out of the default policy
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: charges decisions to a daily project ledger, refuses once the day's cap is spent, and still refuses workers at maxCostUsd 0
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: keeps decisions on the run's ledger under maxCostUsd when no decision cap is set
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: settles an unpriced call under no cap on the ledger of the day it was sent
  - Test: packages/engine/tests/decision-batch.test.ts :: binds an unpriced call under no cap to its ledger before sending it
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: settles a run's hosted decisions on the daily decision ledger and refuses its worker under maxCostUsd 0
- AC3: Each context packet built for a run's workers records a `context.packet` event with token counts only: the packet's estimate, its source-excerpt tokens and the whole-file tokens of the files those excerpts came from (by file size, with the same estimator; a symlink is not followed and counts as unreadable, so a link out of the workspace cannot inflate the baseline). Decision records carry a `batchId` and the provider request's `latencyMs`. The read-only CLI command `graph-engine insights-context` reports context savings per run and in total, and decision quality per provider and category (answered, abstained with reasons, latency, spend) with agreement between providers that answered the same question. It prints no file contents or paths and is not an MCP tool.
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: measures a packet's excerpts against the whole files they came from without reading contents into the result
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: counts a workspace symlink to a file outside the workspace as unreadable
  - Test: packages/engine/tests/decisions-in-runs.test.ts :: reports context savings per run and in total, and decision quality per provider and category

## Security considerations

Exportability is decided by the existing policy path check and the existing
secret screen; nothing new is exported, and the batch guard still refuses any
hosted call holding a non-exportable question. The decision cap authorizes
spend only on hosted decision calls with a reviewed positive price, and the
owner sets it; no default allows spend. The report reads local data only.

## Non-goals

No change to `.graph/project.json`, worker spending, promotion, or MCP tools.
