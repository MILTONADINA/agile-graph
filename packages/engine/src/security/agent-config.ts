// The agent-config tool: AI-agent configuration is an attack surface. A hook
// or helper in a Claude Code settings file runs a shell command on the
// developer's machine, a broad permission lets an agent act without asking,
// an MCP server gives an agent new tools and network reach, and an
// instruction file can carry text that steers the agent. The tool runs
// in-process over the tracked files, with no container, and reports each of
// these as an ordinary finding, so the reviewed baseline decides which are
// accepted and a change that adds one is held for review.
//
// Findings never hold a command, its arguments, an environment value or a
// full URL: a hook or server is named by where it is declared, a program by
// its bare name and a URL by its host. The fingerprint still covers the
// declaring lines, so editing a command makes it a new finding.
import { createHash } from "node:crypto";
import { redact } from "../policy.js";
import { isAgentSettings, isInstructionFile, isMcpConfig } from "./files.js";
import type { SecurityFinding } from "./scan.js";

type Finding = Omit<SecurityFinding, "fingerprint">;
type Lines = readonly string[];

export const AGENT_CONFIG_TOOL = "agent-config";

export interface AgentConfigResult {
  findings: Finding[];
  /** Configuration files that could not be parsed, so were not checked. */
  unscanned: { path: string; reason: string }[];
}

/**
 * Checks the agent configuration among `files` (path to lines, as read for
 * the scan). Files of no interest are ignored.
 */
export function agentConfigFindings(
  files: ReadonlyMap<string, Lines>,
): AgentConfigResult {
  const result: AgentConfigResult = { findings: [], unscanned: [] };
  for (const [file, lines] of files) {
    if (isAgentSettings(file)) settingsFindings(file, lines, result);
    else if (isMcpConfig(file)) mcpFindings(file, lines, result);
    if (isInstructionFile(file))
      result.findings.push(...injectionFindings(file, lines));
  }
  result.findings = result.findings.map((finding) => ({
    ...finding,
    message: redact(finding.message),
  }));
  return result;
}

const finding = (
  rule: string,
  path: string,
  line: number,
  message: string,
  resource?: string,
): Finding => ({
  tool: AGENT_CONFIG_TOOL,
  rule,
  path,
  line,
  message,
  ...(resource ? { resource } : {}),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CLOSING = /\s*[}\]]/y;
const closes = (text: string, index: number) => {
  CLOSING.lastIndex = index;
  return CLOSING.test(text);
};

// JSON with comments and trailing commas, as VS Code and Cursor accept.
// Comments and trailing commas are dropped outside strings only.
export function parseJsonc(text: string): unknown {
  let out = "";
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"')
        end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated comment");
      out += " ";
      index = end + 2;
    } else if (char === "," && closes(text, index + 1)) {
      index++;
    } else {
      out += char;
      index++;
    }
  }
  return JSON.parse(out) as unknown;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The 1-based line of the first match at or after `from`, else 0. */
function lineOf(lines: Lines, pattern: RegExp, from = 0): number {
  for (let index = from; index < lines.length; index++)
    if (pattern.test(lines[index]!)) return index + 1;
  return 0;
}

/** The line declaring JSON key `key`, preferring one holding `value`. */
function jsonLine(lines: Lines, key: string, value?: string, from = 0) {
  const quoted = escape(JSON.stringify(key));
  return (
    (value === undefined
      ? 0
      : lineOf(
          lines,
          new RegExp(`${quoted}\\s*:\\s*${escape(JSON.stringify(value))}`),
          from,
        )) ||
    lineOf(lines, new RegExp(`${quoted}\\s*:`), from) ||
    lineOf(lines, new RegExp(`${quoted}\\s*:`)) ||
    1
  );
}

/**
 * A command's program when it is a bare name found on PATH, else undefined.
 * A path is not shown, even in part.
 */
export function programName(command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,39}$/.test(first) ? first : undefined;
}

const describeCommand = (command: string) => {
  const program = programName(command);
  return program
    ? `a shell command (program ${program}; the command is not shown)`
    : "a shell command (not shown)";
};

