import { afterEach, describe, expect, it, vi } from "vitest";

// The grammar and runtime caches are module state. Each test loads fresh
// engine modules so a failure cached by one test cannot leak into another.
// web-tree-sitter is an external package, so the spies on its classes reach
// the calls that the fresh modules make.
async function freshEngine() {
  vi.resetModules();
  const treeSitter = await import("web-tree-sitter");
  const parser = await import("../src/context/parser.js");
  const dart = await import("../src/context/dart-snapshot.js");
  const rust = await import("../src/context/rust-snapshot.js");
  return {
    Language: treeSitter.Language,
    Parser: treeSitter.Parser,
    parseFile: parser.parseFile,
    prepareDartSnapshot: dart.prepareDartSnapshot,
    prepareRustSnapshot: rust.prepareRustSnapshot,
  };
}

const typescript = "export function alpha(): number {\n  return 1;\n}\n";
const python = "def beta():\n    return 2\n";

afterEach(() => vi.restoreAllMocks());

describe("Tree-sitter grammar and runtime loads (issue #265)", () => {
  it("retries a grammar load that failed once instead of reusing the rejection", async () => {
    const engine = await freshEngine();
    const load = vi
      .spyOn(engine.Language, "load")
      .mockRejectedValueOnce(new Error("injected grammar read failure"));

    const first = await engine.parseFile(
      "src/alpha.ts",
      typescript,
      "snapshot",
    );
    expect(first.parsed).toBe(false);
    expect(first.errors).toEqual([
      "src/alpha.ts: parser unavailable (injected grammar read failure)",
    ]);

    const second = await engine.parseFile(
      "src/alpha.ts",
      typescript,
      "snapshot",
    );
    expect(second.parsed).toBe(true);
    expect(second.errors).toEqual([]);
    expect(second.symbols.map((symbol) => symbol.name)).toContain("alpha");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reports a failed runtime init as unavailable instead of rejecting, then retries it", async () => {
    const engine = await freshEngine();
    const init = vi
      .spyOn(engine.Parser, "init")
      .mockRejectedValueOnce(new Error("injected runtime init failure"));

    const first = await engine.parseFile(
      "src/alpha.ts",
      typescript,
      "snapshot",
    );
    expect(first.parsed).toBe(false);
    expect(first.errors).toEqual([
      "src/alpha.ts: parser unavailable (injected runtime init failure)",
    ]);

    const second = await engine.parseFile(
      "src/alpha.ts",
      typescript,
      "snapshot",
    );
    expect(second.parsed).toBe(true);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight runtime init and grammar load between concurrent parses", async () => {
    const engine = await freshEngine();
    const init = vi.spyOn(engine.Parser, "init");
    const load = vi.spyOn(engine.Language, "load");

    const parsed = await Promise.all([
      engine.parseFile("src/alpha.ts", typescript, "snapshot"),
      engine.parseFile("src/beta.ts", typescript, "snapshot"),
      engine.parseFile("tools/beta.py", python, "snapshot"),
    ]);
    expect(parsed.map((file) => file.parsed)).toEqual([true, true, true]);
    // A later parse after success reuses both the runtime and the grammar.
    await engine.parseFile("src/alpha.ts", typescript, "snapshot");
    expect(init).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fails concurrent parses together on a failed init, and the next parse retries it", async () => {
    const engine = await freshEngine();
    const init = vi
      .spyOn(engine.Parser, "init")
      .mockRejectedValueOnce(new Error("injected runtime init failure"));

    const failed = await Promise.all([
      engine.parseFile("src/alpha.ts", typescript, "snapshot"),
      engine.parseFile("src/beta.ts", typescript, "snapshot"),
    ]);
    expect(failed.map((file) => file.parsed)).toEqual([false, false]);
    expect(failed.map((file) => file.errors)).toEqual([
      ["src/alpha.ts: parser unavailable (injected runtime init failure)"],
      ["src/beta.ts: parser unavailable (injected runtime init failure)"],
    ]);
    expect(init).toHaveBeenCalledTimes(1);

    const recovered = await engine.parseFile(
      "src/alpha.ts",
      typescript,
      "snapshot",
    );
    expect(recovered.parsed).toBe(true);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("reports syntax errors from a parse that recovered from a failed load", async () => {
    const engine = await freshEngine();
    vi.spyOn(engine.Language, "load").mockRejectedValueOnce(
      new Error("injected grammar read failure"),
    );
    await engine.parseFile("src/alpha.ts", typescript, "snapshot");

    const malformed = await engine.parseFile(
      "src/broken.ts",
      "export function broken( {\n",
      "snapshot",
    );
    expect(malformed.parsed).toBe(true);
    expect(malformed.errors).toEqual([
      "src/broken.ts: syntax errors; graph may be incomplete",
    ]);
  });

  it("retries the Rust snapshot grammar after a failed load", async () => {
    // Parse with one copy of the modules, then prepare the snapshot with a
    // fresh copy whose grammar cache is still empty, so its load runs first.
    const parsing = await freshEngine();
    const files = [
      await parsing.parseFile(
        "lib.rs",
        "pub fn alpha() -> i32 { 1 }\n",
        "snapshot",
      ),
    ];
    const engine = await freshEngine();
    vi.spyOn(engine.Language, "load").mockRejectedValueOnce(
      new Error("injected grammar read failure"),
    );

    await expect(engine.prepareRustSnapshot(files, "snapshot")).rejects.toThrow(
      "injected grammar read failure",
    );
    await expect(
      engine.prepareRustSnapshot(files, "snapshot"),
    ).resolves.toMatchObject({ roots: ["lib.rs"] });
  });

  it("retries the Dart snapshot grammar after a failed load", async () => {
    const parsing = await freshEngine();
    const files = [
      await parsing.parseFile(
        "pubspec.yaml",
        "name: toy_counter\n",
        "snapshot",
      ),
      await parsing.parseFile(
        "lib/main.dart",
        "int top() => 1;\nvoid main() { top(); }\n",
        "snapshot",
      ),
    ];
    const engine = await freshEngine();
    vi.spyOn(engine.Language, "load").mockRejectedValueOnce(
      new Error("injected grammar read failure"),
    );

    await expect(engine.prepareDartSnapshot(files, "snapshot")).rejects.toThrow(
      "injected grammar read failure",
    );
    await expect(
      engine.prepareDartSnapshot(files, "snapshot"),
    ).resolves.toMatchObject({ packageName: "toy_counter" });
  });
});
