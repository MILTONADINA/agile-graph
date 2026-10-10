// The agent-config tool: AI-agent configuration is an attack surface. A hook
// or helper in a Claude Code settings file runs a shell command on the
// developer's machine, a broad permission lets an agent act without asking,
// an MCP server gives an agent new tools and network reach, an environment
// override redirects where the agent connects, and an instruction file can
// carry text that steers the agent. The tool runs in-process over the
// tracked files, with no container, and reports each of these as an
// ordinary finding, so the reviewed baseline decides which are accepted and
// a change that adds one is held for review.
//
// Findings never hold a command, its arguments, an environment value or a
// full URL: a hook or server is named by where it is declared, a program by
// its bare name and a URL by its host. The fingerprint still covers the
// declaring lines and, for hooks and MCP servers, a hash of the whole
// definition, so editing a command, argument or URL makes it a new finding.
//
// Every file is hostile input: no regular expression is built from file
// content, every pattern is bounded, lines are located through one linear
// index, and a file whose analysis fails is reported as unscanned.
import { createHash } from "node:crypto";
import { redact } from "../policy.js";
import { isAgentSettings, isInstructionFile, isMcpConfig } from "./files.js";
import type { SecurityFinding } from "./scan.js";

/**
 * A finding before fingerprinting. `identity` is a hash of the declaration
 * the finding is about; it goes into the fingerprint and is not recorded.
 */
export type AgentConfigFinding = Omit<SecurityFinding, "fingerprint"> & {
  identity?: string;
};
type Finding = AgentConfigFinding;
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
    const own: AgentConfigResult = { findings: [], unscanned: [] };
    try {
      if (isAgentSettings(file)) settingsFindings(file, lines, own);
      else if (isMcpConfig(file)) mcpFindings(file, lines, own);
      if (isInstructionFile(file))
        for (const found of injectionFindings(file, lines))
          own.findings.push(found);
    } catch {
      // A file that defeats the analysis is not passed unchecked; the error
      // can quote file content, so it is not kept.
      result.unscanned.push({
        path: file,
        reason: "agent-config: could not be analysed, so it was not checked",
      });
      continue;
    }
    for (const found of own.findings)
      result.findings.push({ ...found, message: redact(found.message) });
    for (const entry of own.unscanned) result.unscanned.push(entry);
  }
  return result;
}

const finding = (
  rule: string,
  path: string,
  line: number,
  message: string,
  resource?: string,
  identity?: string,
): Finding => ({
  tool: AGENT_CONFIG_TOOL,
  rule,
  path,
  line,
  message,
  ...(resource ? { resource } : {}),
  ...(identity ? { identity } : {}),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex")
    .slice(0, 32);

const SPACE = new Set([" ", "\t", "\n", "\r"]);

/** The index after whitespace and comments from `index`. */
function skipTrivia(text: string, index: number): number {
  for (;;) {
    while (index < text.length && SPACE.has(text[index]!)) index++;
    if (text[index] !== "/") return index;
    if (text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
    } else if (text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) return text.length;
      index = end + 2;
    } else return index;
  }
}

interface JsonString {
  start: number;
  /** Exclusive. */
  end: number;
  /** 1-based. */
  line: number;
}

/**
 * JSON with comments and trailing commas, as VS Code and Cursor accept, in
 * one linear pass that also records where each string literal sits.
 * Comments and trailing commas are dropped outside strings only.
 */
function scanJsonc(text: string): { value: unknown; strings: JsonString[] } {
  const chunks: string[] = [];
  const strings: JsonString[] = [];
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let copied = index;
  let line = 1;
  const drop = (from: number, to: number) => {
    chunks.push(text.slice(copied, from), " ");
    copied = to;
  };
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\n") line++;
        end += text[end] === "\\" ? 2 : 1;
      }
      strings.push({ start: index, end: end + 1, line });
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      drop(index, end < 0 ? text.length : end);
      index = end < 0 ? text.length : end;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated comment");
      for (let at = index; at < end; at++) if (text[at] === "\n") line++;
      drop(index, end + 2);
      index = end + 2;
    } else if (
      char === "," &&
      "}]".includes(text[skipTrivia(text, index + 1)] ?? "?")
    ) {
      // A trailing comma, even with comments before the bracket.
      drop(index, index + 1);
      index++;
    } else {
      if (char === "\n") line++;
      index++;
    }
  }
  chunks.push(text.slice(copied));
  return { value: JSON.parse(chunks.join("")) as unknown, strings };
}

