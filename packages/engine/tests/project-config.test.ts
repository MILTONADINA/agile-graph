import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ProviderConfig } from "@agile-graph/contracts";
import {
  PROJECT_FILE,
  cloudMcpPolicy,
  configureProvider,
  initializeProject,
  loadProject,
  loadProviders,
  projectDataDir,
  projectExists,
} from "../src/project.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-project-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const provider = (over: Record<string, unknown> = {}): ProviderConfig =>
  ({ id: "fixture", kind: "local", model: "toy-model", ...over }) as never;
const projectFile = (root: string) => path.join(root, PROJECT_FILE);

describe("cloudMcpPolicy", () => {
  it("turns on inference and network but permits no provider or host", () => {
    const policy = cloudMcpPolicy(["src/**", "!src/private/**"]);
    expect(policy).toMatchObject({
      inference: "allowlisted",
      network: "allowlisted",
      exportPaths: ["src/**", "!src/private/**"],
      providers: [],
      allowedHosts: [],
      publication: DEFAULT_POLICY.publication,
      decisionMode: "shadow",
    });
  });

  it("trims globs and never shares state with the default policy", () => {
    const policy = cloudMcpPolicy(["  src/**  "]);
    expect(policy.exportPaths).toEqual(["src/**"]);
    policy.excludedPaths.push("mutated");
    expect(DEFAULT_POLICY.excludedPaths).not.toContain("mutated");
    expect(DEFAULT_POLICY.inference).toBe("local");
    expect(DEFAULT_POLICY.network).toBe("deny");
  });

  it.each([
    ["no globs", []],
    ["only exclusions", ["!src/private/**"]],
    ["only blanks", ["", "  "]],
  ])("needs at least one inclusive glob: %s", (_name, globs) => {
    expect(() => cloudMcpPolicy(globs)).toThrow(
      "needs at least one --export <glob>",
    );
  });

  it.each([[["src/**", ""]], [["src/**", "   "]], [["src/**", "!"]]])(
    "refuses an empty glob among others: %j",
    (globs) => {
      expect(() => cloudMcpPolicy(globs)).toThrow(
        "An --export glob cannot be empty",
      );
    },
  );

  it("refuses a glob starting with two exclamation marks", () => {
    expect(() => cloudMcpPolicy(["src/**", "!!src/x"])).toThrow(
      'cannot start with "!!" (!!src/x)',
    );
  });

  it("refuses a repeated glob, also after trimming", () => {
    expect(() => cloudMcpPolicy(["src/**", "lib/**", "src/**"])).toThrow(
      "--export src/** is given more than once",
    );
    expect(() => cloudMcpPolicy(["src/**", " src/** "])).toThrow(
      "given more than once",
    );
  });
});

