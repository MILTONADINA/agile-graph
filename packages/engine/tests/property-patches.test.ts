import { describe, it, expect, afterAll } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import { applyProposal } from "../src/execution/workspace.js";

// Seeded generators, no dependency. Replay a failure with
//   PROPERTY_SEED=123 npm test -w @agile-graph/engine -- tests/property-patches.test.ts
const SEED = Number(process.env.PROPERTY_SEED ?? 20260417);
const CASES = 200;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Random = () => number;
const int = (random: Random, below: number) => Math.floor(random() * below);
const ALPHABET = [
  "a",
  "b",
  "c",
  "d",
  " ",
  "\n",
  "\n",
  "{",
  "}",
  "é",
  "$&",
  "$1",
];
function text(random: Random, max: number): string {
  let out = "";
  for (let count = int(random, max); count > 0; count--)
    out += ALPHABET[int(random, ALPHABET.length)];
  return out;
}
/** Mutates `original` with a few random splices so the pair shares context. */
function mutate(random: Random, original: string): string {
  let out = original;
  for (let edits = 1 + int(random, 3); edits > 0; edits--) {
    const from = int(random, out.length + 1);
    const to = Math.min(out.length, from + int(random, 6));
    out = out.slice(0, from) + text(random, 6) + out.slice(to);
  }
  return out;
}
/**
 * Counts overlapping occurrences. The engine's own precondition counts
 * non-overlapping ones (`split`), so it accepts "\n\n" in "\n\n\n" and
 * patches the first; the generator must not rely on that.
 */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  )
    count++;
  return count;
}
/**
 * The diff of (original, modified) in the proposal format: the span between
 * their common prefix and suffix, widened until it occurs once in the
 * original, as the engine requires.
 */
function diff(
  original: string,
  modified: string,
): { before: string; after: string } {
  let start = 0;
  while (
    start < original.length &&
    start < modified.length &&
    original[start] === modified[start]
  )
    start++;
  let end = 0;
  while (
    end < original.length - start &&
    end < modified.length - start &&
    original[original.length - 1 - end] === modified[modified.length - 1 - end]
  )
    end++;
  let from = start;
  let to = original.length - end;
  const delta = modified.length - original.length;
  for (;;) {
    const before = original.slice(from, to);
    if (before && occurrences(original, before) === 1)
      return {
        before,
        after: modified.slice(from, to + delta),
      };
    if (from === 0 && to === original.length)
      throw new Error("unreachable: the whole original occurs once");
    from = Math.max(0, from - 1);
    to = Math.min(original.length, to + 1);
  }
}

const roots: string[] = [];
async function workspace(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "graph-property-"));
  roots.push(base);
  const root = path.join(base, "ws");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}
afterAll(() =>
  Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))),
);

const failure = (seed: number, detail: string) =>
  `${detail}\n(replay with PROPERTY_SEED=${seed})`;

describe("property: workspace patches", () => {
  it("applies a diff of (original, modified) to give modified exactly", async () => {
    const { root } = await workspace();
    const random = mulberry32(SEED);
    let created = 0;
    for (let index = 0; index < CASES; index++) {
      const file = `dir${index % 5}/file${index}.txt`;
      const original = text(random, 40);
      const modified =
        random() < 0.15 ? text(random, 40) : mutate(random, original);
      const context = failure(
        SEED,
        `case ${index}: original ${JSON.stringify(original)} modified ${JSON.stringify(modified)}`,
      );
      if (original === modified) continue;
      const absolute = path.join(root, file);
      let change: { path: string; before: string | null; after: string };
      if (original === "") {
        // Creating a file is the empty-original diff.
        change = { path: file, before: null, after: modified };
        created++;
      } else {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, original);
        change = { path: file, ...diff(original, modified) };
      }
      const written = await applyProposal(
        root,
        { summary: "property", requests: [], changes: [change] },
        DEFAULT_POLICY,
      );
      expect(written, context).toEqual([file]);
      expect(await readFile(absolute, "utf8"), context).toBe(modified);
    }
    expect(created).toBeGreaterThan(0);
  });

  it("refuses a patch whose target escapes the workspace or goes through a symlink", async () => {
    const { root, outside } = await workspace();
    await writeFile(path.join(outside, "secret.txt"), "keep");
    await mkdir(path.join(root, "real"));
    await symlink(outside, path.join(root, "linkdir"));
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(root, "linkfile"),
    );
    await symlink("real", path.join(root, "inner"));
    const random = mulberry32(SEED + 1);
    const names = ["a.txt", "secret.txt", "new/deep/b.txt", "x"];
    const prefixes = [
      () => "../outside/",
      () => `${"../".repeat(1 + int(random, 4))}outside/`,
      () => "real/../../outside/",
      () => "linkdir/",
      () => "linkdir/sub/",
      () => "inner/",
      () => `/${outside.slice(1)}/`,
    ];
    for (let index = 0; index < CASES; index++) {
      const name = names[int(random, names.length)]!;
      const target =
        random() < 0.15
          ? "linkfile"
          : prefixes[int(random, prefixes.length)]!() + name;
      const context = failure(
        SEED + 1,
        `case ${index}: target ${JSON.stringify(target)}`,
      );
      const creation = random() < 0.5;
      await expect(
        applyProposal(
          root,
          {
            summary: "escape",
            requests: [],
            changes: [
              creation
                ? { path: target, before: null, after: "pwned" }
                : { path: target, before: "keep", after: "pwned" },
            ],
          },
          DEFAULT_POLICY,
        ),
        context,
      ).rejects.toThrow();
      expect(
        await readFile(path.join(outside, "secret.txt"), "utf8"),
        context,
      ).toBe("keep");
    }
    // Nothing was created outside, nor through a link into the real directory.
    const { readdir } = await import("node:fs/promises");
    expect(
      (await readdir(outside)).sort(),
      "outside directory changed",
    ).toEqual(["secret.txt"]);
    expect(
      await readdir(path.join(root, "real")),
      "link target changed",
    ).toEqual([]);
  });
});
