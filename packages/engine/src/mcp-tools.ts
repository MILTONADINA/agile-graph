// The MCP server's optional tools, kept apart from mcp.ts so the command line
// can validate --allow-tool without loading the server.

/** The tools `--allow-run` enables: they plan, start and cancel runs. */
export const MCP_RUN_CONTROL_TOOLS = [
  "run_start",
  "run_cancel",
  "plan_create",
  "plan_decompose",
] as const;
/**
 * The tools `--allow-run-status` enables for a cloud client; a local client
 * gets them by default.
 */
export const MCP_RUN_STATUS_TOOLS = [
  "run_status",
  "run_list",
  "run_events",
] as const;
/** Tools that are off unless the server is started with them allowed. */
export const MCP_OPTIONAL_TOOLS = [
  ...MCP_RUN_CONTROL_TOOLS,
  ...MCP_RUN_STATUS_TOOLS,
] as const;
export type McpOptionalTool = (typeof MCP_OPTIONAL_TOOLS)[number];
/** Validates `--allow-tool` names; an unknown name is refused, not ignored. */
export function parseAllowedTools(names: readonly string[]): McpOptionalTool[] {
  const unknown = names.filter(
    (name) => !(MCP_OPTIONAL_TOOLS as readonly string[]).includes(name),
  );
  if (unknown.length)
    throw new Error(
      `--allow-tool does not know ${unknown.join(", ")}; it takes ${MCP_OPTIONAL_TOOLS.join(", ")}`,
    );
  return [...new Set(names)] as McpOptionalTool[];
}
