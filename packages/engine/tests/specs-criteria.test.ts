import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import { checkSpecs, parseSpec } from "../src/specs.js";
import { acCoverage } from "../src/planning.js";

// #318: a line that starts like a criterion but is not `- AC<n>: text` was
// dropped silently, and its test links attached to the criterion before it.
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const toySpec = (criteria: string[]) =>
  [
    "# Toy greeting",
    "",
    "- ID: toy-greeting",
    "- Status: implemented",
    "- Area: toy",
    "",
    "## Problem",
    "",
    "The toy needs a greeting.",
    "",
    "## Acceptance criteria",
    "",
    ...criteria,
    "",
    "## Security considerations",
    "",
    "None.",
    "",
    "## Non-goals",
    "",
    "Farewells.",
    "",
  ].join("\n");

describe("malformed acceptance criteria (#318)", () => {
  it("reports a criterion line with text before its colon and keeps its test links off the criterion above", () => {
    const spec = parseSpec(
      "specs/toy/toy-greeting.md",
      toySpec([
        "- AC1: The toy greets",
        "  - Test: tests/toy.test.ts :: greets",
        "- AC2 (#1): The toy refuses empty input",
        "  - Test: tests/toy.test.ts :: refuses empty input",
      ]),
    );
    expect(spec.criteria.map((criterion) => criterion.id)).toEqual(["AC1"]);
    expect(spec.criteria[0]!.tests).toEqual([
      { path: "tests/toy.test.ts", name: "greets" },
    ]);
    expect(spec.malformed).toEqual([
      { line: 15, text: "- AC2 (#1): The toy refuses empty input" },
    ]);
  });

  it("fails spec-check on a malformed criterion, naming the file and line", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "graph-specs-criteria-"));
    directories.push(root);
    await mkdir(path.join(root, "specs", "toy"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(
      path.join(root, "specs", "toy", "toy-greeting.md"),
      toySpec([
        "- AC1: The toy greets",
        "  - Test: tests/toy.test.ts :: greets",
        "- AC2 (#1): The toy refuses empty input",
        "  - Test: tests/toy.test.ts :: missing test",
      ]),
    );
    await writeFile(
      path.join(root, "tests", "toy.test.ts"),
      'it("greets", () => {});\n',
    );
    const { errors } = await checkSpecs(root, DEFAULT_POLICY);
    expect(errors).toEqual([
      `specs/toy/toy-greeting.md: line 15 is not a criterion: write it as '- AC<n>: text' ("- AC2 (#1): The toy refuses empty input")`,
    ]);
  });

  it("reads a criterion ID with a letter suffix, such as AC7a, and covers it in plans", () => {
    const spec = parseSpec(
      "specs/toy/toy-greeting.md",
      toySpec([
        "- AC7: The toy greets",
        "- AC7a: The toy greets twice",
        "  - Test: tests/toy.test.ts :: greets twice",
      ]),
    );
    expect(spec.malformed).toEqual([]);
    expect(spec.criteria.map((criterion) => criterion.id)).toEqual([
      "AC7",
      "AC7a",
    ]);
    expect(spec.criteria[1]!.tests).toHaveLength(1);
    expect(
      acCoverage(
        ["AC7: The toy greets", "AC7a: The toy greets twice"],
        [{ covers: ["AC7"] }],
      ).uncovered,
    ).toEqual(["AC7a"]);
  });
});
