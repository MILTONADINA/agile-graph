#!/usr/bin/env node
// Installs the packed contracts and engine tarballs into an empty project, as
// a user would from npm, then runs the installed CLI: --version, --help, init
// and a lexical index of a throwaway repository, an MCP initialize handshake,
// and the dashboard that serve hosts. Optional peer dependencies are not
// installed, so this also shows the engine starts without them.
//
// Run from a built checkout (npm run build). Third-party dependencies come
// from the npm registry; the two packages come only from their tarballs.
// HOME points into a temporary directory, so nothing is written to the
// caller's own data directory.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), "graph-npm-smoke-"));
const home = path.join(work, "home");
const app = path.join(work, "app");
const project = path.join(work, "project");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  GRAPH_ENGINE_NO_FEEDBACK: "1",
  npm_config_audit: "false",
  npm_config_fund: "false",
};
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, env, encoding: "utf8" });

function pack(workspace) {
  const [packed] = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--workspace",
        workspace,
        "--pack-destination",
        work,
      ],
      repository,
    ),
  );
  return path.join(work, packed.filename);
}

/** Starts the CLI and resolves with its first stdout line while it runs. */
function started(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd: project, env });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`graph-engine ${args.join(" ")} timed out: ${errors}`));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const end = output.indexOf("\n");
      if (end === -1) return;
      clearTimeout(timer);
      resolve({ line: output.slice(0, end), stop: () => child.kill() });
    });
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!output.includes("\n"))
        reject(
          new Error(`graph-engine ${args.join(" ")} exited ${code}: ${errors}`),
        );
    });
    if (input) child.stdin.write(input);
  });
}

let cli;
try {
  await mkdir(home, { recursive: true });
  await mkdir(app);
  await mkdir(path.join(project, "src"), { recursive: true });
  // The engine's prepack builds what its tarball holds; it runs here, not
  // inside npm pack, whose JSON output its build logs would interleave.
  execFileSync("node", ["packages/engine/scripts/prepack.mjs"], {
    cwd: repository,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const contracts = pack("packages/contracts");
  const engine = pack("packages/engine");
  await writeFile(
    path.join(app, "package.json"),
    JSON.stringify({ name: "graph-npm-smoke", private: true }),
  );
  run("npm", ["install", "--no-package-lock", contracts, engine], app);
  cli = path.join(app, "node_modules", ".bin", "graph-engine");

  const { version } = JSON.parse(
    await readFile(
      path.join(repository, "packages/engine/package.json"),
      "utf8",
    ),
  );
  const printed = run(cli, ["--version"], app).trim();
  if (printed !== version)
    throw new Error(`--version printed ${printed}, expected ${version}`);
  if (!run(cli, ["--help"], app).includes("Usage: graph-engine"))
    throw new Error("--help did not print the usage");

  await writeFile(
    path.join(project, "src", "add.js"),
    "export function add(a, b) {\n  return a + b;\n}\n",
  );
  run("git", ["init", "--quiet"], project);
  run(cli, ["-C", project, "init"], app);
  run(cli, ["-C", project, "index", "--lexical"], app);

  const mcp = await started(
    ["-C", project, "mcp", "--client", "local"],
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "graph-npm-smoke", version: "1" },
      },
    })}\n`,
  );
  mcp.stop();
  if (!JSON.parse(mcp.line).result?.serverInfo)
    throw new Error(`MCP initialize failed: ${mcp.line}`);

  const server = await started(["-C", project, "serve"]);
  try {
    const address = server.line.split("/#")[0];
    const page = await fetch(`${address}/`).then((response) => response.text());
    if (!page.includes('<div id="root">'))
      throw new Error("serve did not host the bundled dashboard");
  } finally {
    server.stop();
  }

  console.log(
    `npm smoke passed: ${path.basename(contracts)} and ${path.basename(engine)} install, and the CLI, MCP server and dashboard start.`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
