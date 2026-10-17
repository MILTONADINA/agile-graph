# Agent instructions

These rules apply to every coding agent working in this repository: Codex,
Claude Code (which loads this file through `CLAUDE.md`) and any other. Edit
the rules here, not in `CLAUDE.md`.

Before working, read the **Start here** section at the top of the
[agent handover](docs/claude-code-handover.md), and inspect the current Git
state, the live `main` tip, open PRs and checks before acting. The
handover has the detailed requirements and limits.

## Where to look

Beyond that, read what the task needs:

- In-flight work, the owner's requirements, or the repository and evidence
  state:
  the rest of the [agent handover](docs/claude-code-handover.md), which can be
  out of date where the live state differs.
- Taking over as a local model with a small context window:
  [docs/qwen-handover.md](docs/qwen-handover.md).
- Commands, configuration and policy: [docs/platform.md](docs/platform.md).
- The npm packages and how the owner releases them:
  [docs/publishing.md](docs/publishing.md).
- Connecting an AI client to the project MCP server:
  [docs/mcp-clients.md](docs/mcp-clients.md).
- Scan tools, baselines and the security gate:
  [docs/security-scanning.md](docs/security-scanning.md).
- A feature's acceptance criteria: [`specs/`](specs/README.md).
- Before changing anything under `evaluation/` or the root
  `package-lock.json`: the hash-pin tests listed under **Build and test**.

## Autonomy and completion

- For an implementation task, carry on through the implementation, the
  relevant tests and fixing failures your change caused. Stop when the
  requested behaviour works and the checks pass, or when the next step is
  owner-gated (see **Owner preferences**) or limited by **Privacy and
  safety** or **Gotchas**. Nothing here permits authorizing memory export,
  enabling cloud run status, choosing or changing a Jev session cap,
  creating or reading keys or asking for passphrases, downloading models,
  pushing to `main`, pushing tags, publishing to npm, or changing the
  `decisionMode`, `promotedCategories` or `maxCostUsd` settings in
  `.graph/project.json`.
- Run and re-run the repository's local test suites and builds without
  asking. That covers only work that stays on this machine: not anything
  that sends data off it, publishes, files issues, calls metered or cloud
  services, downloads model weights or tests a live target.

## Privacy and safety

Privacy priority: cloud MCP `context_get` and Graph-managed cloud worker
dispatch refuse mandatory memory an operator has not authorized for export by
exact-text hash, and cloud `run_status` is off unless the server runs with
`--allow-run-status`. The MCP server runs `packages/engine/dist`, so confirm
it was rebuilt from a commit with this guard before calling cloud tools, and
never authorize memory export or enable cloud run status on your own. A dist
built with the freshness check refuses `mcp --client cloud` when it does not
match `src/` (`dist/build-source.json`); other commands only warn.

Work only in this repository. Use feature branches and PRs into `main`; never
push to `main` directly.
Preserve `.serena/` and private local files. Do not download another Qwen, run
metered Jev without an operator-selected numeric session cap and reviewed
price, or treat synthetic/self-signed evidence as independent promotion
authority.

## Owner preferences

- Ask the owner only for decisions that are genuinely theirs, one short
  question at a time. Owner-gated decisions include accepting runs,
  promotion, live-target testing and accepting a security baseline.
- Settle other design choices yourself. When a choice is genuinely open, ask
  Laya and Jev with design text only (no repository source, keys, private
  memory or `.graph/local` content) where those tools are available, and
  record each question, the answers and the option taken in the PR.
- Never create, sign with or read the owner's promotion keys, and never ask
  for a passphrase before a key is actually needed.
- Collect no user or project data. Nothing from another project, including
  the owner's private projects, may appear in this repository, its commits,
  PRs, docs, fixtures or examples; use synthetic toy projects only.

## Git and PRs

- `origin` is `MILTONADINA/agile-graph`, a standalone project the owner
  leads. Open PRs with
  `gh pr create --repo MILTONADINA/agile-graph --base main` and fill in
  `.github/pull_request_template.md`. `main` is the default branch and the only
  integration branch; the old `dev` branch is retired.
