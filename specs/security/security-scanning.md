# Security scanning and the run security gate

- ID: security-scanning
- Status: implemented
- Area: security

## Problem

Teams need security tools chosen for what their repository actually contains, with each choice explained, and a scan that fails only on findings nobody has reviewed. Once a team commits a reviewed baseline, every managed run should be gated on it, so a worker cannot introduce a new finding, hide one with a suppression, or slip in a file the scanners cannot read.

## Acceptance criteria

- AC1: `security-plan` lists every catalog tool as selected or skipped with a reason, chooses offline scanners by what the repository contains, and never selects dynamic testing without an authorized target.
  - Test: packages/engine/tests/security-catalog.test.ts :: explains every tool as selected or skipped
  - Test: packages/engine/tests/security-catalog.test.ts :: chooses offline scanners by what the repository contains
  - Test: packages/engine/tests/security-catalog.test.ts :: never selects dynamic testing without an authorized target
- AC2: Scanner reports are read into findings, and a report showing an incomplete scan makes the scan incomplete, never clean.
  - Test: packages/engine/tests/security-catalog.test.ts :: reads each scanner's JSON report into findings
  - Test: packages/engine/tests/security-catalog.test.ts :: refuses scanner reports that show the scan was incomplete
- AC3: Inline scanner suppressions are themselves reported as findings, so adding one needs review.
  - Test: packages/engine/tests/security-catalog.test.ts :: reports inline scanner suppressions so adding one needs review
- AC4: The scan gates only on findings missing from the reviewed baseline, and findings on repeated lines stay distinct.
  - Test: packages/engine/tests/security-catalog.test.ts :: gates only on findings missing from the reviewed baseline
  - Test: packages/engine/tests/security-catalog.test.ts :: keeps findings distinct when a file repeats the flagged line
- AC5: A managed run fails when its verified result adds a finding missing from the baseline or the scan is incomplete, and passes when all findings are in the baseline.
  - Test: packages/engine/tests/execution.test.ts :: fails a run whose verified result adds a finding missing from the reviewed baseline
  - Test: packages/engine/tests/execution.test.ts :: accepts a result whose findings are all in the baseline, and refuses an incomplete scan
- AC6: The run gate uses the baseline committed at the run's base commit, and fails on changed files no scanner could read (including files a non-fatal Semgrep error or skip names) or a malformed baseline.
  - Test: packages/engine/tests/execution.test.ts :: keeps the gate of the run's own base commit when the checkout changes
  - Test: packages/engine/tests/execution.test.ts :: refuses changed files the scanner could not read and malformed baselines
  - Test: packages/engine/tests/security-catalog.test.ts :: reports files a non-fatal Semgrep error or skip left unscanned
- AC7: A project with no committed baseline is not scanned during runs.
  - Test: packages/engine/tests/execution.test.ts :: does not scan a project that keeps no reviewed baseline
- AC8: The standalone scan and baseline update cover committed files only, so an untracked scratch file never enters a reviewed baseline.
  - Test: packages/engine/tests/hygiene.test.ts :: lists committed files only for the standalone scan
- AC9: New findings in a verified result go back to the worker as feedback within the attempt budget, and the run succeeds once they are fixed.
  - Test: packages/engine/tests/execution.test.ts :: returns new findings to the worker as feedback and succeeds once they are fixed
- AC10: With a downloaded OSV database, dependency lockfiles are scanned offline, one finding per package advisory; the download needs the OSV host allowlisted, and neither the download nor the scan resolves manifest dependencies through deps.dev (`--no-resolve`), so no declared package name leaves the container.
  - Test: packages/engine/tests/security-catalog.test.ts :: runs OSV-Scanner offline only once its database is downloaded
  - Test: packages/engine/tests/security-catalog.test.ts :: reads OSV-Scanner JSON into one finding per package advisory at the lockfile entry
  - Test: packages/engine/tests/security-catalog.test.ts :: downloads the database only when the policy allows the OSV host
  - Test: packages/engine/tests/security-osv-argv.test.ts :: downloads the OSV database without resolving manifest dependencies
  - Test: packages/engine/tests/security-osv-argv.test.ts :: scans lockfiles offline without resolving manifest dependencies
- AC11: Dependency advisories gate a run only for lockfiles the run changed; others are recorded as advisory.
  - Test: packages/engine/tests/execution.test.ts :: gates dependency advisories only on lockfiles the run changed
