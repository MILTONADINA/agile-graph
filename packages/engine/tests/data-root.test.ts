import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";
import { engineDataRoot, projectDataDir } from "../src/project.js";
import { feedbackDir } from "../src/feedback.js";
import {
  pickDataDir,
  promotionUserDataDir,
} from "../src/promotion-local-paths.js";
import { defaultRekorStateDir } from "../src/promotion-rekor-witness.js";
import { mcpToolListingSha256 } from "../src/mcp.js";

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of homes.splice(0))
    await rm(dir, { recursive: true, force: true });
});

// env-paths reads the home directory once at import, so the per-user folders
// are the real ones; only which of them "exists" is faked.
const current = envPaths("agile-graph", { suffix: "" }).data;
const legacy = envPaths("graph-engineering", { suffix: "" }).data;
const present =
  (...dirs: string[]) =>
  (dir: string) =>
    dirs.includes(dir);

describe("engineDataRoot", () => {
  it("uses the agile-graph folder for a new install", () => {
    expect(engineDataRoot({}, present())).toBe(current);
    expect(path.basename(projectDataDir("project-aaaa"))).toBe("project-aaaa");
  });

  it("keeps a legacy graph-engineering folder when only it exists", () => {
    expect(engineDataRoot({}, present(legacy))).toBe(legacy);
  });

  it("prefers the agile-graph folder when both exist, and moves nothing", () => {
    expect(engineDataRoot({}, present(legacy, current))).toBe(current);
    expect(engineDataRoot({}, present(current))).toBe(current);
  });

  it("lets GRAPH_ENGINE_DATA_DIR win over both folders", () => {
    const env = { GRAPH_ENGINE_DATA_DIR: "/chosen/data" };
    expect(engineDataRoot(env, present(legacy))).toBe("/chosen/data");
    expect(engineDataRoot(env, present(current, legacy))).toBe("/chosen/data");
    vi.stubEnv("GRAPH_ENGINE_DATA_DIR", "/chosen/data");
    expect(projectDataDir("project-aaaa")).toBe(
      path.join("/chosen/data", "projects", "project-aaaa"),
    );
    expect(feedbackDir()).toBe(path.join("/chosen/data", "feedback"));
  });
});

describe("promotion user data directory", () => {
  it("picks new for none or both, legacy only when it alone exists", () => {
    expect(pickDataDir("/n", "/l", present())).toBe("/n");
    expect(pickDataDir("/n", "/l", present("/l"))).toBe("/l");
    expect(pickDataDir("/n", "/l", present("/n", "/l"))).toBe("/n");
    expect(pickDataDir("/n", "/l", present("/n"))).toBe("/n");
  });

  it("applies the same fallback to the owner key, enrollment and Rekor paths", () => {
    const env = { XDG_DATA_HOME: "/x" };
    const legacyX = path.join("/x", "graph-engineering");
    const currentX = path.join("/x", "agile-graph");
    expect(promotionUserDataDir("linux", env, "/h", present())).toBe(currentX);
    expect(promotionUserDataDir("linux", env, "/h", present(legacyX))).toBe(
      legacyX,
    );
    expect(
      promotionUserDataDir("linux", env, "/h", present(legacyX, currentX)),
    ).toBe(currentX);
    expect(promotionUserDataDir("darwin", {}, "/Users/o", present())).toBe(
      path.join("/Users/o", "Library", "Application Support", "agile-graph"),
    );
  });

  it("keeps a legacy Rekor state folder when only the legacy data folder exists", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agile-graph-rekor-"));
    homes.push(home);
    const env = { XDG_DATA_HOME: path.join(home, "xdg") };
    expect(defaultRekorStateDir("linux", env, home)).toBe(
      path.join(home, "xdg", "agile-graph", "rekor-witness"),
    );
    await mkdir(path.join(home, "xdg", "graph-engineering"), {
      recursive: true,
    });
    expect(defaultRekorStateDir("linux", env, home)).toBe(
      path.join(home, "xdg", "graph-engineering", "rekor-witness"),
    );
  });
});

describe("MCP tool definition hashes", () => {
  it("hash only the tool name, description and input schema, never the server name", () => {
    // Pinned by operators; the rename to the agile-graph server name must not
    // change it.
    expect(
      mcpToolListingSha256({
        name: "context_get",
        description: "Fetch context.",
        inputSchema: { type: "object", properties: {} },
      }),
    ).toBe("5efd2cf921f3400ec2a955970f9dd0ea7af5acec1d9a2151c6a77bd915cfa1e4");
  });
});