describe("initializeProject and loadProject", () => {
  it("names a missing project with an ENOENT code that init relies on", async () => {
    const error = await loadProject(dir).catch((e) => e);
    expect(error.message).toContain(`No Agile Graph project at ${dir}`);
    expect(error.code).toBe("ENOENT");
    expect(await projectExists(dir)).toBe(false);
  });

  it("does not hide a corrupt project file behind the missing-project message", async () => {
    await mkdir(path.join(dir, ".graph"));
    await writeFile(projectFile(dir), "{broken");
    await expect(loadProject(dir)).rejects.toThrow(SyntaxError);
    expect(await projectExists(dir)).toBe(true);
    await writeFile(projectFile(dir), JSON.stringify({ version: 1 }));
    await expect(loadProject(dir)).rejects.toThrow(
      "Invalid project configuration",
    );
  });

  it("creates a project with the default policy, a fresh id and the folder name", async () => {
    const root = path.join(dir, "toy-app");
    await mkdir(root);
    const config = await initializeProject(root);
    expect(config.name).toBe("toy-app");
    expect(config.policy).toEqual(DEFAULT_POLICY);
    expect(config.verification).toEqual([]);
    expect(config.projectId).toMatch(/^[a-zA-Z0-9_-]{8,80}$/);
    expect(JSON.parse(await readFile(projectFile(root), "utf8"))).toEqual(
      config,
    );
    expect(await loadProject(root)).toEqual(config);
    expect(await projectExists(root)).toBe(true);
    // Only the project file is left, not a stray temporary file.
    expect(await readdir(path.join(root, ".graph"))).toEqual(["project.json"]);
  });

  it("uses the given name and gives two projects different ids", async () => {
    const a = path.join(dir, "a"),
      b = path.join(dir, "b");
    await mkdir(a);
    await mkdir(b);
    const first = await initializeProject(a, "Named");
    const second = await initializeProject(b);
    expect(first.name).toBe("Named");
    expect(first.projectId).not.toBe(second.projectId);
  });

  it("resolves a symlinked root to its real path for the default name", async () => {
    const real = path.join(dir, "real-name");
    await mkdir(real);
    await symlink(real, path.join(dir, "link"));
    const config = await initializeProject(path.join(dir, "link"));
    expect(config.name).toBe("real-name");
    expect(await projectExists(real)).toBe(true);
  });

  it("returns an existing project unchanged instead of overwriting it", async () => {
    const first = await initializeProject(dir, "First");
    const again = await initializeProject(dir, "Second");
    expect(again).toEqual(first);
    expect(again.name).toBe("First");
  });

  it("writes the cloud MCP policy only for a new project", async () => {
    const config = await initializeProject(dir, undefined, {
      cloudMcpExportPaths: ["src/**"],
    });
    expect(config.policy).toMatchObject({
      inference: "allowlisted",
      network: "allowlisted",
      exportPaths: ["src/**"],
      allowedHosts: [],
    });
  });

  it("refuses --cloud-mcp for an existing project and leaves its policy alone", async () => {
    const first = await initializeProject(dir);
    await expect(
      initializeProject(dir, undefined, { cloudMcpExportPaths: ["**"] }),
    ).rejects.toThrow("never changes an existing policy");
    expect(await loadProject(dir)).toEqual(first);
    expect((await loadProject(dir)).policy.network).toBe("deny");
  });

  it("validates the cloud globs before touching the disk", async () => {
    await expect(
      initializeProject(dir, undefined, { cloudMcpExportPaths: [] }),
    ).rejects.toThrow("needs at least one --export");
    expect(await projectExists(dir)).toBe(false);
  });

  it("surfaces a corrupt existing project instead of replacing it", async () => {
    await mkdir(path.join(dir, ".graph"));
    await writeFile(projectFile(dir), "{broken");
    await expect(initializeProject(dir)).rejects.toThrow(SyntaxError);
    expect(await readFile(projectFile(dir), "utf8")).toBe("{broken");
  });

  it("refuses a root that does not exist", async () => {
    await expect(initializeProject(path.join(dir, "missing"))).rejects.toThrow(
      "ENOENT",
    );
  });
});

describe("projectDataDir", () => {
  it.each([
    "short",
    "has space1",
    "../escape../",
    "a/b/c/d/e/f",
    "x".repeat(81),
    "",
  ])("rejects an unsafe project id: %j", (projectId) => {
    expect(() => projectDataDir(projectId)).toThrow("Invalid project ID");
  });

  it("accepts ids at the length limits and keeps the path under projects/", () => {
    for (const projectId of ["abcdefgh", "A_b-9".padEnd(80, "z")]) {
      const result = projectDataDir(projectId);
      expect(path.basename(result)).toBe(projectId);
      expect(path.basename(path.dirname(result))).toBe("projects");
    }
  });
});

