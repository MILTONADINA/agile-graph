import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import { ContextEngine } from "../src/context/index.js";

const roots: string[] = [],
  engines: ContextEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("symbol search case folding (#298)", () => {
  it("matches non-ASCII names in any case and keeps ASCII matching unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-symbol-fold-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    // NFD spelling on disk; the query below uses the composed (NFC) form.
    await writeFile(
      join(repo, "names.ts"),
      `export function ${"Ünïcode".normalize("NFD")}() {}\nexport function visibleCaller() {}\nexport function under_score() {}\nexport function underXscore() {}\nexport function \u039f\u03a3() {}\n`,
    );
    const engine = new ContextEngine({
      projectId: "symbol-fold",
      root: repo,
      dataDir: join(root, "data"),
      policy: structuredClone(DEFAULT_POLICY),
    });
    engines.push(engine);
    const snapshot = await engine.index({ semantic: false });
    const names = async (query: string) =>
      (await engine.searchSymbols(query, snapshot.id))
        .filter((symbol) => symbol.kind !== "file")
        .map((symbol) => symbol.name.normalize("NFC"));
    for (const query of ["Ünïcode", "ünïcode", "ÜNÏCODE", "NÏC"])
      expect(await names(query), query).toEqual(["Ünïcode"]);
    for (const query of ["VISIBLECALLER", "visiblecaller", "visibleCaller"])
      expect(await names(query), query).toEqual(["visibleCaller"]);
    // Lowercasing ΟΣ gives a final sigma (ος); a lone Σ gives σ. Both
    // sides map ς to σ, so every sigma form finds it.
    for (const query of [
      "\u03a3",
      "\u03c3",
      "\u03c2",
      "\u03bf\u03c2",
      "\u039f\u03a3",
    ])
      expect(await names(query), query).toEqual(["\u039f\u03a3"]);
    // LIKE wildcards in the query stay literal.
    expect(await names("under_")).toEqual(["under_score"]);
    expect(await names("%")).toEqual([]);
  });
});
