import path from "node:path";

/**
 * Files the required checks load as configuration: the test runner's own
 * config, the package-manager rc files the test script runs under, and the
 * test entries of a manifest. A worker that can edit them can
 * weaken the checks it is judged by, so a patch to them needs a person's
 * approval. Reading is shallow and offline, like the dependency gate.
 */
const RUNNER_CONFIG =
  /^(vitest|vite|jest|playwright|karma|cypress|ava|babel)\.(config|workspace)\.[cm]?[jt]s(on)?$|^(vitest|jest)\.(setup|global-setup)\.[cm]?[jt]s$|^karma\.conf\.[cm]?[jt]s$|^\.babelrc(\.json)?$|^\.mocharc(\.[a-z]+)?$|^\.nycrc(\.[a-z]+)?$|^\.npmrc$|^\.yarnrc(\.yml)?$|^\.pnpmfile\.cjs$|^(\.?pytest\.(ini|toml)|tox\.ini|conftest\.py|noxfile\.py|phpunit\.xml(\.dist)?)$/;
const TEST_SCRIPT = /^(pre|post)?(test|check|verify)(:.*)?$/;
const NPM_RUNNER_KEYS = ["jest", "vitest", "mocha", "ava", "nyc", "c8"];

const RUNNERS = new Set(["npm", "pnpm", "yarn"]);
// Options that take the next word as their value, and options that do not,
// per runner: `-w` is npm's `--workspace` (a value) but pnpm's boolean
// `--workspace-root`. An option in neither list, spelled without `=`,
// followed by a word, could be either, so the invocation cannot be resolved
// and fails closed.
const COMMON_VALUE_OPTIONS = [
  "--script-shell",
  "--prefix",
  "-C",
  "--loglevel",
  "--userconfig",
  "--globalconfig",
  "--cache",
  "--registry",
  "--shell",
  "--config",
  "--use-yarnrc",
];
const VALUE_OPTIONS: Record<string, Set<string>> = {
  npm: new Set([...COMMON_VALUE_OPTIONS, "--workspace", "-w"]),
  pnpm: new Set([...COMMON_VALUE_OPTIONS, "--filter", "-F", "--dir"]),
  yarn: new Set([...COMMON_VALUE_OPTIONS, "--cwd"]),
};
const BOOLEAN_OPTIONS = new Set([
  "-s",
  "--silent",
  "-q",
  "--quiet",
  "-r",
  "--recursive",
  "-ws",
  "--workspaces",
  "--include-workspace-root",
  "--if-present",
  "--no-bail",
  "--parallel",
  "--stream",
  "--offline",
  "--verbose",
  "-v",
  "-d",
  "--production",
  "--ignore-scripts",
  "--no-color",
  "--color",
  "--fail-if-no-match",
  "--no-sort",
  "-p",
  "-t",
  "--topological",
  "--if-present",
]);
const PNPM_BOOLEAN_OPTIONS = new Set(["-w", "--workspace-root"]);
const OTHER_COMMANDS =
  /^(exec|dlx|install|i|add|remove|rm|update|up|ci|init|publish|pack|link|audit|cache|config|set|get|why|ls|list|info|view|version|dedupe|prune|rebuild|outdated|create|x|node|dev|help)$/;

