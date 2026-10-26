import path from "node:path";

/**
 * Dependency names declared by a manifest, read without the network. A name
 * a patch adds that the manifest did not declare before is what a
 * hallucinated or typosquatted package looks like, so a person has to
 * approve it. Parsing is deliberately shallow: it reads the names the
 * ecosystem's manifest declares, not versions, sources or lockfiles.
 */
const REQUIREMENT_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;
const npmSections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Whether a path is a manifest this gate reads. */
export function isDependencyManifest(file: string): boolean {
  const base = path.posix.basename(file).toLowerCase();
  return (
    base === "package.json" ||
    base === "pyproject.toml" ||
    base === "cargo.toml" ||
    base === "go.mod" ||
    base === "pubspec.yaml" ||
    /^requirements.*\.txt$/.test(base)
  );
}

// PEP 503 normalisation, so Foo_Bar and foo-bar are one name.
function pythonName(requirement: string): string | undefined {
  const match = REQUIREMENT_NAME.exec(requirement.trim());
  return match?.[1]?.toLowerCase().replace(/[-_.]+/g, "-");
}
function npmNames(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const names: string[] = [];
  for (const section of npmSections) {
    const value = (parsed as Record<string, unknown>)[section];
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [name, spec] of Object.entries(value)) {
        names.push(name);
        // "alias": "npm:real-package@1" installs real-package.
        const real =
          typeof spec === "string" && /^npm:(@?[^@]+)/.exec(spec)?.[1];
        if (real) names.push(real);
      }
  }
  return names;
}
function requirementsNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    // Options (-r, -e, --index-url) and bare URLs or paths name no package.
    if (!line || line.startsWith("-") || /^[A-Za-z][\w+.-]*:\/\//.test(line))
      continue;
    const name = pythonName(line);
    if (name) names.push(name);
  }
  return names;
}
function quoted(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}
function tomlSection(line: string): string | undefined {
  return /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)?.[1];
}
// Index of the `]` that closes an array, ignoring any inside a string
// (extras such as "pkg[socks]"), or -1.
function arrayEnd(text: string): number {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return -1;
    else if (char === "]") return i;
  }
  return -1;
}
function pyprojectNames(text: string): string[] {
  const names: string[] = [];
  let section = "";
  let inArray = false;
  const arrayKeys = new Set(["dependencies", "requires"]);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!inArray) {
      const header = tomlSection(line);
      if (header !== undefined) {
        section = header;
        continue;
      }
    }
    const poetry =
      /^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/.test(section);
    if (!inArray && poetry) {
      const key = /^("[^"]+"|'[^']+'|[A-Za-z0-9._-]+)\s*[=.]/.exec(line)?.[1];
      const name = key && pythonName(key.replace(/["']/g, ""));
      if (name && name !== "python") names.push(name);
      continue;
    }
    let body = line;
    if (!inArray) {
      const start = /^["']?([A-Za-z0-9_-]+)["']?\s*=\s*\[(.*)$/.exec(line);
      const listed =
        section === "project.optional-dependencies" ||
        section === "dependency-groups";
      if (
        !start ||
        !(
          listed ||
          (arrayKeys.has(start[1]!) &&
            (section === "project" || section === "build-system"))
        )
      )
        continue;
      body = start[2]!;
      inArray = true;
    }
    const end = arrayEnd(body);
    const content = end >= 0 ? body.slice(0, end) : body;
    for (const item of quoted(
      content.replace(/\{[^}]*\}/g, "").replace(/\s#.*$/, ""),
    )) {
      const name = pythonName(item);
      if (name) names.push(name);
    }
    if (end >= 0) inArray = false;
  }
  return names;
}
// Drops a trailing # comment, ignoring a # inside a string.
function withoutComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, i);
  }
  return line;
}
function cargoNames(text: string): string[] {
  const names: string[] = [];
  let kind: "list" | "one" | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw).trim();
    const header = tomlSection(line);
    if (header !== undefined) {
      const table =
        /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+|"[^"]+")$/.exec(
          header,
        );
      if (table) {
        names.push(table[1]!.replace(/"/g, ""));
        kind = "one";
      } else
        kind = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(header)
          ? "list"
          : undefined;
      continue;
    }
    if (kind === "one") {
      const real = /^package\s*=\s*"([^"]+)"/.exec(line)?.[1];
      if (real) names.push(real);
      continue;
    }
    if (kind !== "list") continue;
    const key = /^("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*[=.]/.exec(line)?.[1];
    if (key) names.push(key.replace(/["']/g, ""));
    const real = /\bpackage\s*=\s*"([^"]+)"/.exec(line)?.[1];
    if (real) names.push(real);
  }
  return names;
}
function goNames(text: string): string[] {
  const names: string[] = [];
  let block: "require" | "replace" | undefined;
  const take = (kind: string, rest: string) => {
    if (kind === "require") names.push(rest.split(/\s+/)[0]!);
    else {
      // `old [v] => new [v]`: a replacement fetches the new module unless
      // it is a local path.
      const target = rest.split("=>")[1]?.trim().split(/\s+/)[0];
      if (target && !/^(?:\.{0,2}\/|[A-Za-z]:)/.test(target))
        names.push(target);
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (block) {
      if (line === ")") block = undefined;
      else if (line) take(block, line);
      continue;
    }
    const open = /^(require|replace)\s*\($/.exec(line)?.[1];
    if (open) block = open as "require" | "replace";
    else {
      const single = /^(require|replace)\s+(\S.*)$/.exec(line);
      if (single) take(single[1]!, single[2]!);
    }
  }
  return names;
}
// Keys at the top level of a one-line YAML flow mapping: {a: 1, "b": {c: 2}}.
function flowKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote = "";
  let token = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") {
      depth++;
      token = "";
    } else if (char === "}" || char === "]") {
      depth--;
      token = "";
    } else if (char === ",") token = "";
    else if (char === ":" && depth === 1 && token.trim()) {
      keys.push(token.trim());
      token = "";
    } else token += char;
  }
  return keys;
}
function pubspecNames(text: string): string[] {
  const names: string[] = [];
  let active = false;
  let indent = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    if (!line.trim()) continue;
    const depth = line.length - line.trimStart().length;
    if (depth === 0) {
      const head =
        /^["']?(?:dependencies|dev_dependencies|dependency_overrides)["']?\s*:(.*)$/.exec(
          line,
        );
      active = head !== null;
      indent = -1;
      if (head?.[1]?.trim().startsWith("{"))
        names.push(...flowKeys(head[1].trim()));
      continue;
    }
    if (!active) continue;
    if (indent < 0) indent = depth;
    if (depth !== indent) continue;
    const name = /^\s*("[^"]+"|'[^']+'|[A-Za-z0-9_]+)\s*:/.exec(line)?.[1];
    if (name) names.push(name.replace(/["']/g, ""));
  }
  return names;
}

/** The dependency names a manifest declares; empty for any other file. */
export function dependencyNames(file: string, text: string): Set<string> {
  const base = path.posix.basename(file).toLowerCase();
  let names: string[] = [];
  if (base === "package.json") names = npmNames(text);
  else if (/^requirements.*\.txt$/.test(base)) names = requirementsNames(text);
  else if (base === "pyproject.toml") names = pyprojectNames(text);
  else if (base === "cargo.toml") names = cargoNames(text);
  else if (base === "go.mod") names = goNames(text);
  else if (base === "pubspec.yaml") names = pubspecNames(text);
  return new Set(names);
}

/** Names `after` declares that `before` did not, sorted. */
export function newDependencies(
  file: string,
  before: string,
  after: string,
): string[] {
  if (!isDependencyManifest(file)) return [];
  const existing = dependencyNames(file, before);
  return [...dependencyNames(file, after)]
    .filter((name) => !existing.has(name))
    .sort();
}
