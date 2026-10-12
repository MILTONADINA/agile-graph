import { describe, expect, it } from "vitest";
import {
  assertProjectPolicy,
  DEFAULT_POLICY,
  globComplexityError,
} from "../src/index.js";

/** Many wildcards in one segment backtrack for minutes on a near match. */
const CRAFTED = "**/a*a*a*a*a*a*b";

describe("policy glob complexity", () => {
  it("refuses a glob with more than three wildcards in one path segment", () => {
    expect(globComplexityError(CRAFTED)).toMatch(
      /has 6 wildcards in one path segment; at most 3/,
    );
    expect(globComplexityError("!src/a*b*c*d*e/**")).toMatch(/has 4 wildcards/);
    expect(globComplexityError("src/**/*.test.ts")).toBeUndefined();
    expect(globComplexityError("packages/*/src/*-*.*")).toBeUndefined();
    expect(globComplexityError("a".repeat(513))).toMatch(/longer than 512/);
  });

  it("refuses such a glob in exportPaths or excludedPaths when the policy loads, quickly", () => {
    for (const field of ["exportPaths", "excludedPaths"]) {
      const started = performance.now();
      expect(() =>
        assertProjectPolicy({ ...DEFAULT_POLICY, [field]: [CRAFTED] }),
      ).toThrow(/wildcards in one path segment/);
      expect(performance.now() - started).toBeLessThan(500);
    }
    expect(() =>
      assertProjectPolicy({ ...DEFAULT_POLICY, exportPaths: ["src/**/*.ts"] }),
    ).not.toThrow();
  });
});
