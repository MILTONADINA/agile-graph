# Security scanning

Agile Graph chooses security tools for a repository and explains each
choice, instead of running every scanner it knows. The offline scanners run
against a private copy of the tracked files with the network disabled, and a
scan fails only on findings the team has not reviewed: every existing
finding is either fixed or recorded in a reviewed baseline, as professional
teams do. Tools that need a vulnerability database are recommended with what they
still need. Dynamic testing runs only when a person starts it against a
target the owner authorized in writing, in containers the scan starts
itself (see [live targets](#live-targets)); the graph never scans a system
it did not start, and managed runs never scan a live target.

## Choosing tools

```sh
graph-engine security-plan
```

prints every catalog tool as `selected` (with the reason it applies) or
`skipped` (with the reason it does not). The catalog is in
[`security/catalog.ts`](../packages/engine/src/security/catalog.ts):

| Tool                                    | Checks                                                     | Runs                                                            | Chosen when                                       |
| --------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Gitleaks                                | Credentials in tracked files                               | Offline                                                         | Always                                            |
| Semgrep with the Semgrep Rules registry | Security rules for the languages present                   | Offline                                                         | Source in a supported language exists (not C++)   |
| Hadolint                                | Dockerfile practices (warnings and errors)                 | Offline                                                         | A Dockerfile or Containerfile exists              |
| Checkov                                 | Terraform, Kubernetes, CloudFormation and Bicep            | Offline                                                         | Such files exist                                  |
| Agent configuration review (built in)   | AI-agent hooks, permissions, MCP servers, instruction text | Offline, in-process (no container)                              | An agent settings, MCP or instruction file exists |
| OSV-Scanner, Trivy                      | Known-vulnerable dependencies                              | Needs a local vulnerability database                            | Dependency lock files exist                       |
| OWASP ZAP (baseline scan)               | Running web targets, spider and passive checks             | Only `security-live-scan`, started by a person                  | A live target is authorized                       |
| Nuclei                                  | Running web targets, active checks                         | Not run: active attack scans are out of scope                   | A live target is authorized                       |
| Burp Suite Professional                 | Running web targets                                        | Needs the user's licensed installation and an authorized target | The user configured it and a target is authorized |

## Scanning

Build the scanner image once, from the Agile Graph repository. Building
needs network access. The base image is pinned by digest, the Gitleaks and
Hadolint binaries by version and SHA-256, Semgrep and Checkov by version, and
the rules by commit. The rules use the Semgrep Rules License v1.0, which
limits redistribution, so build the image locally rather than publishing it.

```sh
docker build -t graph-security:local sidecars/security
graph-engine security-scan
```

`security-scan` copies the tracked (committed or staged) files into a private
directory, runs the selected offline scanners there with no network and all
capabilities dropped, and prints the findings that are not in the baseline.
Untracked scratch files are never scanned into a baseline; the managed-run
gate below scans files a worker creates separately. It exits
non-zero when there are new findings or a scanner's report could not be read.
Ctrl-C, SIGTERM or SIGHUP stops the scan: it kills and removes the running
scanner container, deletes the private copy and exits with code 130
(`security-db-update` handles them the same way). Repeated signals are
ignored until that cleanup finishes.

- Only Semgrep rules categorised as security count; the registry's style and
  portability rules do not. Semgrep's default ignore list (which skips
  `tests/`) and its 1 MB file limit are overridden, so everything the team
  tracks is scanned.
- Scanner configuration files in the repository (`.gitleaks.toml`,
  `.gitleaksignore`, `.semgrepignore`, `.hadolint.yaml`, `.checkov.yaml`)
  are scanned under a neutral name, so a secret in one is still found but no
  tool reads it as configuration. Inline suppressions are ignored where the
  tool allows it, and every suppression — `nosemgrep`, `gitleaks:allow`,
  `hadolint ignore`, `checkov:skip` or `bridgecrew:skip`, a
  `checkov.io/skip` annotation or CloudFormation `checkov` metadata — is
  itself reported as a finding, so a change cannot quietly switch its
  scanners off.
- A tool's result counts only when it exits normally and its report parses
  with no errors; Checkov files it cannot parse, Semgrep rule errors and
  unexpected exit codes make the scan incomplete, never clean. The error
  quotes the end of the tool's stderr, redacted before it is cut, so a
  secret the cut would split cannot leak; `security-db-update` quotes a
  failed download the same way, and a Semgrep error message is redacted
  before it is cut too.
- Files no scanner can read (binary content, larger than 50 MB, or not a
  regular file) are listed under `unscanned`, as are files a non-fatal
  Semgrep error (such as a timeout or parse failure) names, with Semgrep's
  reason redacted. Files Semgrep skips because no selected rule covers
  their language are not counted.
- A finding's fingerprint combines the tool, rule, file, the resource the
  tool names, and the text of the flagged line with two lines either side,
  so it survives edits elsewhere and two resources flagged at similar lines
  stay distinct.
- Helm charts are not covered: their templates must be rendered first, and
  the image has no Helm renderer.

## Agent configuration

AI-agent configuration is an attack surface: a hook runs a shell command on
every developer machine that opens the repository with that agent, a broad
permission lets the agent act without asking, an MCP server gives it new
tools and network reach, and an instruction file can carry text that steers
it. The built-in `agent-config` tool reads these files in-process, over the
same tracked files as the other scanners, and reports ordinary findings with
the tool name `agent-config`:

| Rule                  | Files                                                                                                                                                                                                                                    | Reports                                                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook-command`        | `.claude/settings*.json` at any depth                                                                                                                                                                                                    | Each hook (`command`; `http`, by its host; `prompt` and `agent`), the `statusLine` command and the `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport` and `otelHeadersHelper` commands, one finding each                                                                                                     |
| `permission-widening` | `.claude/settings*.json`                                                                                                                                                                                                                 | `permissions.allow` or legacy `allowedTools` entries such as `Bash`, `Bash(*)`, `Write(*)`, `Edit(**)`, `WebFetch(domain:*)`, `mcp__*` or `*`; `defaultMode: "bypassPermissions"`; `dangerouslySkipPermissions: true`; `enableAllProjectMcpServers: true`; each server in `enabledMcpjsonServers`                 |
| `endpoint-override`   | `.claude/settings*.json`                                                                                                                                                                                                                 | `env` variables that redirect the agent's connections, by name only: `*_BASE_URL` (such as `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`), `*_API_URL`, `*_API_BASE`, `*_ENDPOINT` (such as `OTEL_EXPORTER_OTLP_ENDPOINT`), `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and extra CA bundles such as `NODE_EXTRA_CA_CERTS` |
| `mcp-server`          | `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json` (`mcpServers`), `.vscode/settings.json` (`mcp.servers`), all with comments and trailing commas allowed, and `.codex/config.toml` (`[mcp_servers.*]` tables) | One finding per declared server                                                                                                                                                                                                                                                                                   |
| `prompt-injection`    | `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `SKILL.md`, `.cursorrules`, `.windsurfrules`, `.cursor/rules/**`, `.github/copilot-instructions.md`                                                      | Lines telling the agent to ignore previous instructions or disregard the system prompt, `curl`/`wget` piped to a shell, "send … to http(s)://…", encoded blobs over 200 characters, invisible or bidi Unicode                                                                                                     |

Files are matched by exact name, so an example such as
`.cursor/mcp.example.json` is not read as configuration. A narrow
permission such as `Bash(npm test:*)` is not reported, and the injection
phrases are a short, conservative list chosen to keep false positives low;
the rule is a tripwire for review, not a classifier. The invisible-Unicode
check reports zero-width spaces, a byte-order mark after the start of the
file, bidi embeddings, overrides and isolates and tag characters, but not the
zero-width joiner of emoji sequences or the left-to-right and right-to-left
marks of mixed-direction text. Claude Code custom commands and subagent
definitions (`.claude/commands/`, `.claude/agents/`) are not read.

Every file is hostile input. No pattern is built from file content, every
pattern's gaps are bounded, long lines are checked in overlapping 4 KB
windows (so a phrase at the end of a long line is still found), and lines
are located through one index per file, so the check stays linear in the
size of the file. A file whose analysis fails anyway is listed under
`unscanned` like one that does not parse, and the other files are still
checked.

Findings never hold a command, its arguments, an environment value or a full
URL. A hook is named by its event (`hooks.PostToolUse`), a server by its
name, a program only when the command starts with a bare program name
(`node`, never a path) and a remote server only by its host. An
injection finding names the pattern that matched, not the text. The
fingerprint still covers the declaring lines, so editing an accepted hook's
command makes it a new finding. For an MCP server, it also covers a hash of
the server's definition (type, command, arguments, URL, working directory
and the names, not the values, of its environment variables and headers),
and for a hook a hash including its matcher, so changing a server's URL or
arguments however far below its name, or widening a hook's matcher, is a new
finding too, while rotating an environment value or editing elsewhere in the
file is not. The hash is part of the fingerprint only and is not recorded. A configuration file that does not parse is
listed under `unscanned` instead of being passed unchecked.

Because the findings go through the same baseline, a worker in a managed
run that adds a hook, widens a permission, declares an MCP server or plants
an injection phrase produces a new finding that blocks the run until it is
fixed or a person accepts it into the baseline.

## The baseline

`.graph/security-baseline.json` is the team's register of reviewed findings,
tracked in Git and changed only through a reviewed commit. After reviewing
every current finding, record them with:

```sh
graph-engine security-scan --update-baseline
```

It refuses to update the baseline from an incomplete scan. A baseline is an
acceptance of risk, so it is written only when a person asks for it; no
command creates one automatically. The scan output's `baselineChanged` is
true while the baseline differs from the committed version, including a new
baseline that was never committed when Git is set to hide untracked files,
so accepting risk without a reviewed commit is visible.

To load the findings into a code host, an editor or another review tool,
add `--sarif <file>`. The scan then also writes every finding as SARIF 2.1.0.
Tool-quoted text is redacted as it is in the scan output, and each result's
`baselineState` says whether the reviewed baseline already holds it (`unchanged`)
or not (`new`). Each result's `artifactLocation` is the repository-relative
path with every segment percent-encoded (a space, `#`, `%` or non-ASCII
character), relative to `uriBaseId` `%SRCROOT%`, the repository root. The
log's one invocation has `executionSuccessful: false` when the scan had
errors or files no scanner could read, and lists each redacted error and
each unscanned path under `toolExecutionNotifications`, so a tool reading
the log cannot take an incomplete scan for a clean one.

With the image built, `GRAPH_ENGINE_SECURITY_IMAGE=1 npm test -w
@agile-graph/engine -- tests/security-catalog.test.ts` scans planted
findings, scanner configuration and suppressions and checks the baseline.

## Managed runs

A project that commits `.graph/security-baseline.json` gates every managed
run on it. The gate uses the baseline committed in the commit the run
started from, so neither an uncommitted edit nor a later checkout, branch
switch or commit can accept findings or switch the gate off for that run; a
malformed baseline, or a Git error reading it, fails the run. When a run starts, the engine checks that the
scanner image (`graph-security:local`) is built, before any worker is paid.
Each time a result passes the required checks (and review, when a reviewer
is configured), it scans the run's verified workspace, including files the
worker created, and records `security.scan_completed`.

- A finding missing from the baseline is returned to the worker as feedback
  (tool, rule, file and line) and the worker tries again within
  `policy.maxAttempts`, as for failed checks; a run that still has new
  findings fails with a message naming the security scan.
- An incomplete scan, or a file the run's workers wrote that no scanner
  could read (for example one made "binary" by a NUL byte), stops the run
  for a person.
- Dependency advisories (OSV-Scanner) gate a run only for lockfiles the run
  changed. A newly published advisory about a dependency the run did not
  touch is recorded under `advisory` in `security.scan_completed` instead of
  failing unrelated work.
- `security.scan_completed` lists up to 200 new findings in full and records
  the fingerprints of up to 10,000 under `newFingerprints`
  (`fingerprintsTruncated` when there were more). On the run's next scan a
  `security.verify_fix` event says which of those fingerprints are gone
  (`fixed`) and which remain (`stillPresent`), with `truncated` when the
  earlier list was cut. It is informational: the gate blocks on whatever is
  still new.
- Dependency scanning needs a downloaded OSV database. Without one, the
  skipped scan is recorded as `security.tool_not_run`, and a run that
  changed a lockfile (Dart and Flutter's `pubspec.lock` among them) fails
  rather than passing unscanned. When the project
  has lockfiles but no database, starting a run records
  `security.database_missing` and `graph-engine run` prints it as a
  warning, before any worker is paid; the run is not refused, since one
  that changes no lockfile passes the gate without a database.
- `security-db-update`, like `security-scan`, needs Docker running and the
  scanner image built; it says which one is missing, so a stopped Docker
  daemon is reported as `Docker is not running` rather than as an image to
  build.
- To download the database, `graph-engine security-db-update` needs
  `policy.network: "allowlisted"` with
  `osv-vulnerabilities.storage.googleapis.com` in `allowedHosts`. A plan
  and its runs are bound to the exact policy the plan was made under, so
  `run` and `resume --reconciled` refuse a changed one. After the download,
  restore `.graph/project.json` exactly as it was (undo the edit, or
  `git checkout .graph/project.json` when the policy was committed), then
  resume the stopped run with `graph-engine resume <run-id> --reconciled`.
  Do not plan it again: resuming keeps the retained change, while a fresh
  plan pays for the work again.

A run that fails the gate is never published. Scanner containers are named, so
cancelling a run stops them, and each tool is bounded by the policy's
`timeoutSeconds`.

A project without a baseline is not scanned, so runs never depend on the
scanner image unless the team has adopted it. When such a run changes
security-sensitive paths, it records `security.scan_recommended`, and its
completion still reports that security review is pending.

## Live targets

Dynamic testing sends attack traffic, so the graph tests only software it
starts itself, from images the owner authorized in writing. Targets are
declared in `.graph/project.json`:

```json
"security": {
  "liveTargets": [
    {
      "id": "juice-shop",
      "image": "bkimminich/juice-shop@sha256:<64 hex>",
      "port": 3000,
      "path": "/",
      "authorizedBy": "Milton Adina (owner)",
      "authorizedOn": "2026-09-27",
      "note": "What was authorized and on whose instruction"
    }
  ]
}
```

Each entry needs an ID, an image pinned by digest (`name@sha256:<digest>`,
or a local image ID `sha256:<digest>`), the port it serves, who authorized it
and when, and a note; `path` is optional. The project configuration is
refused when any of these is missing, when an image is only a tag, or when
two targets share an ID. There is no URL field: a scan cannot be pointed at
a host.

```sh
graph-engine security-live-scan juice-shop
```

The command, which has no MCP tool or dashboard action:

1. refuses a target ID that is not declared, before touching Docker;
2. resolves both images to local IDs, pulling a digest-pinned image when it
   is missing (a local image ID is never pulled);
3. starts the target with `--network none`: a network namespace of its own
   with only a loopback interface, so it has no route, no gateway and no
   host address to reach, and nothing is published to the host. All
   capabilities are dropped and `no-new-privileges` is set;
4. runs a short-lived probe inside that namespace
   (`--network container:<target>`), which first checks isolation: the
   namespace must have no IPv4 route and no IPv6 route off loopback, and
   connections to the Docker bridge gateway (read from
   `docker network inspect bridge`) and to 1.1.1.1 must fail as
   unreachable, or the scan is refused before ZAP starts. It then waits, for
   at most three minutes, until the target answers HTTP at 127.0.0.1;
5. runs the ZAP baseline scan inside the same namespace (`zap-baseline.py -I`, one minute of
   spidering by default, `--minutes` up to 10, and a bounded overall time)
   from `ghcr.io/zaproxy/zaproxy` pinned by digest (ZAP 2.17.0), writing its
   JSON report to a private temporary directory;
6. always removes every container labelled with the scan's ID
   (`graph-engineering.live-scan.id`), found with `docker ps --filter`, so a
   container whose `docker run` was cancelled before it returned is removed
   too; then checks nothing with that label is left, deletes the report
   directory, and names anything it could not remove. This happens when the
   scan fails too, and on Ctrl-C, SIGTERM or SIGHUP (exit code 130); repeated
   signals are ignored until cleanup finishes.

The scan needs Docker Engine 26 or later, and refuses an older or
unreadable server version: older engines forwarded DNS out of internal
networks. With no network at all this is defence in depth.

An earlier design used a `docker network create --internal` network. On
Docker Desktop its gateway address answered from the Docker host (the host
refused connections to closed ports and listened on others), so a target
could have reached host services; the loopback-only namespace has no such
address. ZAP's JSON report is read without following a symlink, only as a
regular file of at most 20 MB, and errors never quote it. When Docker
cannot pull or start the target, the error quotes the end of its stderr,
redacted before it is cut.

ZAP's report is read into findings with tool `zap`: one finding per alert
(rule `<pluginid> <name>`) and URL path, with the host and query dropped and
evidence redacted. Only the redacted findings are printed; the raw report is
deleted. The fingerprint combines the tool, rule, path and target ID, so it
is stable across runs whatever the container name, evidence or number of
instances. ZAP's spider can still reach different pages from one run to the
next, so a path found only on some runs appears as new on those runs.

Findings are advisory. They are compared with their own reviewed baseline,
`.graph/security-live-baseline.json`, in the same format as the static
baseline, with each entry also naming its target. After reviewing a
target's findings, `graph-engine security-live-scan <target-id>
--update-baseline` replaces that target's entries and keeps the others.
The command exits non-zero on new findings, as `security-scan` does, but no
managed run reads the live baseline or runs a live-target tool:
`security-plan` names the authorized targets and shows `runWith`, and
`runnable` stays false. A failed scan is recorded for
[feedback](feedback.md) only as the `live-scan` kind, never with report
content.

### This repository's targets

| ID           | Image                                                                                                    | Why                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `juice-shop` | `bkimminich/juice-shop@sha256:73c53fbf442e8337b3ea3d98c7e8550308854701ebdfce4cc39768f36b75430e` (20.2.0) | OWASP's intentionally vulnerable reference application; a scan that finds nothing here is broken |

The owner authorized it on 2026-09-27.

With Docker running, `GRAPH_ENGINE_LIVE_SCAN_TESTS=1 npm test -w
@agile-graph/engine -- tests/security-live.test.ts` scans Juice Shop
end to end and checks that no container with the scan's ID label is left,
and probes a loopback-only namespace to show that the Docker bridge gateway
and 1.1.1.1 are unreachable from it; CI runs these in the scanner job.

## AI security audit (advisory)

```sh
graph-engine security-audit <run-id>
```

audits the change a stopped run made (succeeded, failed or cancelled, with
its workspace retained) with the project's security auditor, following
the method of Cloudflare's
[security-audit skill](https://github.com/cloudflare/security-audit-skill)
(MIT). It is advisory: it records `security.audit_completed` on the run and
prints the result, and it never gates, completes or fails a run, nor changes
its status, outcome or review. Only the owner can decide to make it
blocking; nothing in the engine does.

```sh
graph-engine auditor <provider-id>   # or --clear; no argument shows it
```

sets the auditor (`audit.providerId` in `.graph/project.json`), and
`graph-engine auditor --threat-model <path>` sets `audit.threatModel`. It is
separate from the reviewer because configuring a reviewer turns on the
review gate for every managed run; without an auditor the audit uses the
reviewer, and with neither it refuses. The audit first checks the vendored
Cloudflare files against their pinned digests, before any provider is
looked up or paid. Ctrl-C cancels it.

The audit gives the project's threat model, when it has one, to the hunter
and every verifier as guidance on how the project rates severity, where
untrusted input enters and what is out of scope, as Anthropic's
[OSS Scanner](https://github.com/anthropics/oss-scanner) does with its
optional `threat_model.md`. It reads `audit.threatModel`, which must exist,
or else the first that exists of `threat_model.md`,
`.oss-scanner/threat_model.md` and `docs/threat-model.md`; a project with
none is audited without one. The text is evidence, never instructions. It
goes through the same secret screen and context budget as the diff, and a
cloud auditor is refused (recording `security.audit_refused`) a threat
model outside `policy.exportPaths`. `security.audit_completed` records the
path and SHA-256 used. This repository's own is
[docs/threat-model.md](threat-model.md).

1. Budget first. Up to 10 verifier calls are reserved before the hunt, as
   Cloudflare's method does, and then one hunter call, through the same
   reservation path as reviewer calls. A day's audits share one cost owner,
   so `policy.maxTurns` and `policy.maxCostUsd` bound them apart from any
   run's own budget. When the budget leaves room for fewer verifications,
   fewer are reserved; with no room for one, the audit refuses before
   hunting, and says whether the turn limit or the cost cap stopped it.
   Unused reservations are given back after the hunt, and so is the
   reservation of a call the auditor refused before sending it.
2. Hunt. One call receives the run's diff (built as for code review) and a
   compact attack-class checklist, and returns candidate findings only. Its
   output contract has no verdict.
3. Verify. Each candidate, up to the number reserved, goes to a separate
   verifier call that sees only that candidate and the diff and tries to
   disprove it: a complete trace from entrypoint through propagation to
   sink (with evidence and a reproduction), `needs_validation` (with the
   missing facts and a safe local check) or `rejected` (with the reason). Candidates past the cap are counted as
   unverified and never reported as findings. With a complete trace the
   verifier may also propose a reproducer: a new test file, the argv that
   runs just that test with the project's test runner, a registered image
   and the failure text the test prints because of the flaw.
4. Reproduce. Each proposed reproducer runs offline, as described below,
   at no model cost; none runs for a verdict other than a complete trace.
5. Validate. Each record is built in Cloudflare's `report-schema.json`
   format with an engine-made fingerprint and checked by Cloudflare's own
   `validate-findings.cjs`, vendored unmodified and pinned by SHA-256 in
   `packages/engine/vendor/cloudflare-security-audit/`. A record that fails,
   or cites a file the change did not touch, is listed under `invalid` with
   the validator's errors instead of as a finding.

A record is `confirmed` only when its reproducer demonstrated it, since
Cloudflare's method reserves that verdict for a demonstrated finding. The
reproducer runs only in the offline verification sandbox that managed runs
use for their checks (`--network=none`, all capabilities dropped,
`--pull=never`, memory, CPU and process limits), as one check in one of the
project's registered verification images (`graph-engine check-add`; a null
image means the first mandatory check's), on a temporary copy of the run's
workspace snapshot with the one new file added. It is never written to the
run's workspace or the checkout, and the copy is removed afterwards. Its
time is bounded by `policy.verificationTimeoutSeconds`, or
`policy.timeoutSeconds` when that is null.

The engine first refuses a reproducer whose path is not a safe relative
project path matching the project's test file globs (`tester.writes`, or
the tester's defaults), in the changed area (a top-level directory the run
changed, or anywhere when it changed a top-level file) and new; whose
content is empty, over 64 KiB, holds a NUL byte or a potential secret;
whose argv is not 1 to 32 plain arguments (no shell metacharacters, quotes
or spaces) naming the file and not starting with a shell; whose expected
text is not 12 to 500 characters, is itself a load error, appears in its
content (line endings normalized) or is part of its path or any argv
element; or whose image is not registered. Test runners echo failing
source lines, code frames, the test path and argv, so a crash unrelated to
the finding could otherwise print the expected text; the reproducer must
produce that text at run time. A cloud auditor's reproducer must also have a path in
`policy.exportPaths`.

The finding is demonstrated exactly when the sandbox returned a result (a
timeout, output overflow, missing image, Docker error or changed input is
an error), the test exited with a code from 1 to 124 (0 is a pass, 125 to
127 mean it could not start and 128 or more mean a signal killed it), its
standard output and error together contain the expected text, and that
output shows none of the did-not-run markers (`SyntaxError`,
`Cannot find module`, `Cannot find package`, `ERR_MODULE_NOT_FOUND`,
`ModuleNotFoundError`, `ImportError`, `No test files found`,
`No tests found`, `no tests ran`, `command not found`,
`executable file not found`, ignoring case). The confirmed record's
`execution` says what ran (the argv, image, image ID, sandbox flags and
snapshot hash) and, in `observed_result`, the exit code, the expected text
and a redacted excerpt of the output's tail; its `remediation`, `severity`
and root cause come from the verifier, and a demonstration whose verifier
gave none of one of them stays `needs_validation`.

Anything short of a demonstration, including a refused reproducer or one
that could not run because Docker is unavailable, leaves a finding the
verifier traced completely as `needs_validation`, keeping the full trace,
with a blocker saying it was not demonstrated, a second blocker with the
reproducer's outcome when one was proposed, and a `validation_plan` holding
the verifier's reproduction and the result it expects. The result's
`counts.confirmed` counts demonstrated findings, `counts.traced` the
`needs_validation` records that are such static traces, and `reproducers`
lists every proposed reproducer's outcome. A confirmed finding is still
advisory: it never reaches the security gate, the run's status, its
completion or its review.

The auditor has the reviewer's restrictions: it must be an API (`openai`,
`anthropic` or `chat`) or local provider the policy allows; a cloud provider never receives a potential
secret, and an audit is refused (recording `security.audit_refused`) when
the run touched a path outside `policy.exportPaths` and the auditor is not
local; the hunter's and each verifier's request must fit the context
budget. Findings are redacted in the event and the printed result.

## What needs someone else

- **Dependency advisories.** OSV-Scanner (pinned in the scanner image)
  reads a local copy of the OSV vulnerability database.
  `graph-engine security-db-update` downloads it for the ecosystems of the
  repository's lockfiles into the private data directory; it needs
  `policy.network: "allowlisted"` with
  `osv-vulnerabilities.storage.googleapis.com` in `allowedHosts`, and it is
  the only scanner step with network access. Dependency resolution through
  deps.dev is disabled (`--no-resolve`) in the download and in every scan:
  OSV-Scanner would otherwise send the packages a manifest such as `pom.xml`
  or `requirements.txt` declares, including private ones, to
  `api.deps.dev`, a host the policy does not allow. A manifest is matched
  only on what it declares. Every later `security-scan` and run gate reads
  the database offline, and `security-scan` reports the database's age,
  flagging it stale after seven days. A lockfile whose ecosystem has no
  downloaded database makes the scan incomplete (so a run stops) with a
  message to run `security-db-update` again; it is never skipped silently.
  OSV-Scanner reads `pubspec.lock` as the Pub ecosystem, so a database
  downloaded before a project had one lacks Pub until `security-db-update`
  runs again.
  Trivy's database is not supported yet.
- **Dynamic testing** of a running application is lawful and safe only
  against a target the owner is entitled to test. Only the ZAP baseline
  scan runs, through `security-live-scan`, against
  [authorized live targets](#live-targets) the scan starts itself. Scanning
  external or production systems, active attack scans (ZAP full scan,
  Nuclei) and gating managed runs on a live scan are not supported.
- **Commercial tools** such as Burp Suite are used only when the user has
  installed and licensed them.