/** A name safe to print, or a short hash of it. */
const label = (name: string) =>
  /^[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,63}$/.test(name)
    ? name
    : `#${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;

// Settings keys whose string value is a command Claude Code runs.
const HELPERS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
];
// Tools that run commands, write files or reach the network.
const BROAD_TOOL =
  /^(Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch)(\((\*{1,2}|:\*|\*:\*|domain:\*)?\))?$/;
export const isBroadPermission = (entry: string) => {
  const trimmed = entry.trim();
  return (
    /^\*+$/.test(trimmed) ||
    /^mcp__\*+$/.test(trimmed) ||
    BROAD_TOOL.test(trimmed)
  );
};

function parsed(
  file: string,
  lines: Lines,
  result: AgentConfigResult,
): Record<string, unknown> | undefined {
  try {
    const value = parseJsonc(lines.join("\n"));
    return isObject(value) ? value : {};
  } catch {
    // The parser's message can quote file content, so it is not kept.
    result.unscanned.push({
      path: file,
      reason:
        "agent-config: not valid JSON, so its hooks and servers were not checked",
    });
    return undefined;
  }
}

function settingsFindings(
  file: string,
  lines: Lines,
  result: AgentConfigResult,
) {
  const settings = parsed(file, lines, result);
  if (!settings) return;
  const out = result.findings;
  // Hooks, in file order; the line cursor walks forward so repeated
  // commands land on their own lines.
  let cursor = Math.max(0, jsonLine(lines, "hooks") - 1);
  if (isObject(settings.hooks))
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) continue;
        for (const hook of group.hooks) {
          if (
            !isObject(hook) ||
            hook.type !== "command" ||
            typeof hook.command !== "string"
          )
            continue;
          const line = jsonLine(lines, "command", hook.command, cursor);
          cursor = line;
          out.push(
            finding(
              "hook-command",
              file,
              line,
              `A ${label(event)} hook runs ${describeCommand(hook.command)} on the developer's machine`,
              `hooks.${label(event)}`,
            ),
          );
        }
      }
    }
  if (
    isObject(settings.statusLine) &&
    typeof settings.statusLine.command === "string"
  ) {
    const from = jsonLine(lines, "statusLine") - 1;
    out.push(
      finding(
        "hook-command",
        file,
        jsonLine(lines, "command", settings.statusLine.command, from),
        `The status line runs ${describeCommand(settings.statusLine.command)}`,
        "statusLine",
      ),
    );
  }
  for (const key of HELPERS)
    if (typeof settings[key] === "string")
      out.push(
        finding(
          "hook-command",
          file,
          jsonLine(lines, key, settings[key]),
          `${key} runs ${describeCommand(settings[key])}`,
          key,
        ),
      );
  const permissions = isObject(settings.permissions)
    ? settings.permissions
    : {};
  if (Array.isArray(permissions.allow)) {
    const from = jsonLine(lines, "allow") - 1;
    for (const entry of permissions.allow)
      if (typeof entry === "string" && isBroadPermission(entry)) {
        const exact = lineOf(
          lines,
          new RegExp(escape(JSON.stringify(entry))),
          from,
        );
        out.push(
          finding(
            "permission-widening",
            file,
            exact || from + 1,
            `permissions.allow grants ${JSON.stringify(entry.trim())} without asking`,
            "permissions.allow",
          ),
        );
      }
  }
  if (permissions.defaultMode === "bypassPermissions")
    out.push(
      finding(
        "permission-widening",
        file,
        jsonLine(lines, "defaultMode", "bypassPermissions"),
        "permissions.defaultMode is bypassPermissions, so the agent never asks",
        "permissions.defaultMode",
      ),
    );
  for (const [where, value] of [
    ["dangerouslySkipPermissions", settings.dangerouslySkipPermissions],
    [
      "permissions.dangerouslySkipPermissions",
      permissions.dangerouslySkipPermissions,
    ],
  ] as const)
    if (value === true)
      out.push(
        finding(
          "permission-widening",
          file,
          jsonLine(lines, "dangerouslySkipPermissions"),
          `${where} is true, so the agent never asks`,
          where,
        ),
      );
}

/** Where an MCP server runs: a program by name or a URL by host. */
function serverTarget(server: Record<string, unknown>): string {
  const url = [server.url, server.serverUrl, server.httpUrl].find(
    (value): value is string => typeof value === "string",
  );
  if (url) {
    let host: string | undefined;
    try {
      host = new URL(url).hostname || undefined;
    } catch {
      host = undefined;
    }
    return host && /^[A-Za-z0-9.:[\]-]+$/.test(host)
      ? `connects to ${host}`
      : "connects to a URL that does not parse (not shown)";
  }
  if (typeof server.command === "string") {
    const program = programName(server.command);
    return program
      ? `runs the local program ${program} (arguments not shown)`
      : "runs a local command (not shown)";
  }
  return "has no command or URL the scan recognises";
}

function mcpFindings(file: string, lines: Lines, result: AgentConfigResult) {
  if (/\.toml$/i.test(file)) {
    result.findings.push(...codexServers(file, lines));
    return;
  }
  const config = parsed(file, lines, result);
  if (!config) return;
  for (const key of ["mcpServers", "servers"]) {
    const servers = config[key];
    if (!isObject(servers)) continue;
    const from = jsonLine(lines, key) - 1;
    for (const [name, server] of Object.entries(servers))
      result.findings.push(
        finding(
          "mcp-server",
          file,
          jsonLine(lines, name, undefined, from),
          `MCP server ${label(name)} ${isObject(server) ? serverTarget(server) : "is declared"}`,
          `${key}.${label(name)}`,
        ),
      );
  }
}

