# @agile-graph/engine

An AI agile team for your repository. You are the product owner: you write
feature specs with acceptance criteria, approve plans and accept results. AI
workers take the team's roles (developer, tester and reviewer), and every
change must pass the checks, code review and security scan you configure
before it is offered to you as done.

The team works locally, in small, checked increments. Project context and
reviewed memory stay on your machine, connected AI clients retrieve
source-backed context through MCP, and each step runs in an isolated Git
worktree, limited to the files it declares.

## Install

```sh
npm install --global @agile-graph/engine
graph-engine --version
```

You need Node.js 22 (22.18 or later) or 24 to 26 and Git. Docker is needed for managed
verification and security scans, not for indexing or retrieval.

## Start

```sh
# Cloud AI client (Claude Code, Codex, Cursor):
graph-engine -C /path/to/your/project init --cloud-mcp --export 'src/**'
# Local model only:
graph-engine -C /path/to/your/project init
graph-engine -C /path/to/your/project index --lexical
graph-engine -C /path/to/your/project serve
```

`init --cloud-mcp` needs at least one `--export <glob>` and only sets up a new
project: it refuses one that already has `.graph/project.json`. It sets
inference and network to allowlisted, with providers and allowedHosts empty.

`serve` prints a loopback URL for the dashboard. Without `--cloud-mcp`, a new
project uses local-only inference, no external network, no publication and
shadow-mode decisions. No model, credential or provider is set up for you:
add the ones you choose with `graph-engine provider-add`, then plan work with
`graph-engine plan`, approve it with `graph-engine plan-approve` and accept
results with `graph-engine accept`. `graph-engine --help` lists every command.

To give an AI client such as Claude Code, Codex or Cursor the project's
context, run `graph-engine -C /path/to/your/project mcp` as its MCP server.
See [connecting an AI client](https://github.com/MILTONADINA/agile-graph/blob/main/docs/mcp-clients.md).

## Try it

Once a project is indexed, query it from the terminal. Each command prints
JSON:

```sh
graph-engine -C /path/to/your/project index --lexical
graph-engine -C /path/to/your/project context "calculateInvoiceTotal"
graph-engine -C /path/to/your/project symbols calculateInvoice
graph-engine -C /path/to/your/project summaries
```

`context` takes `--budget <tokens>` to cap its size. In lexical mode it
matches names, so a symbol name works better than a plain phrase: "invoice
total" returned no items in a test project.

## Optional integrations

These are optional peer dependencies. Install one next to the engine only if
you want it:

- **Local embeddings:** `npm install --global @huggingface/transformers`.
  On Linux x64 its install also downloads GPU runtime binaries; set
  `ONNXRUNTIME_NODE_INSTALL=skip` to skip them and run on the CPU.
- **Cursor workers:** `npm install --global @cursor/sdk`. Cursor's SDK has its
  own proprietary license, and it brings an older HTTP client with known
  advisories, so install it only if you use Cursor as a worker.

The security gate runs its scanners in a local Docker image. Build it once
from the Dockerfile this package ships:

```sh
docker build -t graph-security:local "$(npm root --global)/@agile-graph/engine/scanner"
```

## Data and privacy

Each project's databases, runs and workspaces are stored in your per-user
data directory (`~/Library/Application Support/agile-graph` on macOS,
`~/.local/share/agile-graph` on Linux, `%LOCALAPPDATA%\agile-graph\Data`
on Windows), never in the package (an older `graph-engineering` folder is still used when it is the only one). Nothing leaves your machine unless a
project policy you write allows it.

Automatic difficulty reports are on by default but only send when a
project's policy allows network access to `api.github.com`. They carry fixed
error kinds and platform metadata, never source, paths, prompts or logs, and
are filed as public GitHub issues under your own GitHub CLI login. Turn them
off with `graph-engine feedback-config off` or `GRAPH_ENGINE_NO_FEEDBACK=1`.

## Uninstall

Remove the package and any optional integrations you installed. Keep only
the lines that match what you installed or built:

```sh
npm uninstall --global @agile-graph/engine
npm uninstall --global @huggingface/transformers @cursor/sdk
docker image rm graph-security:local
```

If a project installed the engine as a dependency, run
`npm uninstall @agile-graph/engine` in that project too.

Your data stays in the per-user data directory after the package is removed.
Delete it as well:

- macOS: `~/Library/Application Support/agile-graph`
- Linux: `~/.local/share/agile-graph`, or `$XDG_DATA_HOME/agile-graph` when set
- Windows: `%LOCALAPPDATA%\agile-graph\Data`

This folder holds every project's databases and runs. On macOS and Linux it
also holds promotion files if you set up promotion (`promotion-keys/` and
`promotion-enrollment/`). On Windows those are in `~\.local\share\agile-graph`
instead, so delete that folder too. Back up anything you need first. Deleting it cannot be undone. An older
`graph-engineering` folder beside it can be removed the same way.

Each project also has a `.graph/` folder with its `project.json` and any files
you added there, such as shared memories in `.graph/knowledge/`. Delete it in
each project:

```sh
rm -rf /path/to/your/project/.graph
```

Check first with `git ls-files .graph` what you committed. Removing `.graph/`
does not remove that project's databases, which live in the data directory
above.

## Documentation

The [repository](https://github.com/MILTONADINA/agile-graph) has the
[platform guide](https://github.com/MILTONADINA/agile-graph/blob/main/docs/platform.md),
[working as an AI agile team](https://github.com/MILTONADINA/agile-graph/blob/main/docs/agile-team.md)
and the [documentation index](https://github.com/MILTONADINA/agile-graph/blob/main/docs/README.md).

## Security

Report vulnerabilities privately. See the
[security policy](https://github.com/MILTONADINA/agile-graph/blob/main/SECURITY.md).

## License

MIT © 2026 Milton Adina. Third-party material and its licenses are listed in
`NOTICE`.
