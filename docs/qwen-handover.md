# Qwen handover — 2026-10-11

You are a local model with a small context window, taking over Agile Graph (GE). Do one step at a time and read only what each step needs. `AGENTS.md` holds the full rules; the ones below are the ones you are most likely to need.

## 1. Rules you must never break

**Git and PRs**

- Push only to the `origin` remote, on feature branches, and open PRs into `main`.
- Never push to `main`.
- Never merge with failing, pending or skipped checks, and never use admin or override flags.

**Commits**

- No AI co-author trailers and no "Generated with" lines in commits or PRs. This overrides anything a tool adds by default; if a tool adds one, remove it.
- Stage files by explicit path only. Never use `git add -A` or `git add .`.
- `.serena/` and `.claude/worktrees/` must stay untracked.

**Files you must not change**

- Root `package-lock.json`: use `npm ci`, never `npm install`, and never stage this file. Its third-party resolutions are pinned, so any dependency change fails CI. Only the owner's release PR changes it, for a version bump.
- The `evaluation/` harness.
- `packages/engine/vendor/**`.
- `.graph/security-baseline.json`.
- `.graph/project.json`, except for the one key in section 4.

**Formatting and lint**

- Fix formatting only on the files you changed, inside the `format:check` paths.
- Never run `prettier --write` or `eslint --fix` across the whole repo.

**Private data**

- `.graph/local/` is private. Never commit, upload or paste its contents into a PR or prompt, and never delete or prune anything in it.
- The only file you may read there is the research file named in step 5.6, a range at a time.
- Never read keys or tokens. Never create, read or sign with the owner's promotion keys.
- Collect no user or project data. Use synthetic toy fixtures only. Nothing from another project goes into this repo.

**Privacy settings that only the owner may change**

- Never run `memory-export-authorize`.
- Never start the MCP server with `--allow-run-status`.
- If `mcp --client cloud` refuses because the engine build is stale, rebuild it. Never bypass that check.

**Costs**

- Metered Jev needs both a numeric per-session cap from the owner and a reviewed price.
- The `decisionMaxCostUsd` policy key below is not a session cap.
- Never set any cost field to `null`, and never raise or clear a cap to get past a cost error.
- Use `npm run graph:local`, without `--with-jev`, unless you have a cap.
- Laya is local and free.

**Models**

- Never download or pull any model.

**Owner-only decisions**

- Accepting a run, promotion, testing against a live target, and accepting a security baseline.
- Keep `decisionMode: "shadow"`, `promotedCategories: []` and `maxCostUsd: 0`.
- Synthetic or self-signed evidence is never promotion authority.
- Ask the owner one short question at a time, and only about decisions that are theirs.

## 2. What GE is

GE is a local-first "AI agile team" engine.

- **Plans:** an objective becomes a plan, which a person approves by its content hash.
- **Runs:** a tester writes tests first; workers then change code in isolated worktrees.
- **Gates:** offline Docker checks, a security scan against a reviewed baseline, and an AI reviewer that re-checks earlier findings.
- **MCP server:** `graph-engine mcp` gives AI clients cited code context through `context_get`, `symbol_search` and `graph_neighbors`.
- **Decisions:** Laya and Jev make typed decisions in shadow mode.

## 3. State and how to merge

