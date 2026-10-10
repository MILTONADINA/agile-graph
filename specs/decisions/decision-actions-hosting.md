# Decision action labels and hosting-based provider guards

- ID: decision-actions-hosting
- Status: implemented
- Area: decisions

## Problem

A decision record said what a provider chose and whether the choice was
promoted, but not what a reader should do with it. A consumer had to rebuild
the engine's promotion threshold, failure and context rules itself to tell a
record it may act on from one a person must look at.

The hosted-provider privacy and cost guards keyed on the provider id `"jev"`.
Another hosted provider could not be configured, and the guard depended on a
name rather than on where the provider runs.

## Acceptance criteria

- AC1: Every new `DecisionRecord` carries an engine-derived `action` of `auto`, `review` or `escalate`; the model's answer never sets it directly. `auto` requires mode `promoted`, an applied (non-null) selection, confidence at or above the promotion threshold in use, and complete context. Shadow records are never `auto`.
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: labels auto only for a promoted applied answer at its threshold with complete context
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: labels usable shadow answers review and never auto
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: labels a promoted answer auto, but review when the caller truncated its state
- AC2: A failed provider call, a refused, malformed or withheld answer, a missing confidence, or a confidence below the threshold in use is `escalate`. The threshold is the matching promotion report's `minimumConfidence`, else the documented floor `DECISION_ESCALATION_FLOOR` (0.5). A record revoked by cancellation or policy drift is relabelled `escalate`.
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: applies the documented floor when no promotion threshold is in use
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: escalates failed calls, malformed or refused answers and low confidence
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: escalates a promoted answer the engine withholds below its threshold
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: relabels a revoked promoted record escalate when policy changes in flight
- AC3: Context completeness is recorded as `evidence.contextComplete`. A caller that cuts its state passes `stateTruncated: true`; the engine's routing, worker-selection and run-stage callers set it whenever they slice the objective. Context selection sets it for a batch when any candidate label is cut, either by `selectContext` at 220 characters or by its caller (`labelTruncated`, which the run stage sets when it cuts unsourced text to 160 characters). Oversized state is never truncated at dispatch: it abstains and escalates.
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: marks a routing decision with a cut objective as incomplete context
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: marks a context selection with a cut label as incomplete context
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: labels a promoted answer auto, but review when the caller truncated its state
- AC4: `action` is optional in stored data. Rows written before it existed still read back unchanged, without an action.
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: reads decision rows stored before the action label existed
- AC5: A decision provider has `hosting: "local" | "hosted"`. `laya` defaults to `local` and `jev` to `hosted`, so existing `decisions.json` files load unchanged. Other ids are allowed and must declare hosting. A local provider must use a loopback endpoint.
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: defaults hosting for the built-in ids and keeps existing decisions.json files loading
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: requires another id to declare hosting and keeps a local one on loopback
- AC6: The hosted privacy guard (separate `cloudState` and every question `exportable`), the offline-policy refusal, and the metered cost-cap and reservation rules key on `hosting === "hosted"`, never on the id. A hosted provider with another id refuses non-exportable state exactly as `jev` does and receives only `cloudState`.
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: a hosted provider with another id refuses non-exportable state exactly as jev does
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: sends a hosted provider with another id only its reviewed cloud state
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: applies offline policy and metered cost caps to any hosted id
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: refuses a hosted provider on a loopback endpoint by offline policy, not by endpoint
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: refuses hosted providers under local-only inference, even on loopback, but still asks a local one
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: checks hosted pricing against the cost cap and reservation ledger before any request
- AC7: A built-in id cannot be relabelled: `jev` configured `local` (or `laya` configured `hosted`) is refused when `decisions.json` loads and when `decideBatch` validates its providers. `providerHosting` returns a built-in id's fixed hosting even for an object that skipped validation.
  - Test: packages/engine/tests/decision-action-hosting.test.ts :: refuses a provider named jev configured as local instead of bypassing the guard
- AC8: Evaluation export accepts only `laya` and `jev` records. A record from another provider id fails the export with a message saying custom providers, hosted or local, are not yet supported in evaluation exports.
  - Test: packages/engine/tests/decision-evaluation.test.ts :: refuses to export a record from a custom provider id with a clear message

## Security considerations

The action label is advisory metadata; it grants no authority. `auto` is only
reachable through the existing promotion path, which today admits no route
because no verified grant issuer exists, so no live record is labelled `auto`.

Refusing a relabelled built-in id is stricter than defaulting it: a `jev`
entry marked `local` would otherwise receive raw local state with no export
review. Requiring an unknown id to declare hosting avoids guessing where it
runs; `providerHosting` still treats an undeclared unknown id as hosted.

Request and response formats are unchanged. A provider id outside `laya` and
`jev` cannot be promoted, because promotion evidence and route identity still
accept only those two ids; such a provider stays in shadow.

Tests use mocked HTTP and synthetic toy providers. No keys, live providers or
metered requests are used.

## Non-goals

No change to promotion evidence, route identity or grant schemas, no new
provider enrollment, no request or response format change, and no use of the
label to apply an answer.
