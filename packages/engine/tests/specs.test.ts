import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  checkSpecs,
  ciRunsWithSwitch,
  clarifications,
  definesTest,
  parseSpec,
  planFromSpec,
  specTemplate,
  testSwitch,
} from "../src/specs.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "graph-specs-"));
  directories.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}
const spec = (overrides: {
  id?: string;
  status?: string;
  area?: string;
  criteria?: string;
  omit?: string;
}) =>
  [
    "# Invoice list",
    "",
    `- ID: ${overrides.id ?? "invoice-list"}`,
    `- Status: ${overrides.status ?? "implemented"}`,
    `- Area: ${overrides.area ?? "billing"}`,
    "- Epic: Billing",
    "",
    "## Problem",
    "",
    "Accountants need to see every invoice.",
    "",
    "## Acceptance criteria",
    "",
    overrides.criteria ??
      [
        "- AC1: GET /invoices lists invoices",
        "  - Test: tests/invoices.test.ts :: lists invoices",
        "- AC2: Unauthenticated requests are refused",
        "  - Test: tests/invoices.test.ts :: refuses anonymous users",
      ].join("\n"),
    "",
    ...(overrides.omit === "Security considerations"
      ? []
      : [
          "## Security considerations",
          "",
          "Only authenticated accountants may list invoices.",
          "",
        ]),
    "## Non-goals",
    "",
    "Editing invoices.",
    "",
  ].join("\n");
const tests = `it("lists invoices", () => {});\nit("refuses anonymous users", () => {});\n`;