export function parseJsonc(text: string): unknown {
  return scanJsonc(text).value;
}

/** First entry of an ascending list above `from`. */
function firstAfter(list: readonly number[] | undefined, from: number) {
  if (!list?.length) return 0;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle]! > from) high = middle;
    else low = middle + 1;
  }
  return list[low] ?? 0;
}

/**
 * Where each JSON key, key-value pair and string sits, built once per file
 * from the parser's own string positions, so lookups never rescan the file
 * or build a pattern from its content.
 */
class JsonLines {
  private readonly keys = new Map<string, number[]>();
  private readonly pairs = new Map<string, number[]>();
  private readonly strings = new Map<string, number[]>();

  constructor(text: string, literals: readonly JsonString[]) {
    const add = (map: Map<string, number[]>, key: string, line: number) => {
      const list = map.get(key);
      if (!list) map.set(key, [line]);
      else if (list[list.length - 1] !== line) list.push(line);
    };
    const decode = (literal: JsonString) => {
      try {
        const value = JSON.parse(text.slice(literal.start, literal.end));
        return typeof value === "string" ? value : undefined;
      } catch {
        return undefined;
      }
    };
    const decoded = literals.map(decode);
    literals.forEach((literal, index) => {
      const value = decoded[index];
      if (value === undefined) return;
      add(this.strings, value, literal.line);
      let at = literal.end;
      while (at < text.length && SPACE.has(text[at]!)) at++;
      if (text[at] !== ":") return;
      add(this.keys, value, literal.line);
      at++;
      while (at < text.length && SPACE.has(text[at]!)) at++;
      const next = literals[index + 1];
      const paired = decoded[index + 1];
      if (next?.start === at && paired !== undefined)
        add(this.pairs, `${value}\0${paired}`, literal.line);
    });
  }

  /**
   * The line declaring key `key` after line `from`, preferring one whose
   * value is `value`; else its first line anywhere; else 1.
   */
  key(key: string, value?: string, from = 0): number {
    return (
      (value === undefined
        ? 0
        : firstAfter(this.pairs.get(`${key}\0${value}`), from)) ||
      firstAfter(this.keys.get(key), from) ||
      this.keys.get(key)?.[0] ||
      1
    );
  }

  /** The line of string `value` after line `from`, else 0. */
  string(value: string, from = 0): number {
    return firstAfter(this.strings.get(value), from);
  }
}

/**
 * A command's program when it is a bare name found on PATH, else undefined.
 * A path is not shown, even in part.
 */
