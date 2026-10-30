import path from "node:path";

/**
 * Files the required checks load as configuration: the test runner's own
 * config, the package-manager rc files the test script runs under, and the
 * test entries of a manifest. A worker that can edit them can
 * weaken the checks it is judged by, so a patch to them needs a person's
 * approval. Reading is shallow and offline, like the dependency gate.
 *
 * Maven and Gradle files are gated whole, never parsed: a surefire setting can
 * arrive through a `${skipTests}` property, a profile, `pluginManagement`, an
 * in-repo parent POM, and a Gradle script is a program
 * (`tasks.withType<Test> { ignoreFailures = true }`), so any partial reading
 * is a bypass surface. Deliberately not gated: a coverage rc file named with
 * `--rcfile` or `--cov-config` (the same class as a `setupFiles` target),
 * `turbo.json`, `nx.json` and `lerna.json` task graphs, plugin code under an
 * included build other than `buildSrc/`, `gradle/libs.versions.toml` (a version
 * catalog cannot skip tests), `nps`, Windows `.cmd` shims of `run-s`, and flags
 * such as `-x test` in a Makefile or CI file (an invocation, not a file the
 * checks load; docs/platform.md lists those as out of scope).
 */
const RUNNER_CONFIG =
  /^(vitest|vite|jest|playwright|karma|cypress|ava|babel)\.(config|workspace)\.[cm]?[jt]s(on)?$|^(vitest|jest)\.(setup|global-setup)\.[cm]?[jt]s$|^karma\.conf\.[cm]?[jt]s$|^\.babelrc(\.json)?$|^\.mocharc(\.[a-z]+)?$|^\.nycrc(\.[a-z]+)?$|^\.c8rc(\.[a-z]+)?$|^\.coveragerc$|^jest-preset\.(cjs|mjs|js|json)$|^pnpm-workspace\.ya?ml$|^(pom\.xml|mvnw(\.cmd)?|gradlew(\.bat)?|gradle\.properties)$|\.gradle(\.kts)?$|^\.npmrc$|^\.yarnrc(\.yml)?$|^\.pnpmfile\.cjs$|^(\.?pytest\.(ini|toml)|tox\.ini|conftest\.py|noxfile\.py|phpunit\.xml(\.dist)?)$/;
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