describe("spec parsing", () => {
  it("reads fields, sections, criteria and test links", () => {
    const parsed = parseSpec("specs/billing/invoice-list.md", spec({}));
    expect(parsed).toMatchObject({
      title: "Invoice list",
      id: "invoice-list",
      status: "implemented",
      area: "billing",
      epic: "Billing",
    });
    expect(parsed.criteria).toEqual([
      {
        id: "AC1",
        text: "GET /invoices lists invoices",
        tests: [{ path: "tests/invoices.test.ts", name: "lists invoices" }],
      },
      {
        id: "AC2",
        text: "Unauthenticated requests are refused",
        tests: [
          { path: "tests/invoices.test.ts", name: "refuses anonymous users" },
        ],
      },
    ]);
    expect(planFromSpec(parsed)).toMatchObject({
      acceptance: [
        "AC1: GET /invoices lists invoices",
        "AC2: Unauthenticated requests are refused",
      ],
    });
    expect(planFromSpec(parsed).objective).toContain(
      "Security considerations: Only authenticated accountants",
    );
  });

  it("keeps a criterion's wrapped lines and nested bullets in its text", () => {
    const parsed = parseSpec(
      "specs/billing/invoice-list.md",
      spec({
        criteria: [
          "- AC1: GET /invoices lists invoices, newest first, and",
          "  includes each invoice's total",
          "  - in the account's currency",
          "",
          "  - rounded to cents",
          "  - Test: tests/invoices.test.ts :: lists invoices",
          "- AC2: Unauthenticated requests are refused",
          "  - Test: tests/invoices.test.ts :: refuses anonymous users",
          "",
          "Notes at the margin belong to no criterion.",
          "  - nor does an indented line after them",
        ].join("\n"),
      }),
    );
    expect(parsed.criteria).toEqual([
      {
        id: "AC1",
        text: "GET /invoices lists invoices, newest first, and includes each invoice's total - in the account's currency - rounded to cents",
        tests: [{ path: "tests/invoices.test.ts", name: "lists invoices" }],
      },
      {
        id: "AC2",
        text: "Unauthenticated requests are refused",
        tests: [
          { path: "tests/invoices.test.ts", name: "refuses anonymous users" },
        ],
      },
    ]);
    expect(planFromSpec(parsed).acceptance).toEqual([
      "AC1: GET /invoices lists invoices, newest first, and includes each invoice's total - in the account's currency - rounded to cents",
      "AC2: Unauthenticated requests are refused",
    ]);
  });

  it("refuses to plan a spec with open clarification markers, naming them", () => {
    const parsed = parseSpec(
      "specs/billing/invoice-list.md",
      spec({
        status: "ready",
        criteria: [
          "- AC1: GET /invoices lists invoices [NEEDS CLARIFICATION: paged",
          "  or all at once?]",
          "- AC2: Unauthenticated requests are refused",
        ].join("\n"),
      }).replace(
        "Editing invoices.",
        "Editing invoices. [NEEDS CLARIFICATION: are drafts invoices?]",
      ),
    );
    expect(clarifications(parsed)).toEqual([
      { section: "Acceptance criteria", question: "paged or all at once?" },
      { section: "Non-goals", question: "are drafts invoices?" },
    ]);
    expect(() => planFromSpec(parsed)).toThrow(
      "has 2 open questions marked NEEDS CLARIFICATION; answer them in the spec before planning: paged or all at once? (Acceptance criteria); are drafts invoices? (Non-goals)",
    );
  });

  it("keeps a fenced block under a criterion in its text but reads no marker in it", () => {
    const parsed = parseSpec(
      "specs/billing/invoice-list.md",
      spec({
        status: "ready",
        criteria: [
          "- AC1: GET /invoices returns",
          "  ```json",
          '  { "total": 1250, "note": "[NEEDS CLARIFICATION: an example]" }',
          "",
          "  - AC9: not a criterion",
          "  - Test: tests/invoices.test.ts :: not a link",
          "  ```",
          "  for each invoice",
          "  - Test: tests/invoices.test.ts :: lists invoices",
          "- AC2: Unauthenticated requests are refused",
          "```",
          "A fence at the margin belongs to no criterion.",
          "```",
        ].join("\n"),
      }),
    );
    expect(parsed.criteria).toEqual([
      {
        id: "AC1",
        text: 'GET /invoices returns ```json { "total": 1250, "note": "[NEEDS CLARIFICATION: an example]" } - AC9: not a criterion - Test: tests/invoices.test.ts :: not a link ``` for each invoice',
        tests: [{ path: "tests/invoices.test.ts", name: "lists invoices" }],
      },
      { id: "AC2", text: "Unauthenticated requests are refused", tests: [] },
    ]);
    expect(clarifications(parsed)).toEqual([]);
    expect(planFromSpec(parsed).acceptance[0]).toContain('"total": 1250');
  });

  it("closes a fence only with the same delimiter, at least as long, with no info string", () => {
    const parsed = parseSpec(
      "specs/billing/invoice-list.md",
      spec({
        status: "ready",
        criteria: [
          "- AC1: GET /invoices documents its example",
          "  ````markdown",
          "  ```json",
          '  { "note": "[NEEDS CLARIFICATION]" }',
          "  ```",
          "- AC8: not a criterion",
          "  ````",
          "  for each invoice",
          "  - Test: tests/invoices.test.ts :: lists invoices",
          "- AC2: Refused with",
          "  ~~~",
          "  ```",
          "  ~~~~ text",
          "- AC9: not a criterion either [NEEDS CLARIFICATION: inside]",
          "  ~~~~",
          "  in the body",
        ].join("\n"),
      }),
    );
    expect(parsed.criteria).toEqual([
      {
        id: "AC1",
        text: 'GET /invoices documents its example ````markdown ```json { "note": "[NEEDS CLARIFICATION]" } ``` - AC8: not a criterion ```` for each invoice',
        tests: [{ path: "tests/invoices.test.ts", name: "lists invoices" }],
      },
      {
        id: "AC2",
        text: "Refused with ~~~ ``` ~~~~ text - AC9: not a criterion either [NEEDS CLARIFICATION: inside] ~~~~ in the body",
        tests: [],
      },
    ]);
    expect(clarifications(parsed)).toEqual([]);
    expect(planFromSpec(parsed).acceptance).toHaveLength(2);
  });

  it("finds clarification markers in any case, with or without a question", () => {
    const parsed = parseSpec(
      "specs/billing/invoice-list.md",
      spec({
        status: "ready",
        criteria: [
          "- AC1: GET /invoices lists invoices [NEEDS CLARIFICATION]",
          "- AC2: Refused [needs clarification: which status code?]",
          "- AC3: Paged [Needs Clarification:]",
          "- AC4: Sorted [ NEEDS  CLARIFICATION which order? ]",
        ].join("\n"),
      }),
    );
    expect(clarifications(parsed)).toEqual([
      { section: "Acceptance criteria", question: "(no question written)" },
      { section: "Acceptance criteria", question: "which status code?" },
      { section: "Acceptance criteria", question: "(no question written)" },
      { section: "Acceptance criteria", question: "which order?" },
    ]);
    expect(() => planFromSpec(parsed)).toThrow(
      "has 4 open questions marked NEEDS CLARIFICATION; answer them in the spec before planning: (no question written) (Acceptance criteria); which status code? (Acceptance criteria)",
    );
  });

  it("refuses to plan a draft", () => {
    expect(() =>
      planFromSpec(
        parseSpec("specs/billing/invoice-list.md", spec({ status: "draft" })),
      ),
    ).toThrow("mark it ready before planning");
  });

  it("scaffolds a valid draft", async () => {
    const root = await repo({
      "specs/billing/refunds.md": specTemplate({
        id: "refunds",
        title: "Refund an invoice",
        area: "billing",
      }),
    });
    expect(await checkSpecs(root, DEFAULT_POLICY)).toEqual({
      specs: [expect.objectContaining({ id: "refunds", status: "draft" })],
      errors: [],
    });
  });

  it("explains the clarification marker in a template comment", () => {
    const template = specTemplate({
      id: "refunds",
      title: "Refund an invoice",
      area: "billing",
    });
    expect(template).toMatch(
      /^<!-- Write an open question inline as \[NEEDS CLARIFICATION: the question\]\..* -->$/m,
    );
    // Outside every section, so the comment itself is never an open question.
    expect(
      clarifications(parseSpec("specs/billing/refunds.md", template)),
    ).toEqual([]);
  });
});

