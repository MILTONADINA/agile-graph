import { describe, it, expect } from "vitest";
import picomatch from "picomatch";
import {
  DEFAULT_POLICY,
  globComplexityError,
  type ProjectPolicy,
} from "@agile-graph/contracts";
import { globAllowlist, isAllowedPath } from "../src/policy.js";

// Seeded generators, no dependency. Override the seed to replay a failure:
//   PROPERTY_SEED=123 npm test -w @agile-graph/engine -- tests/property-globs.test.ts
const SEED = Number(process.env.PROPERTY_SEED ?? 20260417);
const CASES = 300;
const TIME_BOUND_MS = 50;

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
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[int(random, items.length)]!;

const LITERALS = ["a", "ab", "src", "x", "a.b", "-", "_", "é", "0"];
const TOKENS = [
  ...LITERALS,
  "*",
  "**",
  "?",
  "[ab]",
  "{a,b}",
  "+(a|aa)",
  "*(a|b)",
  "@(a|b)",
  "?(a)",
  "!(a)",
  ".*",
];
/** A glob segment: a short run of literals, wildcards and extglobs. */
function segment(random: Random): string {
  let text = "";
  for (let count = 1 + int(random, 7); count > 0; count--)
    text += pick(random, TOKENS);
  return text;
}
function glob(random: Random): string {
  const parts = Array.from({ length: 1 + int(random, 4) }, () =>
    random() < 0.15 ? "**" : segment(random),
  );
  const joined = parts.join("/");
  return random() < 0.2 ? `!${joined}` : joined;
}
/** Paths of exactly 255 characters built to resemble the globs: the near matches that make a regex backtrack. */
function longPath(random: Random): string {
  const alphabet = ["a", "b", "ab", "aa", "src", "-", "é"];
  const shape = int(random, 3);
  let text = "";
  if (shape === 0) text = "a".repeat(255);
  else if (shape === 1) {
    while (text.length < 255) text += pick(random, alphabet);
  } else {
    // Several segments, the longest filling most of the 255 characters.
    while (text.length < 255) {
      text += pick(random, alphabet).repeat(1 + int(random, 60));
      if (random() < 0.15) text += "/";
    }
  }
  return text.slice(0, 255).replace(/\/$/, "a").padEnd(255, "b");
}
const fail = (seed: number, detail: string) =>
  `${detail}\n(replay with PROPERTY_SEED=${seed})`;

describe("property: policy globs", () => {
  it("refuses a glob or matches a 255-character path within the time bound", () => {
    const random = mulberry32(SEED);
    let accepted = 0;
    let refused = 0;
    for (let index = 0; index < CASES; index++) {
      const pattern = glob(random);
      const paths = [longPath(random), longPath(random)];
      const error = globComplexityError(pattern);
      if (error !== undefined) {
        refused++;
        // A refused glob never compiles into an allowlist that can match.
        expect(
          globAllowlist([pattern, "x"])("x"),
          fail(SEED, `refused glob ${JSON.stringify(pattern)} still compiled`),
        ).toBe(false);
        continue;
      }
      accepted++;
      // A leading `!(` is an extglob that the allowlist reads as an exclusion.
      const positive = pattern.replace(/^!/, "");
      if (positive.startsWith("!")) continue;
      // Compile once; time only the match, best of three against scheduling noise.
      const matches = globAllowlist([positive]);
      const reference = picomatch(positive.normalize("NFC"), {
        dot: true,
        nonegate: true,
      });
      for (const candidate of paths) {
        let best = Infinity;
        let result = false;
        for (let run = 0; run < 3; run++) {
          const start = performance.now();
          result = matches(candidate);
          best = Math.min(best, performance.now() - start);
        }
        expect(
          best,
          fail(
            SEED,
            `glob ${JSON.stringify(pattern)} took ${best.toFixed(1)} ms on ${JSON.stringify(candidate)}`,
          ),
        ).toBeLessThan(TIME_BOUND_MS);
        // The allowlist agrees with picomatch (no exclusions, so nothing narrows it).
        expect(
          result,
          fail(
            SEED,
            `glob ${JSON.stringify(pattern)} on ${JSON.stringify(candidate)}`,
          ),
        ).toBe(reference(candidate));
      }
    }
    // Positive controls: matching really happens, so a dead matcher fails here.
    expect(globAllowlist(["**"])(longPath(random))).toBe(true);
    expect(globAllowlist(["a*"])("a".repeat(255))).toBe(true);
    expect(globAllowlist(["a*"])("b".repeat(255))).toBe(false);
    // The generator must exercise both outcomes, or the property is empty.
    expect(accepted).toBeGreaterThan(CASES / 10);
    expect(refused).toBeGreaterThan(CASES / 10);
  });

  it("never allows a path with a .. segment through exportPaths, excludedPaths or the working set", () => {
    const random = mulberry32(SEED + 1);
    const escapes = ["..", "../", "a/../b", "../../x", "src/../../x", "x/.."];
    for (let index = 0; index < CASES; index++) {
      const patterns = Array.from({ length: 1 + int(random, 3) }, () =>
        random() < 0.3 ? "**" : glob(random).replace(/^!/, ""),
      );
      if (patterns.some((pattern) => globComplexityError(pattern))) continue;
      const policy: ProjectPolicy = {
        ...DEFAULT_POLICY,
        exportPaths: patterns,
        ...(random() < 0.3 ? { workingSet: patterns } : {}),
      };
      for (const prefix of [
        "",
        ...patterns.map((p) => p.replace(/\*/g, "a")),
      ]) {
        for (const escape of escapes) {
          const candidate = `${prefix}${prefix && !prefix.endsWith("/") ? "/" : ""}${escape}`;
          for (const forExport of [false, true])
            expect(
              isAllowedPath(candidate, policy, forExport),
              fail(
                SEED + 1,
                `${JSON.stringify(candidate)} allowed by ${JSON.stringify(patterns)} (forExport ${forExport})`,
              ),
            ).toBe(false);
        }
      }
    }
  });
});