const TOML_KEY = String.raw`(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))`;
const TOML_STRING = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)')`;
// [mcp_servers.name], [mcp_servers] then name = { ... }, and the dotted
// key mcp_servers.name.field = ... at the top level.
const SERVER_TABLE = new RegExp(
  String.raw`^\s*\[\s*mcp_servers\s*\.\s*${TOML_KEY}\s*\]\s*(#.*)?$`,
);
const SERVERS_TABLE = /^\s*\[\s*mcp_servers\s*\]\s*(#.*)?$/;
const INLINE_SERVER = new RegExp(String.raw`^\s*${TOML_KEY}\s*=\s*\{(.*)$`);
const DOTTED_SERVER = new RegExp(
  String.raw`^\s*mcp_servers\s*\.\s*${TOML_KEY}\s*\.\s*([A-Za-z_]+)\s*=\s*(.*)$`,
);
const field = (name: string, text: string) => {
  const match = new RegExp(
    String.raw`(?:^|[\s,{])${name}\s*=\s*${TOML_STRING}`,
  ).exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
};

/**
 * MCP servers in a Codex config.toml, read line by line without a TOML
 * parser: the common table, inline-table and dotted-key forms.
 */
export function codexServers(file: string, lines: Lines): Finding[] {
  const servers = new Map<string, { line: number; text: string }>();
  let section: "top" | "server" | "servers" | "other" = "top";
  let current: string | undefined;
  const add = (name: string, line: number, text: string) => {
    const known = servers.get(name);
    if (known) known.text += `\n${text}`;
    else servers.set(name, { line, text });
  };
  lines.forEach((raw, index) => {
    const line = raw.replace(/^\uFEFF/, "");
    const table = SERVER_TABLE.exec(line);
    if (table) {
      section = "server";
      current = table[1] ?? table[2] ?? table[3]!;
      add(current, index + 1, "");
      return;
    }
    if (SERVERS_TABLE.test(line)) {
      section = "servers";
      return;
    }
    if (/^\s*\[/.test(line)) {
      section = "other";
      return;
    }
    if (section === "server" && current) {
      servers.get(current)!.text += `\n${line}`;
      return;
    }
    if (section === "servers") {
      const inline = INLINE_SERVER.exec(line);
      if (inline) add(inline[1] ?? inline[2] ?? inline[3]!, index + 1, line);
      return;
    }
    const dotted = section === "top" ? DOTTED_SERVER.exec(line) : null;
    if (dotted)
      add(
        dotted[1] ?? dotted[2] ?? dotted[3]!,
        index + 1,
        `${dotted[4]} = ${dotted[5]}`,
      );
  });
  return [...servers].map(([name, { line, text }]) => {
    const command = field("command", text);
    const url = field("url", text);
    return finding(
      "mcp-server",
      file,
      line,
      `MCP server ${label(name)} ${serverTarget({
        ...(command !== undefined ? { command } : {}),
        ...(url !== undefined ? { url } : {}),
      })}`,
      `mcp_servers.${label(name)}`,
    );
  });
}

// Conservative, high-signal phrases only; a match names the pattern, never
// the matched text.
const INJECTION: [string, RegExp, string][] = [
  [
    "ignore-instructions",
    /\bignore\s+(all\s+)?(the\s+|any\s+|your\s+)?(previous|prior)\s+instructions\b/i,
    "tells the agent to ignore its previous instructions",
  ],
  [
    "disregard-system",
    /\bdisregard\s+(all\s+)?(the\s+|your\s+)?(system|above)\b/i,
    "tells the agent to disregard its system prompt or earlier text",
  ],
  [
    "pipe-to-shell",
    /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i,
    "downloads a script and pipes it to a shell",
  ],
  [
    "send-to-url",
    /\bsend\b[^\n]{0,200}?\bto\s+https?:\/\//i,
    "asks the agent to send something to a URL",
  ],
  [
    "invisible-unicode",
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u,
    "holds invisible or bidirectional-control Unicode characters",
  ],
];
const BLOB = /[A-Za-z0-9+/]{200,}={0,2}/g;
const isBlob = (text: string) =>
  /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text);

export function injectionFindings(file: string, lines: Lines): Finding[] {
  const out: Finding[] = [];
  lines.forEach((raw, index) => {
    // A byte-order mark opening the file is not hidden text.
    const line = index === 0 ? raw.replace(/^\uFEFF/, "") : raw;
    for (const [id, pattern, what] of INJECTION)
      if (pattern.test(line))
        out.push(
          finding(
            "prompt-injection",
            file,
            index + 1,
            `An agent instruction file ${what}`,
            id,
          ),
        );
    if ((line.match(BLOB) ?? []).some(isBlob))
      out.push(
        finding(
          "prompt-injection",
          file,
          index + 1,
          "An agent instruction file holds an encoded blob over 200 characters",
          "base64-blob",
        ),
      );
  });
  return out;
}
