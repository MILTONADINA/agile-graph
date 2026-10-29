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

function npmEntries(text: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const entries: string[] = [];
  const scripts = record.scripts;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts))
    for (const [name, command] of Object.entries(scripts))
      if (TEST_SCRIPT.test(name))
        entries.push(`script ${name}=${JSON.stringify(command)}`);
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
    const was = npmEntries(before);
    const now = npmEntries(after);
    if (!now) return false;
    return JSON.stringify(was ?? []) !== JSON.stringify(now);
  }
  if (base === "pyproject.toml" || base === "setup.cfg")
    return pytestSections(before) !== pytestSections(after);
  return false;
}