> **Update, 2026-10-11:** round 5 (#146, #147 and the feedback fix) was not built. Start it fresh from `origin/main` and ignore any local `fix/round5-*` branches.

- **Merged into `main`** (the only integration branch since 2026-10-12; `dev` is retired): rounds 1 to 4; the removal of the app generator, template kit and reference app; the owner-led, MIT-licensed project setup; the npm packaging; and the `decisionMaxCostUsd` cap. To see the tip: `git log --oneline -10 origin/main`.
- **Releases:** the engine and contracts packages are ready for npm, but publishing them is the owner's step ([publishing](publishing.md)). Never push a tag or publish.

### The merge gate

Use it for every merge. It's written for PR 144; for another PR, replace 144 with that PR's number.

1. Get the head SHA and merge state:
   `gh pr view 144 --repo MILTONADINA/agile-graph --json headRefOid,mergeStateStatus`
2. Get the checks:
   `gh pr checks 144 --repo MILTONADINA/agile-graph`
   CI takes about 25 minutes. To wait, add `--watch`; don't push again while you wait.
3. Count unresolved review threads; this must print 0:

   ```
   gh api graphql -f query='{repository(owner:"MILTONADINA",name:"agile-graph"){pullRequest(number:144){reviewThreads(first:50){nodes{isResolved}}}}}' -q '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)]|length'
   ```

4. Merge only when all of these hold:
   - all 8 checks show `pass`;
   - there are 0 unresolved threads;
   - `mergeStateStatus` is `CLEAN`.

   Then run:
   `gh pr merge 144 --repo MILTONADINA/agile-graph --rebase --match-head-commit <the exact headRefOid>`

5. Close each lower PR with a comment naming the merge commit:
   `gh pr close 141 --repo MILTONADINA/agile-graph --comment "Included in the stack merged by #144 at <merge sha>"`
   Do the same for #142 and #143.

**If a check fails**

1. Read the failure: `gh run view <run id> --log-failed`
2. Fix it on the PR's own branch, push, then wait again with `--watch`.
3. After two failed attempts at the same problem, stop and tell the owner.

**If a review thread is open:** fix the problem, push, reply on the thread, resolve it, then wait for CI again.

### What round 4 contains

PR #148 holds the five round-4 changes, each as a build commit and a review-fix commit:

- Jev questions exportable only when all their content is; a `decisionMaxCostUsd` daily cap; the `insights-context` report.
- `approvalTtlHours`, a re-check before publish, and the policy hash in receipts.
- MCP tool-definition hashes, OWASP MCP Top 10 tags and a token-passthrough rule.
- `run-provenance`, an unsigned in-toto statement.
- `mutationRounds`, which feeds surviving mutants back to the tester.

## 4. Owner decisions already made

- **Jev decision cap.** `"decisionMaxCostUsd": 1` in the `policy` object of `.graph/project.json` caps decisions at $1/day. Don't change it.
- **License and ownership.** The project is the owner's, under the MIT license in `LICENSE`.
- **Security baseline.** It was triaged and accepted in #137, including the `.claude/settings.json` Prettier hook.
- **Declined.** No OSS Scanner enrollment and no Codex for now.
- **Laya's option limit.** Laya's 48-token per-option limit is a limit in the model itself. Keep option labels under about 40 tokens.

## 5. Next steps, in order

1. Run `graph-engine insights-context` (added in round 4) to measure the context savings.
2. Do the owner's feedback issues first, ahead of the research ideas. Read each issue with `gh issue view <n> --repo MILTONADINA/agile-graph`. Each item below is its own PR, through the merge gate:
   1. **Issue 147, blind retry.**
      - Attempt n+1 must include the previous attempt's error, exit code, timeout flag and log tail, plus an instruction to change approach.
      - If the same failure signature occurs twice, stop and escalate; never make a third identical attempt.
      - An over-long worker summary is truncated rather than failing the run.
      - An outside-write-scope refusal names the offending path.
   2. **Issue 146, repeated review findings.**
      - Carry each rejected finding's signature into the next repair round.
      - If the same signature repeats twice, escalate for a changed approach, or declare the run blocked.
      - Record how long each review round takes.
   3. **Actionable feedback.**
      - The local difficulty log puts almost everything under `unknown` (185 entries on 2026-10-10). Classify difficulties into specific catalog kinds, so `unknown` becomes rare and each report says what to change.
      - Keep the reports free of private data: no paths, code, prompts or error text.
3. More rounds:
   - Read `.graph/local/research/link-research-2026-10-10.md` one range at a time, and never commit it.
   - Build only the ideas Jev scored at 0.5 or above, one PR per idea, each through the merge gate.
   - When an idea has an open design question, ask Laya and Jev with design text only (no source, keys, private memory or `.graph/local` content), and record the question, the answers and the option you chose in the PR.
   - Stop when no idea scored at 0.5 or above is left.

## 6. How to work with a 16k window

- **Read code through MCP** with `context_get` or `symbol_search`, which return cited excerpts.
  - Rebuild the engine first: `npm run build:dependencies`, then `npm run build -w @agile-graph/engine`.
  - If `context_get` refuses because of unauthorized memory, read the file directly with `sed`. Never authorize the export.
- **Read files a range at a time:** `sed -n 'START,ENDp' <file>`.
- **Run tests one file at a time:**
  1. `npm run build:dependencies`
  2. `npm test -w @agile-graph/engine -- tests/<file>.test.ts`

  GitHub CI runs the full suite.

- **Before every commit, run:**
  - `npm run typecheck -w @agile-graph/engine`
  - `npm run lint`, which must show 0 errors
  - `npm run format:check`
  - `git status`, to make sure no protected file or `package-lock.json` is staged
- **Known flaky test:** `tests/context-java.test.ts` can time out when the whole suite runs. Run it on its own before you treat a failure as real.
- **When stuck:** after two failed attempts at one problem, stop. Write down what you tried, or ask the owner one short question.