describe("spec check", () => {
  it("passes an implemented spec whose criteria link existing tests", async () => {
    const root = await repo({
      "specs/billing/invoice-list.md": spec({}),
      "tests/invoices.test.ts": tests,
    });
    expect(await checkSpecs(root, DEFAULT_POLICY)).toEqual({
      specs: [
        expect.objectContaining({
          id: "invoice-list",
          criteria: 2,
          linked: 2,
        }),
      ],
      errors: [],
    });
  });

  it("reports missing tests, missing sections, bad placement and duplicate IDs", async () => {
    const root = await repo({
      "specs/billing/invoice-list.md": spec({
        criteria: [
          "- AC1: GET /invoices lists invoices",
          "  - Test: tests/invoices.test.ts :: paginates invoices",
          "- AC2: Refused without a token",
          "  - Test: tests/missing.test.ts :: refuses",
        ].join("\n"),
        omit: "Security considerations",
      }),
      "specs/other/invoice-list.md": spec({ area: "billing" }),
      "tests/invoices.test.ts": tests,
    });
    const { errors } = await checkSpecs(root, DEFAULT_POLICY);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'AC1 links "paginates invoices", which tests/invoices.test.ts does not contain',
        ),
        expect.stringContaining("AC1 has no verified test link"),
        expect.stringContaining(
          "AC2 links tests/missing.test.ts, which does not exist",
        ),
        expect.stringContaining("missing '## Security considerations' section"),
        expect.stringContaining("must live in specs/billing/"),
        expect.stringContaining("ID invoice-list is also used by"),
      ]),
    );
  });

  it("fails a ready spec with open clarification markers but lets a draft hold them", async () => {
    const marked = (status: string) =>
      spec({ status }).replace(
        "Accountants need to see every invoice.",
        "Accountants need to see every invoice. [NEEDS CLARIFICATION: archived ones too?]\n\n```\n[NEEDS CLARIFICATION: an example, not a question]\n```",
      );
    const ready = await repo({
      "specs/billing/invoice-list.md": marked("ready"),
      "tests/invoices.test.ts": tests,
    });
    expect((await checkSpecs(ready, DEFAULT_POLICY)).errors).toEqual([
      "specs/billing/invoice-list.md: needs clarification in '## Problem': archived ones too?",
    ]);
    const draft = await repo({
      "specs/billing/invoice-list.md": marked("draft"),
      "tests/invoices.test.ts": tests,
    });
    expect((await checkSpecs(draft, DEFAULT_POLICY)).errors).toEqual([]);
  });

  it("passes a ready spec whose four-backtick example holds a three-backtick snippet and a marker", async () => {
    const root = await repo({
      "specs/billing/invoice-list.md": spec({ status: "ready" }).replace(
        "Accountants need to see every invoice.",
        [
          "Accountants need to see every invoice. A spec may show:",
          "",
          "````markdown",
          "```",
          "- AC1: Paged [NEEDS CLARIFICATION: an example, not a question]",
          "```",
          "## Non-goals",
          "[NEEDS CLARIFICATION]",
          "````",
        ].join("\n"),
      ),
      "tests/invoices.test.ts": tests,
    });
    expect((await checkSpecs(root, DEFAULT_POLICY)).errors).toEqual([]);
    const parsed = parseSpec(
      "specs/billing/invoice-list.md",
      await readFile(path.join(root, "specs/billing/invoice-list.md"), "utf8"),
    );
    expect(parsed.sections.Problem).toContain("## Non-goals");
    expect(parsed.sections["Non-goals"]).toBe("Editing invoices.");
    expect(clarifications(parsed)).toEqual([]);
  });

  it("lets a ready spec have untested criteria but not an empty one", async () => {
    const root = await repo({
      "specs/billing/invoice-list.md": spec({
        status: "ready",
        criteria: "- AC1: GET /invoices lists invoices",
      }),
      "specs/billing/empty.md": spec({
        id: "empty",
        status: "ready",
        criteria: "",
      }),
    });
    const { errors } = await checkSpecs(root, DEFAULT_POLICY);
    expect(errors).toEqual([
      "specs/billing/empty.md: missing '## Acceptance criteria' section",
      "specs/billing/empty.md: a ready or implemented spec needs at least one AC line",
    ]);
  });
});