- AC12: Without a downloaded OSV database, a skipped dependency scan is recorded, and a run that changed a lockfile fails instead of passing unscanned; lockfile names match regardless of letter case (Cargo.lock, Gemfile.lock, Pipfile.lock), and Dart and Flutter's pubspec.lock (OSV's Pub ecosystem) is a lockfile. The failure, and a scan whose lockfile ecosystem has no downloaded database, say that the download needs the OSV host allowed and that the policy must then be restored exactly (a changed policy voids the run); the failure also says how to resume the run. Starting a run in a project with a committed baseline, lockfiles and no database records a warning before any worker is paid, without refusing the run.
  - Test: packages/engine/tests/execution.test.ts :: does not pass a run that changed a lockfile when no dependency database was downloaded (%s)
  - Test: packages/engine/tests/execution.test.ts :: warns when a run starts that a changed lockfile would stop it for want of a dependency database
  - Test: packages/engine/tests/security-osv-argv.test.ts :: says the download needs the OSV host allowed and the policy restored exactly
- AC13: The scan output's `baselineChanged` is true while the baseline differs from the committed version, including a new baseline that was never committed when Git is set to hide untracked files (`status.showUntrackedFiles=no`).
  - Test: packages/engine/tests/security-catalog.test.ts :: reports an uncommitted new baseline as changed when Git is set to hide untracked files
- AC14: What `security-scan` and `security-live-scan` print is redacted: every free-text field of a new finding (its message, resource and evidence) and every scan error, while the tool, rule, path, line, fingerprint and risk stay as recorded; tool output is redacted before it is shortened, so a secret the cut would split cannot leak. That includes a failing scanner's stderr, which `security-scan` records as a scan error and `security-db-update` prints when OSV-Scanner cannot download its database; Semgrep's error messages, whether a fatal one that makes the scan incomplete or a non-fatal one given as an unscanned file's reason; and Docker's stderr when `security-live-scan` cannot pull or start its target.
  - Test: packages/engine/tests/security-display.test.ts :: redacts a finding's free text but keeps the fields the engine compares
  - Test: packages/engine/tests/security-display.test.ts :: redacts output before cutting it, so a secret cut in half cannot leak
  - Test: packages/engine/tests/security-scan-redaction.test.ts :: is redacted before security-scan cuts it into a scan error
  - Test: packages/engine/tests/security-scan-redaction.test.ts :: is redacted before security-db-update cuts it into its error
  - Test: packages/engine/tests/security-scan-redaction.test.ts :: are redacted before a fatal one is cut into the scan error
  - Test: packages/engine/tests/security-scan-redaction.test.ts :: are redacted before a non-fatal one is cut into an unscanned file's reason
  - Test: packages/engine/tests/security-live.test.ts :: redacts Docker's stderr before cutting it when the target cannot be pulled or started
- AC15: When the scanner image cannot be inspected, `security-db-update` (and every other caller that looks up the scanner image, such as a run start with a committed baseline) says Docker is not running when the Docker daemon cannot be reached, and says the image is not built, with where to build it from, only when Docker is running.
  - Test: packages/engine/tests/security-osv-argv.test.ts :: says Docker is not running instead of telling the user to build the image
  - Test: packages/engine/tests/security-osv-argv.test.ts :: says the image is not built when Docker is running
- AC16: Ctrl-C, SIGTERM or SIGHUP (sent when the terminal closes) during `security-scan` or `security-db-update` stops the scan instead of ending the process at once. Scanner containers run in their own process groups, which a terminal's Ctrl-C does not reach, so the command kills each running scanner container by name and removes it, deletes its temporary copy of the repository (or of the lockfiles), and exits 130. Repeated signals are ignored until that cleanup finishes.
  - Test: packages/engine/tests/cli.test.ts :: security-scan on SIGINT stops its scanner container, removes its copy of the repository and exits 130
  - Test: packages/engine/tests/cli.test.ts :: security-scan on SIGHUP stops its scanner container, removes its copy of the repository and exits 130
  - Test: packages/engine/tests/cli.test.ts :: security-db-update on SIGTERM stops its scanner container, removes its copy of the repository and exits 130
- AC17: The worker's security feedback lists the first 20 new findings in full and summarizes the rest in one line counted by tool and rule, never dropping them silently. Each recorded new finding keeps its fingerprint, and `security.scan_completed` also records the fingerprints of up to 10,000 new findings, past the 200 listed in full, under `newFingerprints` (with `fingerprintsTruncated` when there were more). When the run has an earlier scan, a `security.verify_fix` event records which of that scan's new fingerprints are gone (`fixed`) and which remain (`stillPresent`), with `truncated` when the earlier list was cut. The record is informational: the gate still blocks on every finding that is new by fingerprint.
  - Test: packages/engine/tests/execution.test.ts :: summarizes security findings past the first 20 and records which earlier findings were fixed
  - Test: packages/engine/tests/execution.test.ts :: compares every earlier new fingerprint, not only the 200 listed in full
