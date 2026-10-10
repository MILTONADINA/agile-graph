# MCP security coverage against the OWASP MCP Top 10

This page maps Graph Engineering's MCP guards and its `agent-config` scanner
rules to the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/)
(2025, beta). It covers two surfaces: the MCP server this engine runs
(`graph-engine mcp`), and the agent configuration in a scanned repository
(`graph-engine security-scan`, tool `agent-config`). Each `agent-config`
finding carries its IDs as tags, and SARIF output puts them in
`result.properties.tags` and in `rules[].properties.tags`.

A mapping says a guard bears on a risk, not that it removes it. Gaps are
listed for every entry.

## Scanner rules

| Rule                  | OWASP MCP IDs | What it reports                                                                              |
| --------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| `hook-command`        | MCP05         | A hook, status line or helper that runs a shell command                                      |
| `permission-widening` | MCP02, MCP07  | Broad allow entries, bypassed permission prompts and MCP auto-approval                       |
| `endpoint-override`   | MCP01, MCP04  | Environment overrides that redirect where an agent connects or which certificates it trusts  |
| `mcp-server`          | MCP04, MCP09  | Every declared MCP server, by program name or URL host, so a new or changed one needs review |
| `auto-run-task`       | MCP05         | Editor tasks that run when a folder opens or around debugging                                |
| `prompt-injection`    | MCP03, MCP06  | High-signal injection phrases, encoded blobs and hidden characters in instruction files      |
| `token-passthrough`   | MCP01, MCP07  | A server that forwards its caller's authorization token to a downstream server (names only)  |

## Coverage by risk

| ID    | Risk                                                 | Covered by                                                                                                                                                                                         | Gaps                                                                                                                                                                     |
| ----- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP01 | Token Mismanagement & Secret Exposure                | Server: credential screening of cloud results, secret-pattern refusal of context queries, call log stores argument hashes only. Scanner: `token-passthrough`, `endpoint-override`; secret scanners | No runtime check of tokens a client holds; `token-passthrough` matches variable, setting and flag names only, so a renamed variable or a proxy written in code is missed |
| MCP02 | Privilege Escalation via Scope Creep                 | Server: optional tools off unless allowed one by one (`--allow-tool`); cloud clients limited to `exportPaths`. Scanner: `permission-widening`                                                      | No per-call scopes; an allowed tool is allowed for the whole session                                                                                                     |
| MCP03 | Tool Poisoning                                       | Server: tool definition hashes (`mcp-tools --hashes`) and pinning (`mcp.toolHashes`, `--tool-hashes`) refuse a changed definition at start. Scanner: `prompt-injection`                            | Pins cover this server's own tools only, not third-party servers a client also connects to; the scanner reads repository files, not tool descriptions served at runtime  |
| MCP04 | Software Supply Chain Attacks & Dependency Tampering | Scanner: `mcp-server` (definition hash in the fingerprint), `endpoint-override`; dependency scanners; pinned SDK version and lockfile                                                              | No signature or provenance check of a declared server's package                                                                                                          |
| MCP05 | Command Injection & Execution                        | Server: runs execute in isolated workspaces and containers, need a person's plan approval over MCP. Scanner: `hook-command`, `auto-run-task`                                                       | The scanner reports commands, it does not judge whether one is safe                                                                                                      |
| MCP06 | Prompt Injection via Contextual Payloads             | Server: retrieved text is labelled evidence, not authority; only accepted mandatory memory is authoritative. Scanner: `prompt-injection`                                                           | Phrase and character heuristics only; injected text in indexed source can still reach a client as evidence                                                               |
| MCP07 | Insufficient Authentication & Authorization          | Server: stdio only, no network listener; approval is never an MCP tool. Scanner: `permission-widening`, `token-passthrough`                                                                        | No authentication of the stdio client; the operator's process launch is the trust boundary                                                                               |
| MCP08 | Lack of Audit and Telemetry                          | Server: `mcp_calls` log of every call with argument hash, tool definition hash and outcome (`mcp-log`)                                                                                             | Local log only; no export or tamper evidence                                                                                                                             |
| MCP09 | Shadow MCP Servers                                   | Scanner: `mcp-server` reports every declared server so an added one is held by the baseline                                                                                                        | Only servers declared in tracked files of the scanned repository; user-level and machine-wide client configuration is out of scope                                       |
| MCP10 | Context Injection & Over-Sharing                     | Server: `exportPaths` policy, offline-policy refusal, mandatory memory export authorization by exact-text hash, `run_status` off for cloud clients by default, result limitations as counts only   | Local clients receive everything the index holds by design                                                                                                               |
