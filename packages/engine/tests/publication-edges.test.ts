import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_POLICY,
  type ProjectConfig,
  type RunRecord,
} from "@agile-graph/contracts";
import { createWorkspace } from "../src/execution/workspace.js";
import { publishRun } from "../src/execution/publish.js";
import * as util from "../src/util.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  util.checked("git", args, { cwd });

async function fixture(objective = "Fix addition") {
  const base = await mkdtemp(path.join(os.tmpdir(), "graph-publication-edge-"));
  roots.push(base);
  const root = path.join(base, "source");
  await mkdir(root);
  await git(root, "init", "-b", "dev");
  await git(root, "config", "user.name", "Graph Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a,b) => a - b;\n",
  );
  await writeFile(path.join(root, "other.cjs"), "exports.other = 1;\n");
  await git(root, "add", ".");
  await git(root, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
  const config: ProjectConfig = {
    version: "1.0.0",
    projectId: "test-project",
    name: "test",
    policy: { ...structuredClone(DEFAULT_POLICY), publication: "commit" },
    verification: [],
  };
  const timestamp = new Date().toISOString();
  const run: RunRecord = {
    id: "edge-run",
    status: "verifying",
    createdAt: timestamp,
    updatedAt: timestamp,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
    plan: {
      version: "1.0.0",
      id: "edge-plan",
      projectId: config.projectId,
      snapshotId: "snapshot",
      policyHash: "policy",
      createdAt: timestamp,
      objective,
      acceptance: ["addition works", "subtraction still works"],
      steps: [],
      verification: [],
      publication: "commit",
    },
  };
  Object.assign(run, await createWorkspace(root, base, run.id, config.policy));
  return { base, root, config, run };
}
const edit = (run: RunRecord, file = "math.cjs", text = "changed\n") =>
  writeFile(path.join(run.workspace!, file), text);
const count = (run: RunRecord) =>
  git(run.workspace!, "rev-list", "--count", "HEAD");

function draftPr(
  config: ProjectConfig,
  over: Partial<NonNullable<ProjectConfig["github"]>> = {},
) {
  fakeGithub();
  config.policy.publication = "draft-pr";
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = ["github.com"];
  config.github = {
    repository: "test-owner/test-repo",
    baseBranch: "dev",
    remote: "origin",
    ...over,
  };
}
const addRemote = (
  root: string,
  url = "https://github.com/test-owner/test-repo.git",
) => git(root, "remote", "add", "origin", url);

/** Replaces git push and the gh calls; every other command runs for real. */
function fakeGithub(
  options: { existing?: string; listCode?: number; onPush?: () => void } = {},
) {
  vi.restoreAllMocks();
  const real = util.command;
  const realChecked = util.checked;
  const calls = {
    push: [] as string[][],
    list: [] as string[][],
    create: [] as string[][],
  };
  vi.spyOn(util, "command").mockImplementation(async (exe, argv, opts) => {
    if (exe === "git" && argv.includes("push")) {
      calls.push.push(argv);
      options.onPush?.();
      return { code: 0, stdout: "", stderr: "" };
    }
    if (exe === "gh") {
      calls.list.push(argv);
      return {
        code: options.listCode ?? 0,
        stdout: options.existing ?? "",
        stderr: "",
      };
    }
    return real(exe, argv, opts);
  });
  vi.spyOn(util, "checked").mockImplementation(async (exe, argv, opts) => {
    if (exe === "gh") {
      calls.create.push(argv);
      return "https://github.com/test-owner/test-repo/pull/7";
    }
    return realChecked(exe, argv, opts);
  });
  return calls;
}

describe("publishRun preconditions", () => {
  it("refuses a run that has no workspace or branch", async () => {
    const { root, config, run } = await fixture();
    await expect(
      publishRun(root, { ...run, workspace: undefined }, config),
    ).rejects.toThrow("Run has no execution workspace");
    await expect(
      publishRun(root, { ...run, branch: undefined }, config),
    ).rejects.toThrow("Run has no execution workspace");
  });

  it("publishes nothing and leaves the workspace alone when publication is none", async () => {
    const { root, config, run } = await fixture();
    config.policy.publication = "none";
    await edit(run);
    expect(await publishRun(root, run, config)).toEqual({});
    expect(await count(run)).toBe("1");
    expect(await git(run.workspace!, "status", "--porcelain")).toContain(
      "math.cjs",
    );
  });

  it("returns nothing for a clean workspace with no earlier commit", async () => {
    const { root, config, run } = await fixture();
    expect(await publishRun(root, run, config)).toEqual({});
    expect(await count(run)).toBe("1");
  });

  it("refuses a recorded commit that is no longer at HEAD of a clean workspace", async () => {
    const { root, config, run } = await fixture();
    await expect(
      publishRun(root, { ...run, commit: "a".repeat(40) }, config),
    ).rejects.toThrow("recorded run commit is no longer at the workspace HEAD");
  });

  it("refuses a recorded commit that differs from the run's own commit at HEAD", async () => {
    const { root, config, run } = await fixture();
    await edit(run);
    const published = await publishRun(root, run, config);
    expect(published.commit).toMatch(/^[a-f0-9]{40}$/);
    await expect(
      publishRun(root, { ...run, commit: "b".repeat(40) }, config),
    ).rejects.toThrow("recorded run commit does not match the workspace HEAD");
    expect(
      await publishRun(root, { ...run, commit: published.commit }, config),
    ).toEqual(published);
    expect(await count(run)).toBe("2");
  });
});

describe("publishRun commit content", () => {
  it("writes a one-line subject capped at 100 characters and a run trailer", async () => {
    const { root, config, run } = await fixture(
      `Fix\r\naddition\nnow ${"x".repeat(200)}`,
    );
    await edit(run);
    await publishRun(root, run, config);
    const message = await git(run.workspace!, "log", "-1", "--format=%B");
    const [subject, , trailer] = message.split("\n");
    expect(subject).toMatch(/^feat: Fix {2}addition now x+$/);
    expect(subject!.length).toBe("feat: ".length + 100);
    expect(trailer).toBe("Graph-Run-Id: edge-run");
  });

  it("commits only the changed files and records a staged deletion", async () => {
    const { root, config, run } = await fixture();
    await rm(path.join(run.workspace!, "math.cjs"));
    await edit(run, "added.cjs", "exports.added = 1;\n");
    const { commit } = await publishRun(root, run, config);
    const files = (
      await git(run.workspace!, "show", "--name-status", "--format=", commit!)
    ).split("\n");
    expect(files.sort()).toEqual(["A\tadded.cjs", "D\tmath.cjs"]);
    expect(await git(run.workspace!, "status", "--porcelain")).toBe("");
  });

  it("refuses when Git would normalise the verified bytes while staging", async () => {
    const { root, config, run } = await fixture();
    await edit(run, ".gitattributes", "*.txt text eol=lf\n");
    await edit(run, "notes.txt", "one\r\ntwo\r\n");
    await expect(publishRun(root, run, config)).rejects.toThrow(
      "Git normalization changes verified source bytes",
    );
    expect(await count(run)).toBe("1");
  });
});

describe("publishRun cancellation", () => {
  it("stops before doing anything when already cancelled", async () => {
    const { root, config, run } = await fixture();
    await edit(run);
    await expect(
      publishRun(root, run, config, undefined, AbortSignal.abort()),
    ).rejects.toThrow("Run cancelled before publication");
    expect(await count(run)).toBe("1");
  });

  it("says a commit may exist when cancelled after committing", async () => {
    const { root, config, run } = await fixture();
    await edit(run);
    const controller = new AbortController();
    const real = util.command;
    vi.spyOn(util, "command").mockImplementation(async (exe, argv, opts) => {
      const result = await real(exe, argv, opts);
      if (exe === "git" && argv.includes("commit")) controller.abort();
      return result;
    });
    await expect(
      publishRun(root, run, config, undefined, controller.signal),
    ).rejects.toThrow("after its commit was created; reconcile the run branch");
    expect(await count(run)).toBe("2");
  });

  it("says the branch may be on the remote when cancelled after pushing", async () => {
    const { root, config, run } = await fixture();
    draftPr(config);
    await addRemote(root);
    await edit(run);
    const controller = new AbortController();
    const calls = fakeGithub({ onPush: () => controller.abort() });
    await expect(
      publishRun(root, run, config, undefined, controller.signal),
    ).rejects.toThrow(
      "after its branch was pushed; reconcile the remote branch",
    );
    expect(calls.push).toHaveLength(1);
    expect(calls.list).toHaveLength(0);
  });
});

describe("publishRun draft pull requests", () => {
  it("needs the GitHub repository configured", async () => {
    const { root, config, run } = await fixture();
    draftPr(config);
    config.github = undefined;
    await expect(publishRun(root, run, config)).rejects.toThrow(
      "Configure the GitHub repository",
    );
  });

  it.each(["main", "master"])(
    "refuses %s as the pull request base",
    async (baseBranch) => {
      const { root, config, run } = await fixture();
      draftPr(config, { baseBranch });
      await expect(publishRun(root, run, config)).rejects.toThrow(
        "main/master PR targets are prohibited",
      );
    },
  );

  it.each([
    "-upload-pack=x",
    "-origin",
    "--",
    "has space",
    "a;b",
    "",
    "origin\nother",
  ])(
    "refuses the remote name %j before running any Git command against it",
    async (remote) => {
      const { root, config, run } = await fixture();
      draftPr(config, { remote });
      await edit(run);
      await expect(publishRun(root, run, config)).rejects.toThrow(
        "Invalid Git remote name",
      );
      expect(await count(run)).toBe("1");
    },
  );

  it("refuses more than one push URL", async () => {
    const { root, config, run } = await fixture();
    draftPr(config);
    await addRemote(root);
    await git(
      root,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "https://github.com/test-owner/test-repo.git",
    );
    await git(
      root,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "https://github.com/test-owner/test-repo",
    );
    await expect(publishRun(root, run, config)).rejects.toThrow(
      "push remote does not match",
    );
  });

  it.each([
    "https://github.com/someone-else/test-repo.git",
    "https://github.com/test-owner/test-repo-extra.git",
    "http://github.com/test-owner/test-repo.git",
    "https://github.com.evil.test/test-owner/test-repo.git",
    "ssh://git@gitlab.example.test/test-owner/test-repo.git",
  ])("refuses the push URL %s", async (url) => {
    const { root, config, run } = await fixture();
    draftPr(config);
    await addRemote(root, url);
    await edit(run);
    await expect(publishRun(root, run, config)).rejects.toThrow(
      "push remote does not match",
    );
    expect(await count(run)).toBe("1");
  });

  it.each([
    "https://github.com/test-owner/test-repo",
    "https://github.com/test-owner/test-repo.git",
    "git@github.com:test-owner/test-repo.git",
  ])("accepts the push URL %s", async (url) => {
    const { root, config, run } = await fixture();
    draftPr(config);
    await addRemote(root, url);
    await edit(run);
    fakeGithub();
    const result = await publishRun(root, run, config);
    expect(result.pullRequest).toBe(
      "https://github.com/test-owner/test-repo/pull/7",
    );
  });

  it("accepts a configured repository written with a .git suffix", async () => {
    const { root, config, run } = await fixture();
    draftPr(config, { repository: "test-owner/test-repo.git" });
    await addRemote(root);
    await edit(run);
    const calls = fakeGithub();
    await publishRun(root, run, config);
    expect(calls.list[0]).toContain("github.com/test-owner/test-repo");
  });

  it("pushes the run branch, then opens a draft PR with a bounded title and a body file", async () => {
    const { root, config, run } = await fixture("T".repeat(300));
    draftPr(config);
    await addRemote(root);
    await edit(run);
    const calls = fakeGithub();
    const result = await publishRun(root, run, config);
    expect(result).toEqual({
      commit: await git(run.workspace!, "rev-parse", "HEAD"),
      pullRequest: "https://github.com/test-owner/test-repo/pull/7",
    });
    expect(calls.push[0]!.slice(-3)).toEqual([
      "--",
      "origin",
      `HEAD:refs/heads/${run.branch}`,
    ]);
    expect(calls.list[0]).toEqual(
      expect.arrayContaining([
        "--repo",
        "github.com/test-owner/test-repo",
        "--head",
        run.branch!,
        "--state",
        "open",
      ]),
    );
    const create = calls.create[0]!;
    const value = (flag: string) => create[create.indexOf(flag) + 1];
    expect(create.slice(0, 2)).toEqual(["pr", "create"]);
    expect(value("--repo")).toBe("github.com/test-owner/test-repo");
    expect(value("--base")).toBe("dev");
    expect(value("--head")).toBe(run.branch);
    expect(create).toContain("--draft");
    expect(value("--title")).toBe("T".repeat(200));
    const bodyFile = value("--body-file")!;
    expect(bodyFile).toBe(
      path.join(path.dirname(run.workspace!), "edge-run-pr.md"),
    );
    expect(await readFile(bodyFile, "utf8")).toBe(
      `Implements: ${"T".repeat(300)}\n\nAcceptance criteria:\n- addition works\n- subtraction still works\n\nAutomated verification completed for this run. Review the changes before merging.\n\nAgile Graph run: edge-run\n`,
    );
    expect((await stat(bodyFile)).mode & 0o777).toBe(0o600);
  });

  it("returns an existing open pull request instead of creating another", async () => {
    const { root, config, run } = await fixture();
    draftPr(config);
    await addRemote(root);
    await edit(run);
    const calls = fakeGithub({
      existing: "https://github.com/test-owner/test-repo/pull/3\n",
    });
    const result = await publishRun(root, run, config);
    expect(result.pullRequest).toBe(
      "https://github.com/test-owner/test-repo/pull/3",
    );
    expect(calls.create).toHaveLength(0);
  });

  it("stops without creating a PR when the existing PR lookup fails", async () => {
    const { root, config, run } = await fixture();
    draftPr(config);
    await addRemote(root);
    await edit(run);
    const calls = fakeGithub({ listCode: 1 });
    await expect(publishRun(root, run, config)).rejects.toThrow(
      "Cannot reconcile existing pull requests",
    );
    expect(calls.create).toHaveLength(0);
  });

  it("does not push or open a PR in commit mode", async () => {
    const { root, config, run } = await fixture();
    await edit(run);
    const calls = fakeGithub();
    const result = await publishRun(root, run, config);
    expect(Object.keys(result)).toEqual(["commit"]);
    expect(calls.push).toHaveLength(0);
    expect(calls.list).toHaveLength(0);
  });
});
