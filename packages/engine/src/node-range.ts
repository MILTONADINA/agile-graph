// Node version gate helpers. Pure: importing this module has no side effects.
// node-gate.ts runs the check at load time; keep this file free of imports that
// do work, so the check can run before anything else in the CLI loads.

// Must equal "engines.node" in package.json; node-range.test.ts enforces it.
export const ENGINE_NODE_RANGE = "^22.18.0 || >=24 <27";

export const ENGINE_NODE_DESCRIPTION = "22.18+ or 24 to 26";

export type NodeVersion = readonly [
  major: number,
  minor: number,
  patch: number,
];

interface Interval {
  // Inclusive lower bound.
  readonly lower: NodeVersion;
  // Exclusive upper bound, when the alternative has one.
  readonly upper?: NodeVersion;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const PARTIAL = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

// Parses an exact "major.minor.patch" version such as process.versions.node.
export function parseNodeVersion(text: string): NodeVersion | undefined {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parsePartial(text: string): NodeVersion {
  const match = PARTIAL.exec(text);
  if (!match) throw new Error(`unsupported engines version: ${text}`);
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

// Parses the range shape this package uses: "||"-separated alternatives, each a
// caret comparator (^M.m.p, meaning >=M.m.p and <M+1.0.0) or a space-separated
// pair of ">=" and "<" comparators. Anything else throws, so an engines range
// this parser cannot read fails loudly rather than admitting every version.
function parseRange(range: string): Interval[] {
  return range.split("||").map((alternative) => {
    const tokens = alternative.trim().split(/\s+/);
    let lower: NodeVersion | undefined;
    let upper: NodeVersion | undefined;
    for (const token of tokens) {
      if (token.startsWith("^")) {
        if (lower || upper)
          throw new Error(`unsupported engines range: ${range}`);
        const base = parsePartial(token.slice(1));
        if (base[0] === 0)
          throw new Error(`unsupported engines range: ${range}`);
        lower = base;
        upper = [base[0] + 1, 0, 0];
      } else if (token.startsWith(">=")) {
        if (lower) throw new Error(`unsupported engines range: ${range}`);
        lower = parsePartial(token.slice(2));
      } else if (token.startsWith("<") && !token.startsWith("<=")) {
        if (upper) throw new Error(`unsupported engines range: ${range}`);
        upper = parsePartial(token.slice(1));
      } else {
        throw new Error(`unsupported engines range: ${range}`);
      }
    }
    if (!lower) throw new Error(`unsupported engines range: ${range}`);
    return upper ? { lower, upper } : { lower };
  });
}

function compare(a: NodeVersion, b: NodeVersion): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// True when the version satisfies at least one alternative of the range.
export function nodeVersionSupported(version: string, range: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  return parseRange(range).some(
    (interval) =>
      compare(parsed, interval.lower) >= 0 &&
      (interval.upper === undefined || compare(parsed, interval.upper) < 0),
  );
}

export function unsupportedNodeMessage(version: string): string {
  return `agile-graph needs Node ${ENGINE_NODE_DESCRIPTION}; this is ${version}`;
}