export function programName(command: string): string | undefined {
  const first = /^\s*(\S{1,41})/.exec(command)?.[1] ?? "";
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

/** A URL's host when it parses to a printable one, else undefined. */
function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return /^[A-Za-z0-9.:[\]-]{1,253}$/.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

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
    trimmed.length <= 64 &&
    (/^\*+$/.test(trimmed) ||
      /^mcp__\*+$/.test(trimmed) ||
      BROAD_TOOL.test(trimmed))
  );
};
// Environment variables that redirect where the agent or its tools connect,
// or which certificates they trust.
const ENDPOINT_ENV =
  /^(?:[A-Z0-9_]{0,64}_(?:BASE_URL|API_BASE|API_URL|ENDPOINT)|(?:HTTPS?|ALL|FTP)_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i;
export const isEndpointOverride = (name: string) =>
  name.length <= 100 && ENDPOINT_ENV.test(name);

function parsed(
  file: string,
  lines: Lines,
  result: AgentConfigResult,
): { value: Record<string, unknown>; at: JsonLines } | undefined {
  const text = lines.join("\n");
  let scanned: ReturnType<typeof scanJsonc>;
  try {
    scanned = scanJsonc(text);
  } catch {
    // The parser's message can quote file content, so it is not kept.
    result.unscanned.push({
      path: file,
      reason:
        "agent-config: not valid JSON, so its hooks and servers were not checked",
    });
    return undefined;
  }
  return {
    value: isObject(scanned.value) ? scanned.value : {},
    at: new JsonLines(text, scanned.strings),
  };
}

const HOOK_ANCHOR: Record<string, string> = {
  command: "command",
  http: "url",
  prompt: "prompt",
  agent: "prompt",
};

function hookAction(hook: Record<string, unknown>): string | undefined {
  switch (hook.type) {
    case "command":
      return typeof hook.command === "string"
        ? `runs ${describeCommand(hook.command)} on the developer's machine`
        : undefined;
    case "http": {
      const host = typeof hook.url === "string" ? hostOf(hook.url) : undefined;
      return host
        ? `sends hook data to ${host}`
        : "sends hook data to a URL (not shown)";
    }
    case "prompt":
      return "asks a model to decide with a prompt (not shown)";
    case "agent":
      return "runs an agent with a prompt (not shown)";
    default:
      return undefined;
  }
}

const keysOf = (value: unknown) =>
  isObject(value) ? Object.keys(value).sort() : [];

function settingsFindings(
  file: string,
  lines: Lines,
  result: AgentConfigResult,
) {
  const config = parsed(file, lines, result);
  if (!config) return;
  const { value: settings, at } = config;
  const out = result.findings;
  // Hooks, in file order; the line cursor walks forward so repeated
  // commands land on their own lines.
  let cursor = Math.max(0, at.key("hooks") - 1);
  if (isObject(settings.hooks))
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) continue;
        for (const hook of group.hooks) {
          if (!isObject(hook)) continue;
          const action = hookAction(hook);
          if (!action) continue;
          const anchor = HOOK_ANCHOR[hook.type as string]!;
          const value = hook[anchor];
          const line =
            typeof value === "string"
              ? at.key(anchor, value, cursor)
              : at.key("type", hook.type as string, cursor);
          cursor = line;
          out.push(
            finding(
              "hook-command",
              file,
              line,
              `A ${label(event)} hook ${action}`,
              `hooks.${label(event)}`,
              // The matcher and any URL can sit lines away from the anchor.
              hash({
                event,
                matcher: group.matcher ?? null,
                type: hook.type,
                command: hook.command ?? null,
                url: hook.url ?? null,
                prompt: hook.prompt ?? null,
                headers: keysOf(hook.headers),
              }),
            ),
          );
        }
      }
    }
  if (
    isObject(settings.statusLine) &&
    typeof settings.statusLine.command === "string"
  ) {
    const from = at.key("statusLine") - 1;
    out.push(
      finding(
        "hook-command",
        file,
        at.key("command", settings.statusLine.command, from),
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
          at.key(key, settings[key]),
          `${key} runs ${describeCommand(settings[key])}`,
          key,
        ),
      );
  const permissions = isObject(settings.permissions)
    ? settings.permissions
    : {};
  const broad = (where: string, list: unknown, keyLine: number) => {
    if (!Array.isArray(list)) return;
    const from = keyLine - 1;
    for (const entry of list)
      if (typeof entry === "string" && isBroadPermission(entry))
        out.push(
          finding(
            "permission-widening",
            file,
            at.string(entry, from) || keyLine,
            `${where} grants ${JSON.stringify(entry.trim())} without asking`,
            where,
          ),
        );
  };
  broad("permissions.allow", permissions.allow, at.key("allow"));
  // The legacy top-level list.
  broad("allowedTools", settings.allowedTools, at.key("allowedTools"));
  if (permissions.defaultMode === "bypassPermissions")
    out.push(
      finding(
        "permission-widening",
        file,
        at.key("defaultMode", "bypassPermissions"),
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
          at.key("dangerouslySkipPermissions"),
          `${where} is true, so the agent never asks`,
          where,
        ),
      );
  // Project MCP servers the agent starts without asking.
  if (settings.enableAllProjectMcpServers === true)
    out.push(
      finding(
        "permission-widening",
        file,
        at.key("enableAllProjectMcpServers"),
        "enableAllProjectMcpServers is true, so every MCP server the repository declares starts without asking",
        "enableAllProjectMcpServers",
      ),
    );
  if (Array.isArray(settings.enabledMcpjsonServers)) {
    const keyLine = at.key("enabledMcpjsonServers");
    for (const name of settings.enabledMcpjsonServers)
      if (typeof name === "string")
        out.push(
          finding(
            "permission-widening",
            file,
            at.string(name, keyLine - 1) || keyLine,
            `enabledMcpjsonServers approves MCP server ${label(name)} without asking`,
            `enabledMcpjsonServers.${label(name)}`,
          ),
        );
  }
  if (isObject(settings.env)) {
    const from = at.key("env") - 1;
    for (const name of Object.keys(settings.env))
      if (isEndpointOverride(name))
        out.push(
          finding(
            "endpoint-override",
            file,
            at.key(name, undefined, from),
            `env sets ${name}, which redirects where the agent or its tools connect (the value is not shown)`,
            `env.${name}`,
          ),
        );
  }
}

