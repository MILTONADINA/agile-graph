# Connecting an AI client

Any AI client that speaks the Model Context Protocol over stdio can use the
project's graph: Claude Code, Codex, Cursor and others. The client starts
the engine's MCP server and calls its tools. This is separate from Graph
Engineering launching an AI as a managed worker; see
[which AI can do what](installed-workers.md#which-ai-can-do-what) for that.

In the examples, `<path-to-repo>` is your Graph Engineering checkout and
`<path-to-project>` is the project the server reads (the same directory when
you use the graph on this repository). Use absolute paths.

## Before connecting

Build the engine once, and again after pulling engine changes:

```sh
npm ci
npm run build:dependencies
npm run build -w @graph-engineering/engine
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

Both kinds get `context_get`, `symbol_search`, `graph_neighbors`,
`template_list` and `memory_propose`; a memory proposal stays private until it
is accepted outside the server. Two server options add more, and both are the
operator's choice, never an agent's:

- `--allow-run-status` gives a cloud client `run_status`, `run_list` and
  `run_events` (a local client always has them). They still refuse a cloud
  client while the project policy is offline (`inference: "local"` or
  `network: "deny"`).
- `--allow-run` adds `plan_decompose`, `plan_create`, `run_start` and
  `run_cancel`. Plans that publish, or any plan under `requirePlanApproval`,
  still need a person's approval on the command line before they start.

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
