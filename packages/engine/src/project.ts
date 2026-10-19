import { mkdir, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";
import { z } from "zod";
import {
  assertProjectConfig,
  assertInstalledWorkerIdentity,
  DEFAULT_POLICY,
  isInstalledKind,
  PROVIDER_KINDS,
  SCHEMA_VERSION,
  type ProjectConfig,
  type ProjectPolicy,
  type ProviderConfig,
} from "@agile-graph/contracts";
import {
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
  pickDataDir,
} from "./promotion-local-paths.js";
import { id, readJson, writeJson } from "./util.js";

export const PROJECT_FILE = ".graph/project.json";
export async function loadProject(root: string): Promise<ProjectConfig> {
  const file = path.join(root, PROJECT_FILE);
  let value: unknown;
  try {
    value = await readJson<unknown>(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Keeps the ENOENT code: initializeProject creates the file on it.
    throw Object.assign(
      new Error(
        `No Agile Graph project at ${root}: run graph-engine init there, or pass -C <project root> before the command`,
        { cause: error },
      ),
      { code: "ENOENT" },
    );
  }
  assertProjectConfig(value);
  return value;
}
/**
 * The policy of a new project whose person chose to let cloud-backed MCP
 * clients retrieve context: inference and network become "allowlisted" so
 * the MCP server stops refusing cloud clients, and exportPaths is exactly
 * the globs the person named. providers and allowedHosts stay empty, so no
 * cloud or installed worker and no network host is permitted by this alone.
 */
export function cloudMcpPolicy(exportPaths: string[]): ProjectPolicy {
  const globs = exportPaths.map((glob) => glob.trim());
  if (!globs.some((glob) => glob !== "" && !glob.startsWith("!")))
    throw new Error(
      "--cloud-mcp needs at least one --export <glob> naming the files cloud clients may receive, such as --export 'src/**'",
    );
  if (globs.some((glob) => glob === "" || glob === "!"))
    throw new Error("An --export glob cannot be empty");
  const doubled = globs.find((glob) => glob.startsWith("!!"));
  if (doubled !== undefined)
    throw new Error(
      `An --export glob cannot start with "!!" (${doubled}); use one "!" to exclude`,
    );
  const repeated = globs.find((glob, index) => globs.indexOf(glob) !== index);
  if (repeated !== undefined)
    throw new Error(`--export ${repeated} is given more than once`);
  return {
    ...structuredClone(DEFAULT_POLICY),
    inference: "allowlisted",
    network: "allowlisted",
    exportPaths: globs,
  };
}
export interface InitializeOptions {
  /** Globs cloud MCP clients may receive; set means cloud MCP access is on. */
  cloudMcpExportPaths?: string[];
}
export async function initializeProject(
  root: string,
  name?: string,
  options: InitializeOptions = {},
): Promise<ProjectConfig> {
  const absolute = await realpath(root);
  const policy =
    options.cloudMcpExportPaths === undefined
      ? structuredClone(DEFAULT_POLICY)
      : cloudMcpPolicy(options.cloudMcpExportPaths);
  try {
    const existing = await loadProject(absolute);
    if (options.cloudMcpExportPaths !== undefined)
      throw new Error(
        `${PROJECT_FILE} already exists; --cloud-mcp only sets up a new project and never changes an existing policy. Edit policy.inference, policy.network and policy.exportPaths there yourself.`,
      );
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config: ProjectConfig = {
    version: SCHEMA_VERSION,
    projectId: id(),
    name: name ?? path.basename(absolute),
    policy,
    verification: [],
  };
  // Never write a file every later load would refuse.
  assertProjectConfig(config);
  await writeJson(path.join(absolute, PROJECT_FILE), config);
  return config;
}
/**
 * The engine's private data root: GRAPH_ENGINE_DATA_DIR when set, else the
 * per-user `agile-graph` folder, or the legacy `graph-engineering` folder when
 * only that exists. Nothing is moved or deleted.
 */
export function engineDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  exists?: (dir: string) => boolean,
): string {
  if (env.GRAPH_ENGINE_DATA_DIR !== undefined) return env.GRAPH_ENGINE_DATA_DIR;
  return pickDataDir(
    envPaths(DATA_DIR_NAME, { suffix: "" }).data,
    envPaths(LEGACY_DATA_DIR_NAME, { suffix: "" }).data,
    exists,
  );
}
export function projectDataDir(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(projectId))
    throw new Error("Invalid project ID");
  return path.join(engineDataRoot(), "projects", projectId);
}
const providerSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    kind: z.enum(PROVIDER_KINDS),
    model: z.string().min(1),
    endpoint: z.string().url().optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    efforts: z.array(z.string()).optional(),
    defaultEffort: z.string().optional(),
    inputCostPerMillion: z.number().nonnegative().optional(),
    outputCostPerMillion: z.number().nonnegative().optional(),
    maxContextTokens: z.number().int().positive().optional(),
    localOptions: z
      .object({
        enableThinking: z.boolean().optional(),
        thinkingBudget: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    installedIdentity: z
      .object({ realpath: z.string(), sha256: z.string() })
      .strict()
      .superRefine((identity, context) => {
        try {
          assertInstalledWorkerIdentity(identity);
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Installed identity needs an absolute path and lowercase SHA-256",
          });
        }
      })
      .optional(),
  })
  .strict()
  .refine(
    (provider) => !provider.localOptions || provider.kind === "local",
    "Local inference options apply only to local providers",
  )
  .refine(
    (provider) => !provider.installedIdentity || isInstalledKind(provider.kind),
    "Installed identities apply only to installed providers",
  )
  // An OpenAI-compatible gateway has no default address or key variable to
  // fall back on, so both are part of its configuration.
  .refine(
    (provider) => provider.kind !== "chat" || provider.endpoint !== undefined,
    "A chat provider needs its HTTPS endpoint (--endpoint <url>)",
  )
  .refine(
    (provider) => provider.kind !== "chat" || provider.apiKeyEnv !== undefined,
    "A chat provider needs the environment variable holding its API key (--api-key-env <name>)",
  );
export async function loadProviders(
  dataDir: string,
): Promise<ProviderConfig[]> {
  try {
    const providers = z
      .array(providerSchema)
      .parse(await readJson(path.join(dataDir, "providers.json")));
    if (new Set(providers.map((p) => p.id)).size !== providers.length)
      throw new Error("Duplicate provider IDs");
    return providers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function configureProvider(
  dataDir: string,
  provider: ProviderConfig,
): Promise<void> {
  const valid = providerSchema.parse(provider);
  const providers = await loadProviders(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeJson(path.join(dataDir, "providers.json"), [
    ...providers.filter((p) => p.id !== valid.id),
    valid,
  ]);
}
export async function projectExists(root: string): Promise<boolean> {
  try {
    await readFile(path.join(root, PROJECT_FILE));
    return true;
  } catch {
    return false;
  }
}
