# Connecting an AI client

Any AI client that speaks the Model Context Protocol over stdio can use the
project's graph: Claude Code, Codex, Cursor and others. The client starts
the engine's MCP server and calls its tools. This is separate from Graph
Engineering launching an AI as a managed worker; see
[which AI can do what](installed-workers.md#which-ai-can-do-what) for that.

In the examples, `<path-to-repo>` is your Agile Graph checkout and
`<path-to-project>` is the project the server reads (the same directory when
you use the graph on this repository). Use absolute paths.

## Before connecting

Build the engine once, and again after pulling engine changes:

```sh
npm ci
npm run build:dependencies
npm run build -w @agile-graph/engine
```

The server runs `packages/engine/dist`. A dist built with the freshness check
compares itself with `src/` (`dist/build-source.json`): `mcp --client cloud`
refuses to start when they differ, since a stale build may lack newer export
guards, and other commands only warn. Rebuild when a client reports that the
server failed to start.

## Cloud or local

`--client` says where the client's inference runs:

| Option           | Use it for                                                                                   | What the client gets                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--client cloud` | Claude Code, Codex, Cursor and any client whose model runs on a provider's servers           | Only files the project's `exportPaths` allow. `context_get` refuses a packet whose mandatory memory is not authorized for export. Run status tools only with `--allow-run-status`. |
| `--client local` | A client whose inference actually stays on this machine, such as one backed by a local model | Every indexed file, hybrid retrieval with memory excerpts, and run tools with details a cloud client is not given.                                                                 |

When in doubt, use `cloud`. A project whose policy is offline refuses cloud
clients.

### Letting cloud clients in

`graph-engine init` creates an offline project (`policy.inference: "local"`,
`policy.network: "deny"`, `policy.exportPaths: []`), and the server refuses
every `--client cloud` call there. That default does not change. To let Claude
Code, Codex, Cursor or another cloud-backed client retrieve context, choose it
when you create the project and name the files they may receive:

```sh
graph-engine -C <path-to-project> init --cloud-mcp --export 'src/**' --export '!src/secrets/**'
```

`--cloud-mcp` needs at least one `--export` glob; repeat `--export` for more,
and prefix `!` to exclude. It sets exactly three fields of the new
`.graph/project.json`:

- `policy.inference` and `policy.network` become `"allowlisted"`, which is
  what stops the server refusing cloud clients;
- `policy.exportPaths` becomes the globs you gave.

Everything else stays at the default. `policy.providers` and
`policy.allowedHosts` stay empty, so no cloud or installed worker and no
network host is permitted until you add one (`provider-enable`, and a host in
`allowedHosts` for an API worker), and `policy.excludedPaths` still keeps
`.env`, keys and credentials out of the index entirely.

What this means for privacy: the text of every indexed file `exportPaths`
matches, with its symbols and graph edges, can be sent to the client and so
to its model provider's servers. Files outside `exportPaths` are never given
to a cloud client, and mandatory memory still reaches one only after you
authorize its exact text (`memory-export-authorize`). Export only what you are
willing to share with that provider. `init --cloud-mcp` never changes an
existing project: it refuses when `.graph/project.json` exists, so to open or
close an existing project edit those three fields there yourself (setting
`inference` back to `"local"` or `network` to `"deny"` refuses cloud clients
again). Changing the policy voids existing plans.

Both kinds get `context_get`, `symbol_search`, `graph_neighbors` and
`memory_propose`; a memory proposal stays private until it
is accepted outside the server. The other tools are off until the operator
turns them on, never an agent:

- `--allow-tool <name>` enables one tool and can be repeated. It takes
  `run_start`, `run_cancel`, `plan_create`, `plan_decompose`, `run_status`,
  `run_list` and `run_events`, and refuses any other name, so a mistyped tool
  stops the server instead of being ignored.
- `--allow-run` is an alias for `--allow-tool` with `run_start`, `run_cancel`,
  `plan_create` and `plan_decompose`.
- `--allow-run-status` is an alias for `--allow-tool` with `run_status`,
  `run_list` and `run_events`. A local client always has these three. They
  still refuse a cloud client while the project policy is offline
  (`inference: "local"` or `network: "deny"`).

Existing configurations that use the two aliases keep working unchanged.

### Behaviour change: every MCP-started run needs `plan-approve`

**A run started with `run_start` now always needs a person's stored approval
of the plan's exact content**, whether or not the plan publishes and whatever
the project policy says. Before this change, a plan that did not publish
started over MCP without any approval unless the project set
`requirePlanApproval`. Now the client's `run_start` is refused until a person
runs:

```sh
graph-engine plan-approve <planId>                              # review the plan
graph-engine plan-approve <planId> --yes --expect <planSha256>  # approve exactly that content
```

The refusal names this command with the plan's current `planSha256`. A plan
changed after it was approved is refused again until a person approves it as
it now stands. The command line is unchanged: `graph-engine run <planId>`
still counts as the person's approval of a plan that publishes, and still
needs none for a plan that does not, unless the project requires plan
approval. The approval a run started under is recorded as its
`plan.approval_used` event.

### The call log

The server records every tool call it handles in the project's run database:
when, which tool, whether the client is local or cloud, the SHA-256 of the
call's arguments as canonical JSON (sorted keys), its outcome (`ok`,
`refused` by a rule such as a missing approval, or `error`) and the plan or
run it concerned. It never stores the arguments themselves or error text, and
it keeps a plan or run ID only when it names one of the project's own. A call
whose arguments fail the tool's input schema is turned down by the MCP
library before the tool runs, so it does no work and is not logged.

Read the log with `graph-engine mcp-log [--limit <n>] [--tool <name>]`, newest
first (50 entries by default). It reads the database without opening the
engine. No MCP tool reads the log.

The entry is written before the tool runs. When it cannot be written, a tool
that changes state or pays for a model call (`run_start`, `run_cancel`,
`plan_create`, `plan_decompose` and `memory_propose`) refuses the call, so no
such action goes unrecorded; a read-only tool still answers, since a missed
read changes nothing an audit would need to explain. Either way the client is
told only that the log could not be written, and the reason goes to the
server's standard error. An entry whose outcome is `null` is a call still in
progress, or one whose server stopped before it finished.

## Pinning tool definitions

Each entry also records `definitionSha256`, the SHA-256 of the called tool's
name, description and input schema as the server published them. List them
with `graph-engine mcp-tools --hashes`, passing the same `--client` and
`--allow-tool` options as `mcp`. To pin them, copy that object into the
project's `mcp.toolHashes` or into a file passed as
`graph-engine mcp --tool-hashes <file>`. When pins are given, `mcp` refuses to
start if a tool it would expose is unpinned or its definition changed; every
given set must hold, and pins for optional tools left off are ignored. The
default listing is the cloud one, and a local client also exposes `run_status`,
`run_list` and `run_events`, so cloud pins make `mcp --client local` refuse to
start. When the project's pins must serve more than one configuration, pin
`graph-engine mcp-tools --hashes --all-configurations` instead: every tool
either client kind could expose with any optional tool enabled. Review
the change behind a refusal before updating the pins. See
[MCP security coverage](mcp-security-coverage.md) for how this and the other
guards map to the OWASP MCP Top 10.

### What a result leaves out

`symbol_search` returns `{ symbols, limitations }`, `graph_neighbors` returns
`{ edges, limitations }`, and a `context_get` packet has a `limitations`
field. They give counts and flags only: `filtered` (results withheld by
credential screening), `truncated` (the result reached its limit of 100
symbols or 200 edges, or the token budget left candidates out),
`coverageIncomplete` (indexing could not cover some files), `unresolvedEdges`
for `graph_neighbors` (edges whose `to` is null) and `notes`. A cloud client's
notes are fixed sentences with no paths or diagnostics, and results outside
the export policy are left out before counting, so a count cannot reveal
private names; a local client's notes also include the indexing diagnostics.

The [platform guide](platform.md#mcp-clients) has the full export and run
rules.

## Claude Code

Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "graph-engineering": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<path-to-repo>/packages/engine/dist/cli.js",
        "-C",
        "<path-to-project>",
        "mcp",
        "--client",
        "cloud"
      ]
    }
  }
}
```

Claude Code asks you to approve a project MCP server the first time it sees
one.

## Codex

Add a server table to `.codex/config.toml` in the project (or to your user
Codex configuration):

```toml
[mcp_servers.graph-engineering]
command = "node"
args = [
  "<path-to-repo>/packages/engine/dist/cli.js",
  "-C", "<path-to-project>",
  "mcp", "--client", "cloud",
]
```

Codex reads a project's `.codex/config.toml` only after you trust the
project; your user configuration is always read. A hosted Codex environment has only what is on GitHub, so it must run
`npm ci` and the build steps above before the server can start.

## Cursor

Copy the tracked example and adjust it if the project is not the open
workspace:

```sh
cp .cursor/mcp.example.json .cursor/mcp.json
```

[`.cursor/mcp.example.json`](../.cursor/mcp.example.json) uses Cursor's
`${workspaceFolder}` variable, so it works unchanged when this repository is
the open workspace. Cursor's MCP-client path needs no Cursor API key; that is
only for the separate managed SDK worker.

## Any other stdio client

Configure a stdio server with:

- command: `node`
- arguments: `<path-to-repo>/packages/engine/dist/cli.js -C <path-to-project> mcp --client cloud`

When the engine package is installed or linked, its `graph-engine` command is
the same program: `graph-engine -C <path-to-project> mcp --client cloud`.
Program options such as `-C` go before `mcp`. The server writes the MCP stream
to standard output and its own messages to standard error.

## Keep configuration local

`.mcp.json`, `.codex/config.toml` and `.cursor/mcp.json` are git-ignored, since
they hold machine-specific paths. Don't commit them or put credentials in
them; only `.cursor/mcp.example.json` is tracked.

An MCP client keeps its own permissions and model calls: the server limits
what it returns, not what the client does with its other tools.
