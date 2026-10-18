import { describe, expect, it, vi } from "vitest";

// Force the extractor to fail after it has recorded declarations, imports and
// calls, with no call linked (the shape issue #185 reported).
vi.mock("../src/context/dart-syntax.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/context/dart-syntax.js")>();
  return {
    ...original,
    extractDart: (...args: Parameters<typeof original.extractDart>) => {
      const [root, result, source] = args;
      original.extractDart(root, result, source);
      for (const edge of result.edges) {
        edge.to = null;
        edge.evidence = "syntactic";
      }
      throw new Error("injected extractor fault");
    },
  };
});
import { parseFile } from "../src/context/parser.js";

describe("Dart call extraction fault", () => {
  it("reports a coverage error when Dart call linking fails instead of returning no links silently", async () => {
    const parsed = await parseFile(
      "lib/a.dart",
      "import 'dart:math';\n\nint one() => 1;\n\nint two() => one() + 1;\n",
      "snapshot",
    );
    // Declarations, imports and calls survive as partial evidence...
    expect(parsed.symbols.some((symbol) => symbol.name === "two")).toBe(true);
    expect(parsed.edges.some((edge) => edge.kind === "imports")).toBe(true);
    const calls = parsed.edges.filter((edge) => edge.kind === "calls");
    expect(calls.length).toBeGreaterThan(0);
    // ...no call is linked...
    expect(calls.filter((edge) => edge.evidence === "heuristic")).toEqual([]);
    // ...and the fault is always visible as a diagnostic.
    expect(parsed.errors).toEqual([
      "lib/a.dart: parser unavailable (injected extractor fault)",
    ]);
  });
});