describe("loadProviders and configureProvider", () => {
  it("reads no providers from a data directory without a providers file", async () => {
    expect(await loadProviders(path.join(dir, "absent"))).toEqual([]);
  });

  it("creates the data directory and replaces a provider with the same id", async () => {
    const data = path.join(dir, "data", "nested");
    await configureProvider(data, provider());
    await configureProvider(data, provider({ id: "other" }));
    await configureProvider(data, provider({ model: "replaced-model" }));
    const providers = await loadProviders(data);
    expect(providers.map((p) => p.id).sort()).toEqual(["fixture", "other"]);
    expect(providers.find((p) => p.id === "fixture")?.model).toBe(
      "replaced-model",
    );
  });

  it("does not write when the new provider is invalid", async () => {
    const data = path.join(dir, "data");
    await expect(
      configureProvider(data, provider({ id: "bad id!" })),
    ).rejects.toThrow();
    expect(await loadProviders(data)).toEqual([]);
  });

  it("rejects duplicate ids on disk", async () => {
    await writeFile(
      path.join(dir, "providers.json"),
      JSON.stringify([provider(), provider({ model: "second" })]),
    );
    await expect(loadProviders(dir)).rejects.toThrow("Duplicate provider IDs");
  });

  it("does not hide a corrupt providers file as an empty list", async () => {
    await writeFile(path.join(dir, "providers.json"), "{broken");
    await expect(loadProviders(dir)).rejects.toThrow(SyntaxError);
    await expect(configureProvider(dir, provider())).rejects.toThrow(
      SyntaxError,
    );
  });

  it.each([
    ["an unknown kind", { kind: "mystery" }],
    ["an empty model", { model: "" }],
    ["an unknown field", { surprise: true }],
    ["a malformed endpoint", { endpoint: "not a url" }],
    ["a lowercase key variable", { apiKeyEnv: "lower_case" }],
    ["a negative cost", { inputCostPerMillion: -1 }],
    ["a fractional context size", { maxContextTokens: 1.5 }],
    ["a zero context size", { maxContextTokens: 0 }],
    ["an unknown local option", { localOptions: { other: 1 } }],
  ])("rejects %s", async (_name, over) => {
    await expect(configureProvider(dir, provider(over))).rejects.toThrow();
  });

  it("allows local options only on a local provider", async () => {
    await configureProvider(
      dir,
      provider({ localOptions: { enableThinking: true, thinkingBudget: 0 } }),
    );
    await expect(
      configureProvider(
        dir,
        provider({
          id: "api",
          kind: "openai",
          localOptions: { enableThinking: true },
        }),
      ),
    ).rejects.toThrow("Local inference options apply only to local providers");
  });

  it("allows an installed identity only on an installed provider and checks its shape", async () => {
    const identity = {
      realpath: "/opt/toy/bin/worker",
      sha256: "a".repeat(64),
    };
    await configureProvider(
      dir,
      provider({ id: "inst", kind: "codex", installedIdentity: identity }),
    );
    await expect(
      configureProvider(
        dir,
        provider({ id: "loc", kind: "local", installedIdentity: identity }),
      ),
    ).rejects.toThrow("Installed identities apply only to installed providers");
    for (const bad of [
      { realpath: "relative/path", sha256: "a".repeat(64) },
      { realpath: "/opt/toy/bin/worker", sha256: "A".repeat(64) },
      { realpath: "/opt/toy/bin/worker", sha256: "abc" },
    ])
      await expect(
        configureProvider(
          dir,
          provider({ id: "x", kind: "claude", installedIdentity: bad }),
        ),
      ).rejects.toThrow("Installed identity needs an absolute path");
  });

  it("requires an endpoint and a key variable for a chat provider", async () => {
    await expect(
      configureProvider(
        dir,
        provider({ id: "c", kind: "chat", apiKeyEnv: "TOY_KEY" }),
      ),
    ).rejects.toThrow("needs its HTTPS endpoint");
    await expect(
      configureProvider(
        dir,
        provider({
          id: "c",
          kind: "chat",
          endpoint: "https://gateway.test/v1",
        }),
      ),
    ).rejects.toThrow("needs the environment variable");
    await configureProvider(
      dir,
      provider({
        id: "c",
        kind: "chat",
        endpoint: "https://gateway.test/v1",
        apiKeyEnv: "TOY_KEY",
      }),
    );
    expect((await loadProviders(dir))[0]).toMatchObject({ kind: "chat" });
  });
});