describe("test link verification", () => {
  it("counts only a runnable test with exactly the linked name", () => {
    expect(
      definesTest(`it("lists invoices", () => {});`, "lists invoices"),
    ).toBe(true);
    expect(
      definesTest(`test('lists invoices', () => {});`, "lists invoices"),
    ).toBe(true);
    expect(
      definesTest("it.only(`lists invoices`, () => {});", "lists invoices"),
    ).toBe(true);
    expect(
      definesTest(
        `it.each([1, 2])("lists %s invoices", () => {});`,
        "lists %s invoices",
      ),
    ).toBe(true);
    expect(
      definesTest(
        `it.skipIf(process.platform === "win32")("lists invoices", () => {});`,
        "lists invoices",
      ),
    ).toBe(true);
    // Not a runnable test with that exact name:
    expect(definesTest(`// it("lists invoices")`, "lists invoices")).toBe(
      false,
    );
    expect(
      definesTest(`it.skip("lists invoices", () => {});`, "lists invoices"),
    ).toBe(false);
    expect(definesTest(`it.todo("lists invoices");`, "lists invoices")).toBe(
      false,
    );
    expect(
      definesTest(`it("lists invoices by date", () => {});`, "lists invoices"),
    ).toBe(false);
    expect(
      definesTest(`const note = "lists invoices";`, "lists invoices"),
    ).toBe(false);
  });

  it("finds tests after a glob string or a regex that look like comments", () => {
    const text = [
      `const policy = { exportPaths: ["**/*.md"] };`,
      `const url = /https?:\\/\\//;`,
      "const template = `src/*.ts`;",
      `it("lists invoices", () => {});`,
      `/* it("commented out", () => {}); */`,
      `// it("line comment", () => {});`,
      `it("after the comments", () => {}); // trailing note`,
    ].join("\n");
    expect(definesTest(text, "lists invoices")).toBe(true);
    expect(definesTest(text, "after the comments")).toBe(true);
    expect(definesTest(text, "commented out")).toBe(false);
    expect(definesTest(text, "line comment")).toBe(false);
  });

  it("does not follow a symlinked test file", async () => {
    const root = await repo({
      "specs/billing/invoice-list.md": spec({
        criteria: [
          "- AC1: GET /invoices lists invoices",
          "  - Test: tests/linked.test.ts :: lists invoices",
        ].join("\n"),
      }),
      "elsewhere/real.test.ts": tests,
    });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await symlink(
      path.join(root, "elsewhere", "real.test.ts"),
      path.join(root, "tests", "linked.test.ts"),
    );
    const { errors } = await checkSpecs(root, DEFAULT_POLICY);
    expect(errors).toContain(
      "specs/billing/invoice-list.md: AC1 links tests/linked.test.ts, which does not exist",
    );
  });

  it("ignores headings and criteria inside code fences", () => {
    const parsed = parseSpec(
      "specs/billing/invoice-list.md",
      spec({}).replace(
        "Accountants need to see every invoice.",
        [
          "Accountants need to see every invoice.",
          "```markdown",
          "## Acceptance criteria",
          "- AC9: a fenced example",
          "```",
        ].join("\n"),
      ),
    );
    expect(parsed.sections.Problem).toContain("a fenced example");
    expect(parsed.criteria.map((criterion) => criterion.id)).toEqual([
      "AC1",
      "AC2",
    ]);
  });
});

