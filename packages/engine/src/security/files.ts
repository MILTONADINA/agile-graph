// Dockerfile names: Dockerfile, Dockerfile.dev, Dockerfile-dev,
// Dockerfile.prod.local, Containerfile and api.dockerfile. A name that ends
// in a source, data or template extension is not a Dockerfile.
const DOCKERFILE =
  /(^|\/)((dockerfile|containerfile)([.-][a-z0-9_-]+)*|[^/]+\.dockerfile)$/i;
const NOT_DOCKERFILE =
  /\.(dockerignore|template|tmpl|md|txt|json|ya?ml|toml|lock|sh|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|kt|swift|c|h|cpp|hpp)$/i;

export function isDockerfile(file: string): boolean {
  return DOCKERFILE.test(file) && !NOT_DOCKERFILE.test(file);
}

// AI-agent configuration the agent-config tool reads. Matched by exact name,
// so an example such as .cursor/mcp.example.json is not configuration.
const AGENT_SETTINGS = /(^|\/)\.claude\/settings(\.[a-z0-9_-]+)*\.json$/i;
const MCP_CONFIG =
  /(^|\/)(\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|\.vscode\/settings\.json|\.gemini\/settings\.json|\.codex\/config\.toml|\.roo\/mcp\.json|opencode\.jsonc?|\.zed\/settings\.json)$/i;
// Instruction files and directories: Claude Code subagents and commands,
// Copilot instructions and prompts, Windsurf, Cline and Roo rules (only
// .roo/rules*/, so .roo/mcp.json is read as MCP configuration, not prose).
const INSTRUCTION_FILE =
  /(^|\/)(agents(\.override)?\.md|claude(\.local)?\.md|gemini\.md|skill\.md|\.cursorrules|\.windsurfrules|\.github\/copilot-instructions\.md|\.cursor\/rules\/.+|\.claude\/(agents|commands)\/.+|\.github\/instructions\/(.+\/)?[^/]+\.instructions\.md|\.github\/prompts\/(.+\/)?[^/]+\.prompt\.md|\.windsurf\/rules\/.+|\.clinerules(\/.+)?|\.roo\/rules(-[^/]+)?\/.+)$/i;
// VS Code tasks and launch configurations, which can run a command when the
// folder opens or before a debug session starts.
const AUTO_RUN_CONFIG = /(^|\/)\.vscode\/(tasks|launch)\.json$/i;

/** A Claude Code settings file: hooks, helpers and permissions. */
export function isAgentSettings(file: string): boolean {
  return AGENT_SETTINGS.test(file);
}

/** A file that declares MCP servers for an agent. */
export function isMcpConfig(file: string): boolean {
  return MCP_CONFIG.test(file);
}

/** A file an agent reads as instructions. */
export function isInstructionFile(file: string): boolean {
  return INSTRUCTION_FILE.test(file);
}

/** A VS Code tasks.json or launch.json. */
export function isAutoRunConfig(file: string): boolean {
  return AUTO_RUN_CONFIG.test(file);
}

export function isAgentConfig(file: string): boolean {
  return (
    isAgentSettings(file) ||
    isMcpConfig(file) ||
    isInstructionFile(file) ||
    isAutoRunConfig(file)
  );
}
