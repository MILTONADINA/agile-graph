// The tree-sitter runtime and grammar loader. It lives apart from parser.ts so
// the published declarations reachable from the package entry never import
// web-tree-sitter's types, which need @types/emscripten (#342).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Parser, Language as Grammar } from "web-tree-sitter";

const grammars = new Map<string, Promise<Grammar>>();
let initialized: Promise<void> | undefined;
const require = createRequire(import.meta.url);
const grammarRoot = dirname(require.resolve("tree-sitter-wasms/package.json"));

// A rejected runtime or grammar load is dropped from its cache before its
// callers resume, so the next call retries it. Only one load per key is in
// flight at a time, so the removal can only drop the rejected promise itself.
// Parses that start while a load is pending share that one load.
function initRuntime(): Promise<void> {
  initialized ??= Parser.init().catch((error: unknown) => {
    initialized = undefined;
    throw error;
  });
  return initialized;
}

/** Loads a bundled grammar once after the shared runtime init, and retries it
 * after a failure. */
export function loadGrammar(name: string): Promise<Grammar> {
  let grammar = grammars.get(name);
  if (!grammar) {
    grammar = (async () => {
      await initRuntime();
      return Grammar.load(join(grammarRoot, "out", `tree-sitter-${name}.wasm`));
    })().catch((error: unknown) => {
      grammars.delete(name);
      throw error;
    });
    grammars.set(name, grammar);
  }
  return grammar;
}