// Splits a command line into segments of words, quote-aware: separators
// inside quotes do not split, and a quoted word keeps its inner text.
function tokenize(command: string): { text: string; quoted: boolean }[][] {
  const segments: { text: string; quoted: boolean }[][] = [[]];
  let text = "";
  let quoted = false;
  let open = false;
  let quote = "";
  const endWord = () => {
    if (open) segments[segments.length - 1]!.push({ text, quoted });
    text = "";
    quoted = false;
    open = false;
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = "";
      else text += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      open = true;
    } else if (/[&|;\n()`]/.test(ch)) {
      endWord();
      if (segments[segments.length - 1]!.length) segments.push([]);
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      text += ch;
      open = true;
    }
  }
  endWord();
  return segments;
}

// Script names a command line runs through npm, pnpm, yarn or `node --run`.
// `unresolved` is set when an invocation's script cannot be read with
// confidence. A quoted word with spaces is read as a command line itself, so
// `concurrently "npm run a"` and `sh -c 'npm run a'` are seen.
function runnerTargets(command: string): {
  targets: string[];
  unresolved: boolean;
} {
  const targets: string[] = [];
  let unresolved = false;
  for (const segment of tokenize(command)) {
    for (const word of segment) {
      if (!word.quoted || !/\s/.test(word.text)) continue;
      const inner = runnerTargets(word.text);
      targets.push(...inner.targets);
      if (inner.unresolved) unresolved = true;
    }
    const words = segment.map((word) => word.text);
    for (let at = 0; at < words.length; at++) {
      const runner = path.posix.basename(words[at]!);
      if (runner === "node") {
        for (let k = at + 1; k < words.length; k++) {
          const word = words[k]!;
          if (!word.startsWith("-")) break;
          if (word === "--run") {
            if (words[k + 1] === undefined) unresolved = true;
            else targets.push(words[k + 1]!);
          } else if (word.startsWith("--run=")) {
            targets.push(word.slice("--run=".length));
          }
        }
        continue;
      }
      if (!RUNNERS.has(runner)) continue;
      const values = VALUE_OPTIONS[runner]!;
      const positional: string[] = [];
      let ambiguous = false;
      for (let k = at + 1; k < words.length; k++) {
        const word = words[k]!;
        if (word === "--") break;
        if (!word.startsWith("-")) {
          positional.push(word);
          // Once the script is read, what follows are its own arguments.
          const [first] = positional;
          const needed = ["run", "run-script", "rum", "urn"].includes(first!)
            ? 2
            : runner === "yarn" && first === "workspace"
              ? positional[2] === "run"
                ? 4
                : 3
              : 1;
          if (positional.length >= needed) break;
          continue;
        }
        if (word.includes("=")) continue;
        if (values.has(word)) {
          // The value is not a script name; skip the word after it.
          k++;
        } else if (
          !BOOLEAN_OPTIONS.has(word) &&
          !(runner === "pnpm" && PNPM_BOOLEAN_OPTIONS.has(word))
        ) {
          const next = words[k + 1];
          if (next !== undefined && !next.startsWith("-")) {
            ambiguous = true;
            break;
          }
        }
      }
      if (ambiguous) {
        unresolved = true;
        continue;
      }
      const [first, second] = positional;
      if (first === "workspace" && runner === "yarn") {
        // yarn workspace <name> [run] <script>
        const rest = positional.slice(2);
        const script = rest[0] === "run" ? rest[1] : rest[0];
        if (script === undefined) unresolved = true;
        else targets.push(script);
        continue;
      }
      if (first === undefined) continue;
      if (["run", "run-script", "rum", "urn"].includes(first)) {
        if (second === undefined) unresolved = true;
        else targets.push(second);
      } else if (first === "workspaces" || first === "foreach") {
        unresolved = true;
      } else if (first === "test" || first === "t" || first === "tst") {
        targets.push("test");
      } else if (runner !== "npm" && !OTHER_COMMANDS.test(first)) {
        targets.push(first);
      }
    }
  }
  return { targets, unresolved };
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object")
      return parsed as Record<string, unknown>;
  } catch {
    // Not JSON: nothing to read.
  }
  return undefined;
}
function scriptsOf(record: Record<string, unknown> | undefined) {
  const scripts = record?.scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts)
    ? (scripts as Record<string, unknown>)
    : {};
}
// Test script names plus every script a gated command runs through `npm run`,
// followed to a fixpoint over all the given manifests. `all` is set when a
// gated command runs a script that cannot be resolved: then every script of
// every manifest counts.
function gatedNames(all: Record<string, unknown>[]): {
  names: Set<string>;
  all: boolean;
} {
  const names = new Set<string>();
  let everything = false;
  for (const scripts of all)
    for (const name of Object.keys(scripts))
      if (TEST_SCRIPT.test(name)) names.add(name);
  for (let grew = true; grew;) {
    grew = false;
    for (const scripts of all)
      for (const name of [...names]) {
        const command = scripts[name];
        if (typeof command !== "string") continue;
        const { targets, unresolved } = runnerTargets(command);
        if (unresolved) everything = true;
        for (const target of targets) {
          if (target.startsWith("-")) continue;
          // npm also runs the pre and post hooks of every script it reaches.
          for (const hooked of [target, `pre${target}`, `post${target}`])
            if (!names.has(hooked)) {
              names.add(hooked);
              grew = true;
            }
        }
      }
  }
  return { names, all: everything };
}
function npmEntries(
  record: Record<string, unknown>,
  gated: { names: Set<string>; all: boolean },
): string[] {
  const scripts = scriptsOf(record);
  const entries: string[] = [];
  for (const name of gated.all ? Object.keys(scripts) : gated.names)
    if (name in scripts)
      entries.push(`script ${name}=${JSON.stringify(scripts[name])}`);
  for (const key of NPM_RUNNER_KEYS)
    if (key in record) entries.push(`${key}=${JSON.stringify(record[key])}`);
  return entries.sort();
}
// Lines of the pytest sections of an ini file (setup.cfg).
function pytestIniSections(text: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:[#;].*)?$/.exec(raw)?.[1];
    if (header !== undefined) inside = /^(tool[.:])?pytest(\.|$)/.test(header);
    if (inside) kept.push(raw.trim());
  }
  return kept.join("\n");
}

// The pytest settings of a pyproject.toml as sorted `path = value` lines, with
// header and key spelling normalised: quotes and spaces around dots, dotted
// keys, tables and inline tables all give the same path. Returns undefined
// when the text is not read with confidence, so the caller fails closed.
function pytestToml(text: string): string | undefined {
  const src = text.replace(new RegExp("^\\uFEFF"), "");
  const out: string[] = [];
  let i = 0;
  const fail = (): never => {
    throw new Error("unreadable");
  };
  const blank = () => {
    while (i < src.length && /[ \t\r]/.test(src[i]!)) i++;
  };
  const skipAll = () => {
    for (;;) {
      blank();
      if (src[i] === "#") while (i < src.length && src[i] !== "\n") i++;
      else if (src[i] === "\n") i++;
      else return;
    }
  };
  const str = (): string => {
    const q = src[i]!;
    const triple = src.startsWith(q + q + q, i);
    const open = triple ? 3 : 1;
    let j = i + open;
    for (;;) {
      if (j >= src.length) return fail();
      if (q === '"' && src[j] === "\\") j += 2;
      else if (triple ? src.startsWith(q + q + q, j) : src[j] === q) break;
      else if (!triple && src[j] === "\n") return fail();
      else j++;
    }
    // A closing run of quotes may be longer by up to two quotes.
    let end = j + open;
    if (triple) while (src[end] === q && end - j < 5) end++;
    const raw = src.slice(i, end);
    i = end;
    return raw;
  };
  const unquote = (raw: string): string => {
    const m = /^("""|'''|"|')([\s\S]*)\1$/.exec(raw);
    // A basic string decodes escapes (\u0074 is t), so a key spelled with one
    // cannot be compared as written: fail closed rather than decode.
    if (m && m[1] === '"' && m[2]!.includes("\\")) return fail();
    return m ? m[2]! : raw;
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      blank();
      if (src[i] === '"' || src[i] === "'") parts.push(unquote(str()));
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
        if (!m) return fail();
        parts.push(m[0]);
        i += m[0].length;
      }
      blank();
      if (src[i] !== ".") return parts;
      i++;
    }
  };
  const keep = (path: string[], value: string) => {
    if (path[0] === "tool" && path[1] === "pytest")
      out.push(`${JSON.stringify(path)} = ${value}`);
  };
  const value = (path: string[]) => {
    blank();
    const c = src[i];
    if (c === '"' || c === "'") keep(path, str());
    else if (c === "[") {
      i++;
      for (let n = 0; ; n++) {
        skipAll();
        if (src[i] === "]") break;
        value([...path, `[${n}]`]);
        skipAll();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") fail();
      }
      i++;
    } else if (c === "{") {
      i++;
      keep(path, "{}");
      for (;;) {
        skipAll();
        if (src[i] === "}") break;
        const k = key();
        blank();
        if (src[i] !== "=") fail();
        i++;
        value([...path, ...k]);
        skipAll();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") fail();
      }
      i++;
    } else {
      const m = /^[^\s,\]}#]+/.exec(src.slice(i));
      if (!m) return fail();
      keep(path, m[0]);
      i += m[0].length;
    }
  };
  try {
    let table: string[] = [];
    for (;;) {
      skipAll();
      if (i >= src.length) break;
      if (src[i] === "[") {
        const array = src[i + 1] === "[";
        i += array ? 2 : 1;
        table = key();
        blank();
        if (src.slice(i, i + (array ? 2 : 1)) !== (array ? "]]" : "]")) fail();
        i += array ? 2 : 1;
      } else {
        const k = key();
        blank();
        if (src[i] !== "=") fail();
        i++;
        value([...table, ...k]);
      }
      blank();
      if (src[i] === "#") while (i < src.length && src[i] !== "\n") i++;
      if (i < src.length && src[i] !== "\n") fail();
    }
  } catch {
    return undefined;
  }
  return out.sort().join("\n");
}

/**
 * Whether going from `before` to `after` changes what the checks load.
 * `manifests` holds the text of the other package.json files in the checkout
 * (both their state before the patch and as patched), so a script a root test
 * script reaches in another workspace counts. Without them, any script change
 * in a package.json below the root fails closed.
 */
export function changedVerificationConfig(
  file: string,
  before: string,
  after: string,
  manifests?: string[],
): boolean {
  if (before === after) return false;
  const base = path.posix.basename(file).toLowerCase();
  if (RUNNER_CONFIG.test(base)) return true;
  if (base === "package.json") {
    const was = parse(before);
    const now = parse(after);
    // A manifest npm cannot read now but could before is not a safe edit.
    if (!now) return was !== undefined;
    const names = gatedNames([
      scriptsOf(was),
      scriptsOf(now),
      ...(manifests ?? []).map((text) => scriptsOf(parse(text))),
    ]);
    if (manifests === undefined && path.posix.dirname(file) !== ".") {
      // Whether a root script delegates here is unknown: any script change counts.
      const scriptsWas = JSON.stringify(scriptsOf(was));
      if (scriptsWas !== JSON.stringify(scriptsOf(now))) return true;
    }
    return (
      JSON.stringify(was ? npmEntries(was, names) : []) !==
      JSON.stringify(npmEntries(now, names))
    );
  }
  if (base === "setup.cfg")
    return pytestIniSections(before) !== pytestIniSections(after);
  if (base === "pyproject.toml") {
    const was = pytestToml(before);
    const now = pytestToml(after);
    // Text that cannot be read with confidence counts as a change.
    return was === undefined || now === undefined || was !== now;
  }
  return false;
}
