import path from "node:path";
import type { ContextEngine } from "../context/index.js";
import { containsSecret, globAllowlist } from "../policy.js";
import { hash } from "../util.js";

/** At most this many paths lead the tester's first packet. */
export const TESTER_FOCUS_LIMIT = 8;
// Existing tests named in that focus; the rest are the code they exercise.
const TESTS_LIMIT = 3;

// A file's name without its directory, test markers or extensions, lower
// case: `src/mod.ts`, `tests/mod.test.ts`, `test_mod.py` and `ModTests.cs`
// share `mod`. Empty for a file named only `test.js`.
function stem(file: string): string {
  return path.posix
    .basename(file)
    .replace(/\..*$/, "")
    .replace(/^test_/i, "")
    .replace(/(?:[_-](?:tests?|spec)|(?<=[a-z0-9])(?:Tests?|Spec))$/, "")
    .toLowerCase();
}

/**
 * The paths a tester's first context packet leads with: existing test files
 * near the code the objective and acceptance criteria name, then the source
 * files those tests import. Uses the snapshot's symbol index and import graph
 * only; the returned paths are priority hints that getContext still screens
 * with the project's exclusions, export rules, secret checks and budget.
 *
 * - The named code: repository paths written in the text, and files declaring
 *   a symbol or having a basename the text names.
 * - Its tests: files matching the tester's write globs that import the named
 *   code or share its basename, nearest directory first.
 */
export async function testerFocusPaths(options: {
  engine: ContextEngine;
  files: readonly string[];
  testFiles: readonly string[];
  text: readonly string[];
  snapshotId: string;
  /** Whether a path may appear; a cloud tester gets only exportable ones. */
  allowed: (file: string) => boolean;
}): Promise<string[]> {
  const isTest = globAllowlist(options.testFiles);
  const files = options.files.filter(
    (file) => options.allowed(file) && !containsSecret(file),
  );
  const known = new Set(files);
  const byId = new Map(files.map((file) => [hash(`file:${file}`), file]));
  const text = options.text.join("\n");
  const named = new Set<string>();
  for (const match of text.match(
    /(?<![A-Za-z0-9_./-])(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}/g,
  ) ?? []) {
    const file = match.replace(/^\.\//, "");
    if (known.has(file)) named.add(file);
  }
  const terms = [
    ...new Set((text.match(/[\p{L}_][\p{L}\p{N}_]{3,}/gu) ?? []).slice(0, 48)),
  ];
  const termStems = new Set(terms.map((term) => term.toLowerCase()));
  for (const file of files)
    if (!isTest(file) && termStems.has(stem(file))) named.add(file);
  for (const term of terms.slice(0, 24))
    for (const symbol of await options.engine.searchSymbols(
      term,
      options.snapshotId,
    ))
      if (
        symbol.name === term &&
        symbol.kind !== "file" &&
        known.has(symbol.source.path)
      )
        named.add(symbol.source.path);
  const code = [...named].filter((file) => !isTest(file)).slice(0, 8);
  const tests = new Map<string, number>();
  const consider = (file: string, score: number) => {
    if (known.has(file) && isTest(file))
      tests.set(file, Math.max(tests.get(file) ?? 0, score));
  };
  for (const file of named) consider(file, 4);
  for (const file of code) {
    const fileId = hash(`file:${file}`);
    for (const edge of await options.engine.neighbors(
      fileId,
      options.snapshotId,
    ))
      if (edge.kind === "imports" && edge.to === fileId)
        consider(edge.source.path, 3);
    const dir = path.posix.dirname(file);
    const own = stem(file);
    if (!own) continue;
    for (const candidate of files)
      if (stem(candidate) === own)
        consider(
          candidate,
          path.posix.dirname(candidate).startsWith(dir) ||
            dir.startsWith(path.posix.dirname(candidate))
            ? 2
            : 1,
        );
  }
  const chosen = [...tests]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TESTS_LIMIT)
    .map(([file]) => file);
  const exercised: string[] = [];
  for (const test of chosen) {
    for (const edge of await options.engine.neighbors(
      hash(`file:${test}`),
      options.snapshotId,
    )) {
      const target = edge.to ? byId.get(edge.to) : undefined;
      if (
        edge.kind === "imports" &&
        edge.source.path === test &&
        target &&
        !isTest(target)
      )
        exercised.push(target);
    }
  }
  return [...new Set([...chosen, ...exercised, ...code])].slice(
    0,
    TESTER_FOCUS_LIMIT,
  );
}