- AC18: The built-in `agent-config` tool is in the catalog as an offline tool, selected with a reason only when a Claude Code settings file, an MCP configuration file (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`) or an agent instruction file is tracked, matched by exact name so an example file is not configuration; `security-scan` runs it in-process, with no container, over the same tracked files and records its findings with fingerprints.
  - Test: packages/engine/tests/security-agent-config.test.ts :: is selected, with a reason, only when agent configuration is tracked
  - Test: packages/engine/tests/security-agent-config.test.ts :: runs in-process inside security-scan, with no container, and redacts its findings
- AC19: Rule `hook-command` reports each `type: "command"` hook, the status line command and each helper command (such as `apiKeyHelper`) in `.claude/settings*.json` at any depth, one finding per command; settings-named files outside `.claude/` are not read.
  - Test: packages/engine/tests/security-agent-config.test.ts :: reports each hook, status line and helper command once, without the command
  - Test: packages/engine/tests/security-agent-config.test.ts :: ignores files that are not Claude Code settings
- AC20: Rule `permission-widening` reports broad `permissions.allow` entries (a bare or wildcard `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` or `WebFetch`, `mcp__*`, `*`), `defaultMode: "bypassPermissions"` and `dangerouslySkipPermissions: true`, and does not report narrow entries such as `Bash(npm test:*)`.
  - Test: packages/engine/tests/security-agent-config.test.ts :: flags broad allow entries and bypassed permission prompts only
- AC21: Rule `mcp-server` reports one finding per server declared in `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` (JSON with comments and trailing commas) or `.codex/config.toml` (read without a TOML parser); a configuration file that does not parse is listed as unscanned, without the parser's message.
  - Test: packages/engine/tests/security-agent-config.test.ts :: reports one finding per server in each config format, with hosts only
  - Test: packages/engine/tests/security-agent-config.test.ts :: reads Codex servers from config.toml without a TOML parser
  - Test: packages/engine/tests/security-agent-config.test.ts :: reports a configuration file it cannot parse as unscanned
- AC22: Rule `prompt-injection` reports lines of agent instruction files (AGENTS.md, AGENTS.override.md, CLAUDE.md, CLAUDE.local.md, GEMINI.md, SKILL.md, `.cursorrules`, `.cursor/rules/**`, `.github/copilot-instructions.md`) that tell the agent to ignore previous instructions or disregard the system prompt, pipe `curl` or `wget` to a shell, ask to send something to an http(s) URL, hold an encoded blob over 200 characters, or hold invisible or bidirectional-control Unicode; ordinary instruction text and other Markdown files are not reported.
  - Test: packages/engine/tests/security-agent-config.test.ts :: flags high-signal phrases, blobs and hidden characters in instruction files
  - Test: packages/engine/tests/security-agent-config.test.ts :: stays quiet on ordinary instruction text and non-instruction files
- AC23: Agent configuration findings gate through the reviewed baseline: an unchanged accepted hook stays accepted, while an added hook, an added MCP server or a changed accepted command is a new finding.
  - Test: packages/engine/tests/security-agent-config.test.ts :: gates an added hook through the reviewed baseline
- AC24: Agent configuration findings never record a command, its arguments or path, an environment value, a full URL or the matched instruction text: a hook is named by its event, a program only by a bare name, a remote server only by its host and an injection by the pattern that matched.
  - Test: packages/engine/tests/security-agent-config.test.ts :: runs in-process inside security-scan, with no container, and redacts its findings
  - Test: packages/engine/tests/security-agent-config.test.ts :: reports one finding per server in each config format, with hosts only
  - Test: packages/engine/tests/security-agent-config.test.ts :: flags high-signal phrases, blobs and hidden characters in instruction files

## Security considerations

Repository files, including scanner configuration files, are hostile input. AI-agent configuration is treated as attack surface too: hooks, broad permissions, MCP servers and injection text in instruction files are findings, read in-process without executing anything, and recorded without the commands, URLs or text they hold. The container scanners run in a container with no network and all capabilities dropped, against a private copy, and scanner configuration in the repository is scanned under a neutral name so it cannot reconfigure the tools. The baseline is an acceptance of risk, so it is written only when a person asks and the run gate reads it from the base commit, not the working tree, so an uncommitted edit or later checkout cannot switch the gate off. Dynamic tools (ZAP, Nuclei, Burp Suite) are never run against live systems without an authorized target; the only dynamic scan is the person-started ZAP baseline scan of [live targets](live-targets.md) the scan starts itself. The planted-findings end-to-end test runs only when the scanner image has been built locally.

## Non-goals

The graph does not download vulnerability databases for dependency scanners, does not scan or attack running systems, does not render Helm charts, and does not create a baseline automatically. The agent-config tool does not judge whether a hook, permission or MCP server is benign (a person does, through the baseline), does not read agent configuration outside the repository's tracked files, and does not try to detect every possible prompt injection.
