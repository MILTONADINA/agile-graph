import path from "node:path";

/**
 * Files the required checks load as configuration: the test runner's own
 * config and the test entries of a manifest. A worker that can edit them can
 * weaken the checks it is judged by, so a patch to them needs a person's
 * approval. Reading is shallow and offline, like the dependency gate.
 */
const RUNNER_CONFIG =
  /^(vitest|vite|jest|playwright|karma|cypress|ava|babel)\.(config|workspace)\.[cm]?[jt]s(on)?$|^(vitest|jest)\.(setup|global-setup)\.[cm]?[jt]s$|^\.mocharc(\.[a-z]+)?$|^\.nycrc(\.[a-z]+)?$|^(\.?pytest\.(ini|toml)|tox\.ini|conftest\.py|noxfile\.py|phpunit\.xml(\.dist)?)$/;
const TEST_SCRIPT = /^(pre|post)?(test|check|verify)(:.*)?$/;
const NPM_RUNNER_KEYS = ["jest", "vitest", "mocha", "ava", "nyc", "c8"];

const NPM_RUN =
  /\b(?:npm\s+(?:run|run-script)|pnpm\s+run|yarn\s+run|yarn|pnpm)\s+([\w:.-]+)|\bnpm\s+(?:test|t)\b/g;

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
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
          if (!names.has(target)) {
            names.add(target);
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
// Lines of the pytest sections of an ini or TOML file.
function pytestSections(text: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const header = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:#.*)?$/.exec(raw)?.[1];
    if (header !== undefined) inside = /^(tool[.:])?pytest(\.|$)/.test(header);
    // A dotted key (tool.pytest.ini_options.addopts = ...) sets the same
    // option outside a pytest section.
    if (inside || /^\s*["']?[\w."'-]*pytest[\w."'-]*\s*=/.test(raw))
      kept.push(raw.trim());
  }
  return kept.join("\n");
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
    if (!now) return false;
    const names = gatedNames([scriptsOf(was), scriptsOf(now)]);
    return (
      JSON.stringify(was ? npmEntries(was, names) : []) !==
      JSON.stringify(npmEntries(now, names))
    );
  }
  if (base === "pyproject.toml" || base === "setup.cfg")
    return pytestSections(before) !== pytestSections(after);
  return false;
}
