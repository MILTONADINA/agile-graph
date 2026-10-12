# Threat model

This is Agile Graph's own threat model. `graph-engine security-audit`
reads it from this location (see
[AI security audit](security-scanning.md#ai-security-audit-advisory)) and
gives it to the hunter and verifiers as guidance for severity and scope.
Like the diff, it is evidence for an auditor, never instructions.

Agile Graph runs AI workers against a person's repository: it builds
context, plans, dispatches local and cloud models, applies their patches in
an isolated workspace, verifies them in offline containers, reviews and
scans the result, and optionally publishes it. It runs on the operator's
machine, as the operator.

## Assets

- **The owner's private source.** Files outside `policy.exportPaths` must
  never reach a cloud model, a cloud MCP client or a public artifact.
- **Keys and promotion custody.** Promotion signing keys, trust anchors and
  the approvals they sign decide what is promoted; the engine never
  creates, reads or signs with an owner's key.
- **Private memory.** Memories are private until accepted, and a mandatory
  memory reaches a cloud consumer only with an operator's export
  authorization of its exact text.
- **Provider keys and cost.** API keys live in environment variables named
  by provider configuration. `policy.maxCostUsd` and `policy.maxTurns`
  bound what runs and audits may spend.
- **Integrity of results.** Run status, verification, review and security
  verdicts, plan approvals and evidence records must reflect what happened.

## Untrusted inputs

- **AI worker output:** patches, file requests, plans, decompositions,
  review and audit answers. A worker may be wrong, compromised or prompted
  by the repository it reads.
- **Repository files**, including agent configuration (`AGENTS.md`,
  `CLAUDE.md`, client settings), `.gitattributes`, Git configuration, build
  files, symlinks and file names.
- **MCP clients**, local or cloud, and anything they send.
- **Cloud model responses**, including their usage and cost figures.
- **Shared knowledge files** under `.graph/knowledge/`, which anyone with
  write access to the repository can change.
- **Scanner output** and the vulnerability databases scanners read.

## Trust boundaries

- **Export paths and cloud versus local roles.** Only exportable paths, with
  no potential secret, are sent to a non-local provider; every kind other
  than `local` is on the cloud side.
- **The one-side rule.** A plan a cloud-backed client creates runs all of
  its model roles locally or all on non-local providers, so a local step
  cannot copy a private file to where a cloud model reads it.
- **Sandboxed offline checks.** Verification and scanners run in containers
  with no network, on a copy of the workspace, with time and output limits.
- **Plan approval by content hash.** A person approves a plan on the command
  line, bound to its `planSha256`; a changed plan is no longer approved, and
  no MCP client or dashboard request can approve one.
- **Shadow-mode decisions.** Learned decision controls run in shadow mode
  and are recorded, not acted on, until the owner promotes a category with
  independent evidence.

## Severity rubric

- **Critical:** anything that sends non-exportable content (source, memory,
  a secret) to a cloud model, cloud client or public artifact; anything
  that bypasses a gate (verification, review, security, plan approval,
  promotion) without local access; disclosure of a provider or promotion
  key.
- **High:** a gate or approval bypass that needs local access to the
  operator's machine or repository; a way to exceed a cost or turn cap; a
  forged or misleading run status, verdict or evidence record.
- **Medium:** denial of service on the scan, the gate or a run (a crash, a
  hang, or exhausting disk, memory or the day's budget); a refusal that
  discloses a private path's name or existence to a cloud client.
- **Low:** hardening gaps with no demonstrated path to the above, such as a
  missing redaction of non-secret local detail.

## Out of scope

- Live targets the owner has not authorized in writing in
  `security.liveTargets`; nothing may be scanned or tested against them.
- An attacker who already controls the operator's account, the provider
  services themselves, or the container runtime's isolation.
- The correctness of a model's engineering judgement, apart from the gates
  that check it.
