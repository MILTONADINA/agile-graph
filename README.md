# Agile Graph

An AI agile team for your repository. You are the product owner: you write
feature specs with acceptance criteria, approve plans and accept results. AI
workers take the team's roles (developer, tester and reviewer), and every
change must pass the checks, code review and security scan you configure
before it is offered to you as done.

The team works locally, in small, checked increments. Project context and
reviewed memory stay on your machine, connected AI clients retrieve
source-backed context through MCP, and each step runs in an isolated Git
worktree, limited to the files it declares.

```text
feature spec + acceptance criteria        (you)
                ↓
   plan: ordered steps with write scopes → your approval
                ↓
   tester writes tests first → developers implement in isolated worktrees
                ↓
   offline checks → code review → security scan    (failures go back to the developer)
                ↓
   you accept or reject → optional commit / draft PR
```

See [working as an AI agile team](docs/agile-team.md) for each role,
practice and command, and the [documentation index](docs/README.md) for
every guide.

## Install

```sh
npm install --global @agile-graph/engine
graph-engine -C /path/to/your/project init
graph-engine -C /path/to/your/project index --lexical
graph-engine -C /path/to/your/project serve
```

You need Node.js 22.14 or later (22 to 26) and Git. Docker is needed for managed
verification and security scans, not for indexing or retrieval. `serve`
prints a loopback URL for the dashboard. A new project uses local-only
inference, no external network, no publication and shadow-mode decisions; no
model, credential or provider is set up for you. The
[engine package README](packages/engine/README.md) covers the optional
integrations, the security scanner image and where data is stored.

## Develop from source

```sh
npm ci
npm run build
npm run setup:git -- --push-remote origin
npm run graph -- -C /path/to/your/project init
```

See the [platform guide](docs/platform.md) for configuration and commands,
[context lifecycle](docs/context-lifecycle.md) for summaries, cache, watch,
backup and restore, the [decision guide](docs/decisions.md) for batched
controllers and nullable cost accounting,
[dependency scheduling](docs/dag-runtime.md) for multi-step plans, and
[installed-worker limits](docs/installed-workers.md) for native client
capabilities.

Useful local maintenance commands:

```sh
graph-engine -C /path/to/your/project summaries
graph-engine -C /path/to/your/project memory-review
graph-engine -C /path/to/your/project snapshots-prune --keep 20
```

Pruning previews unless `--apply` is supplied. `backup NEW_ARCHIVE_DIRECTORY`
includes both private databases and reviewed configuration;
`restore ARCHIVE NEW_DATA_DIRECTORY` never overwrites live data. Model weights
and worker workspaces are excluded, so restore requires manual
reconciliation. See the lifecycle guide before changing storage.

## Repository

| Area                 | Purpose                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `specs`              | Feature specs: acceptance criteria linked to the tests that prove them                   |
| `packages/contracts` | Versioned project, context, execution and decision contracts (published to npm)          |
| `packages/engine`    | Context, bounded controllers/DAG, CLI, MCP, loopback API, verified cache, managed runs   |
| `packages/dashboard` | React context, graph, memory, run and decision interfaces, bundled into the engine       |
| `sidecars`           | The offline security scanner image and the explicitly provisioned Laya decision sidecar  |
| `evaluation`         | Synthetic smoke fixtures, measured baseline/candidate runner, recorded-evidence workflow |

## Checks and collaboration

```sh
npm run check
GRAPH_ENGINE_DOCKER_TESTS=1 npm test -w @agile-graph/engine
```

Use focused feature branches and reviewed PRs into `main`, the only integration
branch. Never push to it directly; commits use the human Git identity without AI
co-author trailers. See [contributing](CONTRIBUTING.md). Releases to npm are
the owner's step, described in [publishing](docs/publishing.md).

## Current boundaries

The graph combines syntax evidence with bounded compiler-backed JS/TS,
isolated CPython, snapshot-only Go/Java/C#, and pinned Rust LSP declaration
bindings, not a complete runtime call graph. Native runtime availability and
supported subsets vary; Rust currently requires the isolated Linux fixture.
Other lexical call candidates remain labeled heuristic; unsupported
resolution and unavailable embeddings are reported. Reviewed typed memory
claims enable exact scoped contradiction checks without choosing which claim
is true. Local storage does not make a cloud-backed coding client offline:
cloud export requires explicit policy and source-path permission, and
mandatory memory blocks export unless it is shared, sourced and authorized by
an operator for its exact text. Exact cached-proposal replay reruns required
checks. Laya/Jev scores do not prove code correct; required verification and
human acceptance remain independent. Unknown token usage and cost stay
unknown rather than becoming zero.

The DAG requires reviewed explicit steps. Snapshot storage currently
duplicates source payloads; retention and private backups are operational
requirements, not optional proof of production readiness.

The [evaluation corpus](evaluation/README.md) contains reproducible synthetic
smoke checks and [pinned retrospective intake tasks](docs/calibration-corpus.md),
not evidence that routing is ready for autonomous architecture or security
decisions. Promotion remains disabled until recorded, independently labeled
calibration and held-out outcomes meet category-specific gates. The
[10,000-file indexing receipt](docs/context-benchmark-10000.json) measures one
synthetic local workload; it does not establish coding accuracy, production
throughput, or token savings.

## License

[MIT](LICENSE) © 2026 Milton Adina. Third-party material is listed in
[`NOTICE`](NOTICE).