const NPM_RUN_ALL = new Set(["run-s", "run-p", "npm-run-all"]);
const NPM_RUN_ALL_VALUE_OPTIONS = new Set(["--max-parallel", "--npm-path"]);
const NPM_RUN_ALL_BOOLEAN_OPTIONS = new Set([
  "-s",
  "--sequential",
  "--serial",
  "-p",
  "--parallel",
  "-c",
  "--continue-on-error",
  "-l",
  "--print-label",
  "-n",
  "--print-name",
  "-r",
  "--race",
  "--aggregate-output",
  "--silent",
]);
const firstWord = (text: string) => text.trim().split(/\s+/)[0] ?? "";

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
  // A backtick is a command substitution the tokenizer cannot read.
  if (command.includes("`")) unresolved = true;
  for (const segment of tokenize(command)) {
    for (const word of segment) {
      if (!word.quoted || !/\s/.test(word.text)) continue;
      const inner = runnerTargets(word.text);
      targets.push(...inner.targets);
      if (inner.unresolved) unresolved = true;
    }
    const words = segment.map((word) => word.text);
    // A backslash or variable anywhere in a segment can spell a runner or
    // subcommand this reader cannot see: the invocation is unresolved. This
    // over-gates `FOO=$BAR npm run unit` on purpose.
    if (words.some((w) => /[\\$]/.test(w))) unresolved = true;
    // `concurrently npm:a yarn:b` runs scripts by prefix, in any word.
    // Concurrently's own options are not modelled; a word such as `npm:x`
    // elsewhere over-includes, which is safe.
    for (const word of words) {
      const prefixed = /^(?:npm|yarn|pnpm|bun):(.+)$/.exec(word);
      if (prefixed) targets.push(firstWord(prefixed[1]!));
    }
    for (let at = 0; at < words.length; at++) {
      const runner = path.posix.basename(words[at]!);
      if (NPM_RUN_ALL.has(runner)) {
        // Every positional is a script (or a pattern); a quoted one may carry
        // arguments after its first word. `--` and an option not listed could
        // take a value, so the invocation cannot be resolved.
        for (let k = at + 1; k < segment.length; k++) {
          const word = segment[k]!.text;
          if (word === "--") {
            unresolved = true;
            break;
          }
          if (!word.startsWith("-")) {
            targets.push(firstWord(word));
            continue;
          }
          if (word.includes("=")) continue;
          if (NPM_RUN_ALL_VALUE_OPTIONS.has(word)) k++;
          else if (!NPM_RUN_ALL_BOOLEAN_OPTIONS.has(word)) {
            const next = words[k + 1];
            if (next !== undefined && !next.startsWith("-")) {
              unresolved = true;
              break;
            }
          }
        }
        continue;
      }
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
          // A glob, a variable, a substitution or a pnpm regex names scripts
          // this reader does not expand: every script counts. That includes
          // the minimatch forms npm-run-all expands: character classes
          // `[u]nit` and extglobs `+(a)`, `@(a)`, `!(a)` (quoted, as bare
          // parentheses are separators).
          if (/[*?{}[\]()!+@$`\\]/.test(target) || target.startsWith("/"))
            everything = true;
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
// Bytes configparser (coverage.py) and iniconfig (pytest) lex differently:
// VT, FF, \x1c-\x1e, NEL, LS and PS end a line for iniconfig only; \x1f and
// NEL are Python whitespace but not JS \s; BOM is JS \s but not Python
// whitespace; NUL collides with the section-end marker; a bare CR is
// translated by both readers. Input holding any of them counts as changed.
const ODD_INI_BYTES = /[\0\v\f\x1c-\x1f\x85\u2028\u2029\ufeff]|\r(?!\n)/;
// Lines of the pytest, coverage and DEFAULT sections of an ini file
// (setup.cfg). DEFAULT values reach every section.
function pytestIniSections(text: string): string {
  const kept: string[] = [];
  let inside = false;
  // Indent of the last option line of the current section. configparser
  // reads a more-indented line after an option as a continuation of its
  // value, even when it looks like a header.
  let optionIndent: number | undefined;
  // Input with bytes the two Python readers lex differently never gets here
  // (see ODD_INI_BYTES), so on what remains JS whitespace equals Python's and
  // LF or CRLF are the only line breaks both readers share.
  const WS = /^\s+/;
  for (const raw of text.split(/\r?\n/)) {
    const indent = raw.length - raw.replace(WS, "").length;
    // configparser drops blank and comment lines before its indent logic.
    if (raw.trim() === "" || /^\s*[#;]/.test(raw)) {
      if (inside) kept.push(raw.trimEnd());
      continue;
    }
    const continuation = optionIndent !== undefined && indent > optionIndent;
    if (!continuation) {
      // configparser reads any line led by "[" up to the last "]" as a
      // header, even with text after it, so the gate does too.
      const header = /^\s*\[(.+)\]/
        .exec(raw)?.[1]
        ?.replace(/^\[+|\]+$/g, "")
        .trim();
      // iniconfig (which pytest uses) cuts the line at the first "#" or ";"
      // first, so "[tool:pytest] ; x]" is the section "tool:pytest" and
      // "[metadata#]" is no header at all.
      const cut = raw.startsWith("[")
        ? raw.split(/[#;]/)[0].trimEnd()
        : undefined;
      const iniName = cut?.endsWith("]") ? cut.slice(1, -1) : undefined;
      if (header !== undefined || iniName !== undefined) {
        const isWatched = (name: string | undefined) =>
          name !== undefined &&
          /^(tool[.:])?pytest(\.|$)|^coverage:|^DEFAULT$/.test(name);
        const now = isWatched(header) || isWatched(iniName);
        // A line only one reading takes for a header neither ends nor starts
        // an unwatched section. Mark where a section ends, so removing the
        // header that ends it (which folds what follows into its last value)
        // shows up.
        if (inside && !now) {
          if (header !== undefined && iniName !== undefined)
            kept.push("\u0000end");
          else {
            kept.push(raw.trimEnd());
            continue;
          }
        }
        inside = now;
        optionIndent = undefined;
      } else optionIndent = indent;
    }
    // Leading whitespace is kept: an indented line is a continuation of the
    // key above, so indenting a key removes it from the section.
    if (inside) kept.push(raw.trimEnd());
  }
  return kept.join("\n");
}

// A key is a string; an array index is a number, so no quoted key spells one.
type Path = (string | number)[];

// The pytest and coverage settings of a pyproject.toml as sorted `path = value` lines, with
// header and key spelling normalised: quotes and spaces around dots, dotted
// keys, tables and inline tables all give the same path. Returns undefined
// when the text is not read with confidence, so the caller fails closed.
function pytestToml(text: string): string | undefined {
  const src = text.replace(new RegExp("^\\uFEFF"), "");
  const tables = new Set<string>();
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
  // Every table on the way to a pytest or coverage setting is recorded as
  // `{}`, whether it was written as a header, a dotted key or an inline table,
  // so the spellings read the same. Without a value `path` is itself a table.
  // The whole tool.coverage table counts: omit, source and exclude_lines
  // weaken coverage as much as fail_under does. A dependency named coverage is
  // not under tool.*, so it is not matched.
  const watched = (path: Path) =>
    path[0] === "tool" && (path[1] === "pytest" || path[1] === "coverage");
  const keep = (path: Path, value?: string) => {
    if (!watched(path)) return;
    const depth = value === undefined ? path.length : path.length - 1;
    for (let n = 2; n <= depth; n++)
      tables.add(`${JSON.stringify(path.slice(0, n))} = {}`);
    if (value !== undefined) out.push(`${JSON.stringify(path)} = ${value}`);
  };
  const value = (path: Path) => {
    blank();
    const c = src[i];
    if (c === '"' || c === "'") keep(path, str());
    else if (c === "[") {
      i++;
      let n = 0;
      for (; ; n++) {
        skipAll();
        if (src[i] === "]") break;
        value([...path, n]);
        skipAll();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") fail();
      }
      // An empty array has no element line, so mark it itself.
      if (n === 0) keep(path, "[]");
      i++;
    } else if (c === "{") {
      i++;
      keep(path);
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
      let len = m[0].length;
      // TOML 1.0 allows a space between the date and the time of a date-time.
      // Non-ASCII bare keys stay unread on purpose: they are invalid TOML 1.0
      // (tomllib rejects them too), so failing closed matches the parser.
      if (
        /^\d{4}-\d\d-\d\d$/.test(m[0]) &&
        /^ \d\d:/.test(src.slice(i + len, i + len + 4))
      ) {
        const time = /^ \d\d:[^\s,\]}#]*/.exec(src.slice(i + len));
        if (time) len += time[0].length;
      }
      keep(path, src.slice(i, i + len));
      i += len;
    }
  };
  try {
    let table: Path = [];
    const entries = new Map<string, number>();
    for (;;) {
      skipAll();
      if (i >= src.length) break;
      if (src[i] === "[") {
        const array = src[i + 1] === "[";
        i += array ? 2 : 1;
        const written = key();
        // An entry of an array of tables is indexed, and a header below an
        // array path belongs to its latest entry, the way tomllib reads it.
        table = [];
        written.forEach((part, at) => {
          table.push(part);
          const id = JSON.stringify(table);
          const last = at === written.length - 1;
          if (last && array) {
            const n = entries.get(id) ?? 0;
            entries.set(id, n + 1);
            table.push(n);
          } else if (entries.has(id)) table.push(entries.get(id)! - 1);
        });
        keep(table);
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
  return [...tables, ...out].sort().join("\n");
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
  // Maven and Gradle wrapper and tool settings live in directories, not only
  // in files with a distinctive name, at any depth. Names are lowercased: a
  // differently cased directory lands in the real one on a case-insensitive
  // checkout.
  const segments = file.toLowerCase().split("/");
  if (
    segments.includes(".mvn") ||
    segments.includes("buildsrc") ||
    segments.some(
      (s, i) =>
        s === "gradle" &&
        segments[i + 1] === "wrapper" &&
        i + 1 < segments.length - 1,
    )
  )
    return true;
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
    return (
      ODD_INI_BYTES.test(before) ||
      ODD_INI_BYTES.test(after) ||
      pytestIniSections(before) !== pytestIniSections(after)
    );
  if (base === "pyproject.toml") {
    const was = pytestToml(before);
    const now = pytestToml(after);
    // Text that cannot be read with confidence counts as a change.
    return was === undefined || now === undefined || was !== now;
  }
  return false;
}

/** Exported for property tests, not part of the engine API. */
export const internals = {
  tokenize,
  runnerTargets,
  pytestIniSections,
  pytestToml,
  BOOLEAN_OPTIONS,
  VALUE_OPTIONS,
};
