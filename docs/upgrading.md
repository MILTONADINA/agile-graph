# Upgrading

How to move from `@agile-graph/engine` 0.2.0 to 0.4.0. 0.3.0 was never
published on npm, so going from 0.2.0 to 0.4.0 means reading both the 0.3.0
and the 0.4.0 sections below. The full
list of changes is the [CHANGELOG](../CHANGELOG.md); this page covers only
what needs an action from you.

## Before you upgrade

1. Back up the project's run history and context from the project directory:
   `graph-engine backup <destination>`. A backup excludes credentials,
   workspaces and model weights. It is restored only into a new data
   directory with `graph-engine restore <backup> <destination>`.
2. Check Node. The supported Node.js range is `^22.18.0 || >=24 <27`. It is
   the same range as 0.2.0, so the upgrade needs no Node change.

## 0.3.0

- **Every MCP tool hash changed.** The engine moved to zod 4, so the JSON
  input schemas the MCP server publishes differ. Take the pins again with
  `graph-engine mcp-tools --hashes`, giving the same `--client`,
  `--allow-tool`, `--allow-run` and `--allow-run-status` options as the
  server, or `graph-engine mcp-tools --hashes --all-configurations` for every
  configuration. Put the result in `mcp.toolHashes` in `.graph/project.json`
  or in a file passed as `--tool-hashes <file>`. Until you do, the server
  refuses to start with "its tool definitions do not match the hashes
  pinned". See [pinning tool definitions](mcp-clients.md#pinning-tool-definitions).
- **The MCP server is named `agile-graph`**, not `graph-engineering`. Rename
  the server in your client configuration, and `mcp__graph-engineering__*`
  tool permissions to `mcp__agile-graph__*`; see
  [platform](platform.md#renamed-from-graph-engineering).
- **Data folder.** The private data folder is `agile-graph` in the per-user
  data directory. An existing `graph-engineering` folder is still used when it
  is the only one, and nothing is moved. `GRAPH_ENGINE_DATA_DIR` wins over
  both.
- **Other renames.** The verify image tag (`agile-graph-verify:local`), the
  SARIF tool name and the default key backup file name
  (`agile-graph-keys.backup.json`) changed.
- **Laya sidecar.** The checkpoint changed. Provision it into a fresh
  directory (an existing one is refused), serve from it and update
  `decisions.json`.
- **Smaller changes.** Zod's own error wording differs, and a plan step's
  `dependsOn` accepts at most 100 entries.

## 0.4.0

This heading is renamed to the version number when a release is cut.

- **Three MCP tool descriptions changed**: `context_get`, `symbol_search` and
  `graph_neighbors`. Pins in `mcp.toolHashes` must be taken again with
  `graph-engine mcp-tools --hashes`, as above.
- **Verification configuration is gated.** A worker patch that edits a file
  the required checks load as configuration (a test runner config, test
  scripts in `package.json`, package-manager rc files, pytest settings) is
  refused and returned to the worker as feedback, unless a person listed the
  path in `policy.approvedVerificationConfigPaths` in `.graph/project.json`.
- **New dependencies need approval.** A patch that adds a dependency is
  refused with "New dependency needs approval". Add it to the manifest
  yourself before the run to approve it.
- **The security review needs enough output tokens.** It refuses up front,
  naming `policy.maxOutputTokens`, when the scan results need more than the
  policy allows (the default is 16000). Raise `policy.maxOutputTokens` or trim
  the security baseline.

## Unreleased

- **One MCP tool description changed**: `memory_propose` now takes an optional
  `validFrom`. Pins in `mcp.toolHashes` must be taken again with
  `graph-engine mcp-tools --hashes`, as above.

## Run store

The run store schema is version 5 in 0.2.0 and in the current `main`, so
there is no schema bump. Within version 5, newer builds add `project_id`
indexes on `plans`, `runs`, `decisions`, `plan_approvals`, `worker_leases`
and `owner_proofs`. They are created on the first open, and nothing is
rewritten. 0.2.0 still opens the same database afterwards: the engine refuses
a database only when its version is newer than its own.

## Rolling back

1. Stop every running `graph-engine` process and MCP server.
2. Install the old version:
   `npm install --global @agile-graph/engine@0.2.0`.
3. Restore your old `mcp.toolHashes` and client configuration from git. The
   0.2.0 server is named `graph-engineering` and has its own hashes.
4. The run database needs no change. If you want the pre-upgrade state,
   restore the backup into the project folder of a new data root with
   `graph-engine restore <backup> <new-root>/projects/<projectId>`, then set
   `GRAPH_ENGINE_DATA_DIR` to `<new-root>`. The engine looks for a project's
   data in `projects/<projectId>` under that variable, so pointing it at the
   restore destination itself opens an empty database.
5. 0.2.0 looks for the `graph-engineering` data folder. If 0.3.0 or later
   created the `agile-graph` folder on a machine with no old folder, set
   `GRAPH_ENGINE_DATA_DIR` to that folder when you roll back, or 0.2.0 sees no
   runs.
