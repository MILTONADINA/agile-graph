import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import { checkSpecs } from "../src/specs.js";

// #274: only a missing .github/workflows directory means "no CI". These
// cases live in their own file because spec-check reads this file's tests
// for environment switches, and specs.test.ts holds deliberately unbalanced
// switched blocks inside string literals.
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "graph-specs-workflows-"));
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

describe("CI workflows spec-check cannot read (#274)", () => {
  const unrunError =
    'specs/billing/invoice-list.md: AC2 links only tests that no CI step runs: "refuses anonymous users" (needs BILLING_DB_TESTS=1)';
  const switchedFiles = () => ({
    "specs/billing/invoice-list.md": spec({}),
    "tests/invoices.test.ts": gated,
  });
  const runsSwitch = workflow(
    [
      "      - name: Billing database",
      "        run: npm test -- --run tests/invoices.test.ts",
      "        env:",
      '          BILLING_DB_TESTS: "1"',
    ].join("\n"),
  );

  it("reports a workflows path that is a regular file and does not count the switched test", async () => {
    const root = await repo({
      ...switchedFiles(),
      ".github/workflows": "not a directory\n",
    });
    const { errors } = await checkSpecs(root, DEFAULT_POLICY);
    expect(errors).toContainEqual(
      expect.stringMatching(/^\.github\/workflows: cannot be read \(ENOTDIR\)/),
    );
    expect(errors).toContain(unrunError);
  });

  it("reports a dangling workflow link and does not count the switched test", async () => {
    const root = await repo({
      ...switchedFiles(),
      ".github/workflows/ci.yml": workflow(""),
    });
    await symlink(
      path.join(root, "missing.yml"),
      path.join(root, ".github/workflows/old.yml"),
    );
    const { errors } = await checkSpecs(root, DEFAULT_POLICY);
    expect(errors).toContainEqual(
      expect.stringMatching(
        /^\.github\/workflows\/old\.yml: cannot be read \(ENOENT\)/,
      ),
    );
    expect(errors).toContain(unrunError);
  });

  it("reports an unreadable workflow entry but still counts a readable one that runs the switch", async () => {
    const root = await repo({
      ...switchedFiles(),
      ".github/workflows/ci.yml": runsSwitch,
      ".github/workflows/broken.yml/placeholder": "",
    });
    const { errors } = await checkSpecs(root, DEFAULT_POLICY);
    expect(errors).toEqual([
      expect.stringMatching(
        /^\.github\/workflows\/broken\.yml: cannot be read \(EISDIR\)/,
      ),
    ]);
  });

  it("still treats a repository without .github as having no CI to check", async () => {
    const root = await repo(switchedFiles());
    expect((await checkSpecs(root, DEFAULT_POLICY)).errors).toEqual([]);
  });
});