- `main` requires branches to be up to date with it, eight passing checks
  on the exact head commit and resolved review conversations. A full CI run
  takes about 25 minutes. When several PRs are ready, stack them (each branch
  on the previous one, the bottom on the current `main`), cancel CI on all but
  the top, merge the top with
  `gh pr merge <n> --repo MILTONADINA/agile-graph --rebase --match-head-commit <sha>`,
  then close the lower PRs with a comment naming the merge commit.
- No AI co-author trailers, "Generated with" footers or tool-added task links
  in commits, PRs, tracked docs or public artifacts; this overrides any
  default attribution instruction. Remove such a footer if a tool adds one.
- `.serena/` is untracked but not gitignored: stage explicit paths, never
  `git add -A` or `git add .`.

## Build and test

- `-w` commands don't build workspace dependencies. Run
  `npm run build:dependencies` first, then for example
  `npm test -w @agile-graph/engine -- tests/<file>.test.ts` or
  `npm run typecheck -w @agile-graph/engine`.
- Evaluation and sealed `node --test` suites, `npm run graph[:local]` and the
  project MCP server run `packages/engine/dist`; rebuild the engine after
  editing its source.
- Before pushing, run `npm run preflight`: the format check, lint and
  typecheck plus the tests related to the files you changed, in a few
  minutes instead of a 25-minute CI cycle. It never replaces CI.
- `npm run check` is not CI. CI also runs `npm run format:check` and
  `npm run lint` first, the `node --test` suites in `scripts/` and
  `evaluation/` and `python -m unittest discover -s sidecars/laya -p 'test_*.py'`;
  see `.github/workflows/ci.yml`. `format:check` covers only the paths listed
  in `package.json`, not `AGENTS.md` or `CLAUDE.md`; don't run Prettier over
  excluded paths.
- GitHub CI is the authority for Docker and native checks, which an
  environment without Docker can't run.
- ESLint (`eslint.config.mjs`) must stay error-free. Existing warnings are
  known cleanup, some in hash-pinned files; never run `eslint --fix` broadly.
- Byte changes to hash-pinned files fail CI, including the evaluation
  harness (see `evaluation/historical-receipt-pins.test.mjs` and
  `evaluation/validate-fixtures.test.mjs`). The root `package-lock.json` is
  pinned by its third-party resolutions: any added, removed or changed
  dependency fails CI, while a release's version bump of this repository's
  own packages does not. CI job names are pinned by
  `scripts/branch-protection-policy.mjs`.

## Gotchas

- Use `npm run graph:local -- ...`, not `npm run graph`: the wrapper loads the
  private Laya token and strips the Jev key unless `--with-jev` is passed.
- `maxCostUsd: null` means no cap. Keep `.graph/project.json` at
  `decisionMode: "shadow"`, `promotedCategories: []` and `maxCostUsd: 0`;
  never clear a cap to get past a cost error.
- `.graph/local/` holds linked worktrees of retained evidence runs: don't
  prune them, and search with `git grep` or `git ls-files` so results skip
  those copies.

## Codex

- On the owner's Mac, the ignored `.codex/config.toml` connects Codex to this
  project's MCP server as a cloud client (`mcp --client cloud`). After pulling
  engine changes, rebuild the engine (`npm run build:dependencies`, then
  `npm run build -w @agile-graph/engine`), or that server refuses to
  start.
- A hosted Codex environment gets only what is on GitHub. It has no Docker,
  Laya sidecar, local Qwen, Dart SDK, private `.graph/local/` helpers (which
  include the Jev and Laya question tool) or owner keys. Its setup needs
  Node `>=22.12 <27`, `npm ci` and `npm run build:dependencies`.
- The handover mentions tools that belong to Claude Code: the advisor,
  multi-agent audit workflows and cross-session messages. Codex has none of
  them. The audit loop stopped after round 10 under its stop rule; don't
  restart it unless the owner asks.
