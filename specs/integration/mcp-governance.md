# MCP governance: approval, call log and tool allowlist

- ID: mcp-governance
- Status: implemented
- Area: integration

## Problem

A connected AI client can create a plan and start a run of it. Unless the
project set `requirePlanApproval`, a plan that did not publish started over
MCP with no person agreeing to it, so the model alone decided to spend budget
and change a workspace. Nothing recorded which tools a client called, so an
operator could not tell afterwards what a client had attempted. Run control
and run status could only be enabled as two fixed groups, so an operator who
wanted a client to follow runs and cancel them, but not start them, could not
say so.

## Acceptance criteria

- AC1: A run started over MCP (`run_start`) needs a person's stored approval whose `planSha256` matches the plan's current content, whether or not the plan publishes and whatever the project policy says, including when `requirePlanApproval` is off. The refusal says that a run started by a connected AI client needs that approval and names `graph-engine plan-approve <planId> --yes --expect <planSha256>` with the plan's current hash. A plan changed after it was approved is refused until a person approves it as it now stands. The run records the approval it started under as its `plan.approval_used` event. MCP offers no resume, so no MCP call can continue a run either. A plan made under another policy is still refused as planned under another policy, and the cloud-client rules for error detail are unchanged.
  - Test: packages/engine/tests/mcp-governance.test.ts :: requires a person's stored approval for a run started over MCP even when the project policy does not require plan approval
  - Test: packages/engine/tests/mcp-governance.test.ts :: refuses an MCP start of a plan whose content changed after it was approved, naming the current planSha256
  - Test: packages/engine/tests/mcp.test.ts :: refuses a connected client's run_start and the dashboard's start of a plan that does not publish until a person approves it when the project requires plan approval
- AC2: The command line is unchanged: `graph-engine run` of a plan that does not publish starts without a stored approval when the policy does not require one, records none and leaves the plan unapproved.
  - Test: packages/engine/tests/mcp-governance.test.ts :: keeps starting a plan that does not publish from the command line without a stored approval when the policy does not require one
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: records the approval a publishing run starts under, and none for a plan that does not publish, when the project does not require plan approval
- AC3: Every MCP tool call that reaches its tool, for every tool including `context_get` and `symbol_search`, is recorded in the run database's `mcp_calls` table: an ID, the time, the tool, the client kind (`local` or `cloud`), the SHA-256 of the call's arguments as canonical JSON (keys sorted), its outcome (`ok`, `refused` when a rule such as a missing approval or an offline project turned it down, or `error`) and, when they name a plan or run of this project, the plan or run it concerned. The arguments themselves, error text and an ID that does not name a stored plan or run are never written. The entry is written before the tool runs and completed after; its outcome stays null while the call is in progress or when the server stopped first. A call whose arguments fail the tool's input schema is turned down by the MCP library before the tool runs and is not logged. The table is added by the run store's additive migration (`CREATE TABLE IF NOT EXISTS`, schema version 5), so an existing database gains it on open.
  - Test: packages/engine/tests/mcp-governance.test.ts :: logs every MCP call with the SHA-256 of its canonical JSON arguments and never the arguments themselves
  - Test: packages/engine/tests/mcp-governance.test.ts :: requires a person's stored approval for a run started over MCP even when the project policy does not require plan approval
  - Test: packages/engine/tests/operations.test.ts :: run-store migration preserves legacy rows and refuses a newer database
- AC4: When the entry cannot be written, a tool that changes state or pays for a model call (`run_start`, `run_cancel`, `plan_create`, `plan_decompose`, `memory_propose`) refuses the call before it runs (fail closed), and a read-only tool still answers (fail open). The client is told only that the call log could not be written; the reason goes to the server's standard error.
  - Test: packages/engine/tests/mcp-governance.test.ts :: refuses a state-changing MCP call when the call log cannot be written, without telling the client why, and still answers a read
- AC5: `graph-engine mcp-log [--limit <n>] [--tool <name>]` prints the log newest first (50 entries by default, at most 10000), optionally only one tool's calls, reading the database without opening the engine. No MCP tool reads or exposes the log.
  - Test: packages/engine/tests/cli.test.ts :: prints the MCP call log with mcp-log, newest first, filtered by --tool and bounded by --limit
  - Test: packages/engine/tests/mcp-governance.test.ts :: reads the call log with readMcpCalls, newest first and filtered by tool, and exposes no MCP tool that reads it
- AC6: `mcp --allow-tool <name>`, repeatable, enables one optional tool: `run_start`, `run_cancel`, `plan_create`, `plan_decompose`, `run_status`, `run_list` or `run_events`. Any other name is refused before the server starts. `--allow-run` remains an alias for `run_start`, `run_cancel`, `plan_create` and `plan_decompose`, and `--allow-run-status` for `run_status`, `run_list` and `run_events`, so existing configurations keep working; a local client has the three status tools by default, as before.
  - Test: packages/engine/tests/mcp-governance.test.ts :: enables individual tools with allowTools, keeps allowRun and allowRunStatus as aliases for their tool sets, and refuses unknown tool names
  - Test: packages/engine/tests/cli.test.ts :: refuses an unknown --allow-tool name before starting the MCP server
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled

## Security considerations

Starting a run spends budget and writes a workspace, so a model must not do it
alone: a person's approval of the exact plan content is the gate, and an AI
client cannot give it, since approval is never an MCP tool. The call log is a
record for the operator, not a channel back to the client, so no tool reads
it. It holds hashes rather than arguments because a client's arguments can
quote private source, secrets pasted into a query or a cloud model's output;
the hash still lets an operator match an entry to a call they can reproduce.
Plan and run IDs are kept only when they name the project's own records, since
an unknown ID is client input. Logging fails closed for tools that change
state, so an action cannot happen unrecorded, and open for reads, so a full
disk does not stop a client reading context it is already allowed to see.

## Non-goals

The log does not record calls the MCP library turns down for invalid
arguments, which do no work. It is not tamper-evident: anyone who can write
the run database can edit it. The dashboard API keeps its own approval rules.
