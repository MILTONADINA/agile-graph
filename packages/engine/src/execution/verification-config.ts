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

const FLAGS = String.raw`(?:\s+-{1,2}[\w-]+(?:=\S*)?)*`;
const NPM_RUN = new RegExp(
  String.raw`\b(?:npm${FLAGS}\s+(?:run|run-script)|pnpm${FLAGS}\s+run|yarn\s+run|yarn|pnpm)${FLAGS}\s+([\w:.-]+)|\bnpm\s+(?:test|t)\b`,
  "g",
);

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
// followed to a fixpoint over all the given manifests.
function gatedNames(all: Record<string, unknown>[]): Set<string> {
  const names = new Set<string>();
  for (const scripts of all)
    for (const name of Object.keys(scripts))
      if (TEST_SCRIPT.test(name)) names.add(name);
  for (let grew = true; grew;) {
    grew = false;
    for (const scripts of all)
      for (const name of [...names]) {
        const command = scripts[name];
        if (typeof command !== "string") continue;
        for (const match of command.matchAll(NPM_RUN)) {
          const target = match[1] ?? "test";
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
  return names;
}
function npmEntries(
  record: Record<string, unknown>,
  names: Set<string>,
): string[] {
  const scripts = scriptsOf(record);
  const entries: string[] = [];
  for (const name of names)
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

/** Whether going from `before` to `after` changes what the checks load. */
export function changedVerificationConfig(
  file: string,
  before: string,
  after: string,
): boolean {
  if (before === after) return false;
  const base = path.posix.basename(file).toLowerCase();
  if (RUNNER_CONFIG.test(base)) return true;
  if (base === "package.json") {
    const was = parse(before);
    const now = parse(after);
    // A manifest npm cannot read now but could before is not a safe edit.
    if (!now) return was !== undefined;
    const names = gatedNames([scriptsOf(was), scriptsOf(now)]);
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