/** Where an MCP server runs: a program by name or a URL by host. */
function serverTarget(server: Record<string, unknown>): string {
  const url = [server.url, server.serverUrl, server.httpUrl].find(
    (value): value is string => typeof value === "string",
  );
  if (url) {
    const host = hostOf(url);
    return host
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

/**
 * A hash of what a server runs or reaches: type, command, arguments, URL,
 * working directory and the names (never the values) of its environment
 * variables and headers. Any change to these makes a new finding, however
 * far it sits from the server's name.
 */
function serverIdentity(server: unknown): string {
  if (!isObject(server)) return hash({ declared: typeof server });
  return hash({
    type: server.type ?? null,
    command: server.command ?? null,
    args: server.args ?? null,
    url: server.url ?? server.serverUrl ?? server.httpUrl ?? null,
    cwd: server.cwd ?? null,
    env: keysOf(server.env),
    headers: keysOf(server.headers),
  });
}

function mcpFindings(file: string, lines: Lines, result: AgentConfigResult) {
  if (/\.toml$/i.test(file)) {
    for (const found of codexServers(file, lines)) result.findings.push(found);
    return;
  }
  const config = parsed(file, lines, result);
  if (!config) return;
  const { value, at } = config;
  // mcpServers (Claude Code, Cursor, Gemini), servers (VS Code mcp.json) and
  // mcp.servers (VS Code settings.json, nested or as a dotted key).
  const containers: [string, unknown, number][] = [
    ["mcpServers", value.mcpServers, at.key("mcpServers")],
    ["servers", value.servers, at.key("servers")],
    [
      "mcp.servers",
      isObject(value.mcp) ? value.mcp.servers : undefined,
      at.key("servers", undefined, at.key("mcp") - 1),
    ],
    ["mcp.servers", value["mcp.servers"], at.key("mcp.servers")],
  ];
  for (const [where, servers, keyLine] of containers) {
    if (!isObject(servers)) continue;
    for (const [name, server] of Object.entries(servers))
      result.findings.push(
        finding(
          "mcp-server",
          file,
          at.key(name, undefined, keyLine - 1),
          `MCP server ${label(name)} ${isObject(server) ? serverTarget(server) : "is declared"}`,
          `${where}.${label(name)}`,
          serverIdentity(server),
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
const ENV_TABLE = new RegExp(
  String.raw`^\s*\[\s*mcp_servers\s*\.\s*${TOML_KEY}\s*\.\s*env\s*\]\s*(#.*)?$`,
);
const SERVERS_TABLE = /^\s*\[\s*mcp_servers\s*\]\s*(#.*)?$/;
const INLINE_SERVER = new RegExp(String.raw`^\s*${TOML_KEY}\s*=\s*\{(.*)$`);
const DOTTED_SERVER = new RegExp(
  String.raw`^\s*mcp_servers\s*\.\s*${TOML_KEY}\s*\.\s*([A-Za-z_]+)\s*=\s*(.*)$`,
);
const TOML_ENV_KEY = new RegExp(String.raw`^\s*${TOML_KEY}\s*=`);
// The first `name =` in one server's collected text; only the first is
// read, so a value that does not parse is not retried further on.
const KEYS = {
  command: /(?:^|[\s,{])command\s*=\s*/,
  url: /(?:^|[\s,{])url\s*=\s*/,
  type: /(?:^|[\s,{])type\s*=\s*/,
  cwd: /(?:^|[\s,{])cwd\s*=\s*/,
  args: /(?:^|[\s,{])args\s*=\s*/,
  env: /(?:^|[\s,{])env\s*=\s*/,
};
const STRING_AT = new RegExp(TOML_STRING, "y");
const valueAt = (name: keyof typeof KEYS, text: string) => {
  const key = KEYS[name].exec(text);
  return key ? key.index + key[0].length : -1;
};
const field = (name: keyof typeof KEYS, text: string) => {
  const at = valueAt(name, text);
  if (at < 0) return undefined;
  STRING_AT.lastIndex = at;
  const match = STRING_AT.exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
};
/** The bracketed value of `name` (an array or inline table), as written. */
const bracketed = (name: keyof typeof KEYS, text: string, open: string) => {
  const at = valueAt(name, text);
  if (at < 0 || text[at] !== open) return undefined;
  const end = text.indexOf(open === "[" ? "]" : "}", at);
  return end < 0 ? text.slice(at) : text.slice(at, end + 1);
};

/**
 * A TOML line without its comment: the first "#" outside a basic or literal
 * string starts one. Linear in the line's length.
 */
export function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

/**
 * MCP servers in a Codex config.toml, read line by line without a TOML
 * parser: the common table, inline-table and dotted-key forms.
 */
export function codexServers(file: string, lines: Lines): Finding[] {
  const servers = new Map<
    string,
    { line: number; text: string[]; env: string[] }
  >();
  let section: "top" | "server" | "servers" | "env" | "other" = "top";
  let current: string | undefined;
  const add = (name: string, line: number, text: string) => {
    const known = servers.get(name);
    if (known) known.text.push(text);
    else servers.set(name, { line, text: [text], env: [] });
    return servers.get(name)!;
  };
  lines.forEach((raw, index) => {
    // Comments are dropped first: a commented-out "command = ..." must never
    // stand in for the active one in a server's definition hash.
    const line = stripTomlComment(raw.replace(/^\uFEFF/, ""));
    const table = SERVER_TABLE.exec(line);
    if (table) {
      section = "server";
      current = table[1] ?? table[2] ?? table[3]!;
      add(current, index + 1, "");
      return;
    }
    const env = ENV_TABLE.exec(line);
    if (env) {
      section = "env";
      current = env[1] ?? env[2] ?? env[3]!;
      if (!servers.has(current)) add(current, index + 1, "");
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
      servers.get(current)!.text.push(line);
      return;
    }
    if (section === "env" && current) {
      const key = TOML_ENV_KEY.exec(line);
      if (key) servers.get(current)!.env.push(key[1] ?? key[2] ?? key[3]!);
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
  return [...servers].map(([name, { line, text: parts, env }]) => {
    const text = parts.join("\n");
    const command = field("command", text);
    const url = field("url", text);
    // Names only: an inline table's values are never hashed.
    for (const part of (bracketed("env", text, "{") ?? "")
      .slice(1)
      .split(",")) {
      const key = TOML_ENV_KEY.exec(part);
      if (key) env.push(key[1] ?? key[2] ?? key[3]!);
    }
    return finding(
      "mcp-server",
      file,
      line,
      `MCP server ${label(name)} ${serverTarget({
        ...(command !== undefined ? { command } : {}),
        ...(url !== undefined ? { url } : {}),
      })}`,
      `mcp_servers.${label(name)}`,
      hash({
        type: field("type", text) ?? null,
        command: command ?? null,
        args: bracketed("args", text, "[") ?? null,
        url: url ?? null,
        cwd: field("cwd", text) ?? null,
        env: [...new Set(env)].sort(),
      }),
    );
  });
}

// Conservative, high-signal phrases only; a match names the pattern, never
// the matched text. Every gap is bounded, so no pattern matches more than
// MAX_MATCH characters and none backtracks over a whole line.
const MAX_MATCH = 512;
const INJECTION: [string, RegExp, string][] = [
  [
    "ignore-instructions",
    /\bignore\s{1,20}(?:all\s{1,20})?(?:the\s{1,20}|any\s{1,20}|your\s{1,20})?(?:previous|prior)\s{1,20}instructions\b/i,
    "tells the agent to ignore its previous instructions",
  ],
  [
    "disregard-system",
    /\bdisregard\s{1,20}(?:all\s{1,20})?(?:the\s{1,20}|your\s{1,20})?(?:system|above)\b/i,
    "tells the agent to disregard its system prompt or earlier text",
  ],
  [
    "pipe-to-shell",
    /\b(?:curl|wget)\b[^\n|]{0,300}\|\s{0,20}(?:sudo\s{1,20})?(?:ba|z|da|k)?sh\b/i,
    "downloads a script and pipes it to a shell",
  ],
  [
    "send-to-url",
    /\bsend\b[^\n]{0,200}?\bto\s{1,20}https?:\/\//i,
    "asks the agent to send something to a URL",
  ],
  [
    // Not the joiner U+200D (emoji sequences) or the LRM/RLM marks
    // (U+200E, U+200F), which ordinary text uses.
    "invisible-unicode",
    /[\u200B\u200C\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u,
    "holds invisible or bidirectional-control Unicode characters",
  ],
];
// Starts only where a run starts, so each run is read once.
const BLOB = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{200,}={0,2}/g;
const isBlob = (text: string) =>
  /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text);
// Long lines are read in overlapping windows, so each pattern runs over a
// few kilobytes at a time and a match up to MAX_MATCH long is still seen.
const WINDOW = 4096;

function windows(line: string): string[] {
  if (line.length <= WINDOW) return [line];
  const out: string[] = [];
  for (let start = 0; ; start += WINDOW - MAX_MATCH) {
    out.push(line.slice(start, start + WINDOW));
    if (start + WINDOW >= line.length) return out;
  }
}

export function injectionFindings(file: string, lines: Lines): Finding[] {
  const out: Finding[] = [];
  lines.forEach((raw, index) => {
    // A byte-order mark opening the file is not hidden text.
    const line = index === 0 ? raw.replace(/^\uFEFF/, "") : raw;
    const parts = windows(line);
    for (const [id, pattern, what] of INJECTION)
      if (parts.some((part) => pattern.test(part)))
        out.push(
          finding(
            "prompt-injection",
            file,
            index + 1,
            `An agent instruction file ${what}`,
            id,
          ),
        );
    if (parts.some((part) => (part.match(BLOB) ?? []).some(isBlob)))
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