describe("tests that only run behind an environment switch", () => {
  const gated = [
    `it("lists invoices", () => {});`,
    `it.runIf(process.env.BILLING_DB_TESTS === "1")("refuses anonymous users", async () => {});`,
  ].join("\n");
  const workflow = (step: string) =>
    [
      "jobs:",
      "  platform:",
      "    steps:",
      "      - name: Unit tests",
      "        run: npm test",
      step,
    ].join("\n");

  it("reads the switch a linked test needs", () => {
    expect(testSwitch(gated, "refuses anonymous users")).toBe(
      "BILLING_DB_TESTS",
    );
    expect(testSwitch(gated, "lists invoices")).toBeUndefined();
    expect(
      testSwitch(
        `test.skipIf(!(process.env.X_TESTS === "1"))("slow", () => {});`,
        "slow",
      ),
    ).toBe("X_TESTS");
    expect(
      testSwitch(
        `it.skipIf(process.env.Y_TESTS !== "1")("fast", () => {});`,
        "fast",
      ),
    ).toBe("Y_TESTS");
    const block = [
      `describe.runIf(process.env.DB_TESTS === "1")("database", () => {`,
      `  it("stores rows", async () => {});`,
      `});`,
      `it("runs everywhere", () => {});`,
    ].join("\n");
    expect(testSwitch(block, "stores rows")).toBe("DB_TESTS");
    expect(testSwitch(block, "runs everywhere")).toBeUndefined();
  });

  it("reads switches in a file of many unclosed gated blocks in one linear pass", () => {
    // Each unclosed block once cost a scan to the end of the file.
    const hostile = [
      ...Array.from(
        { length: 20_000 },
        (_, index) =>
          `describe.runIf(process.env.GATE_${index} === "1")("b${index}", () => {`,
      ),
      `  it("deep", () => {});`,
      `describe.runIf(process.env.LAST === "1")("closed", () => {`,
      `  it("inner", () => {});`,
      `});`,
    ].join("\n");
    const started = performance.now();
    expect(testSwitch(hostile, "deep")).toBeUndefined();
    expect(testSwitch(hostile, "inner")).toBe("LAST");
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("fails a criterion proven only by a switched-off test that no CI step runs", async () => {
    const files = {
      "specs/billing/invoice-list.md": spec({}),
      "tests/invoices.test.ts": gated,
    };
    const unrun = await repo({
      ...files,
      ".github/workflows/ci.yml": workflow(""),
    });
    expect((await checkSpecs(unrun, DEFAULT_POLICY)).errors).toEqual([
      'specs/billing/invoice-list.md: AC2 links only tests that no CI step runs: "refuses anonymous users" (needs BILLING_DB_TESTS=1)',
    ]);
    const run = await repo({
      ...files,
      ".github/workflows/ci.yml": workflow(
        [
          "      - name: Billing database",
          "        run: npm test -- --run tests/invoices.test.ts",
          "        env:",
          '          BILLING_DB_TESTS: "1"',
        ].join("\n"),
      ),
    });
    expect((await checkSpecs(run, DEFAULT_POLICY)).errors).toEqual([]);
    // Without CI workflows there is nothing to check against.
    expect(
      (await checkSpecs(await repo(files), DEFAULT_POLICY)).errors,
    ).toEqual([]);
    expect(
      ciRunsWithSwitch(
        [
          workflow(
            '      - name: Other\n        env:\n          BILLING_DB_TESTS: "1"',
          ),
        ],
        "tests/invoices.test.ts",
        "BILLING_DB_TESTS",
      ),
    ).toBe(false);
  });
});
