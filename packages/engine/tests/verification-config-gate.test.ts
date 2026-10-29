import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, assertProjectPolicy } from "@agile-graph/contracts";
import { applyProposal } from "../src/execution/workspace.js";
import { changedVerificationConfig } from "../src/execution/verification-config.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vconf-gate-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
const edit = (
  root: string,
  file: string,
  before: string,
  after: string,
  policy = DEFAULT_POLICY,
) =>
  applyProposal(
    root,
    { summary: "edit", requests: [], changes: [{ path: file, before, after }] },
    policy,
  );
const pkg =
  '{\n  "scripts": {\n    "test": "vitest run",\n    "build": "tsc"\n  }\n}\n';

describe("verification configuration gate", () => {
  it("refuses a patch that edits the test runner config", async () => {
    const original = "export default { test: { include: ['a.test.ts'] } };\n";
    const root = await workspace({ "vitest.config.ts": original });
    await expect(
      edit(root, "vitest.config.ts", "['a.test.ts']", "[]"),
    ).rejects.toThrow(
      /Verification configuration needs approval: vitest\.config\.ts/,
    );
    expect(await readFile(path.join(root, "vitest.config.ts"), "utf8")).toBe(
      original,
    );
  });
  it("refuses a patch that edits a test script entry", async () => {
    const root = await workspace({ "package.json": pkg });
    await expect(
      edit(root, "package.json", '"vitest run"', '"true"'),
    ).rejects.toThrow(
      /Verification configuration needs approval: package\.json/,
    );
  });
  it("refuses a created runner config", async () => {
    const root = await workspace({});
    await expect(
      applyProposal(
        root,
        {
          summary: "create",
          requests: [],
          changes: [{ path: "pkg/jest.config.js", before: null, after: "{}" }],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow(/pkg\/jest\.config\.js/);
  });
  it("refuses a created package-manager rc file", async () => {
    const root = await workspace({});
    await expect(
      applyProposal(
        root,
        {
          summary: "create",
          requests: [],
          changes: [
            {
              path: ".npmrc",
              before: null,
              after: "script-shell=/usr/bin/true",
            },
          ],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow(/Verification configuration needs approval: \.npmrc/);
    expect(
      changedVerificationConfig(".yarnrc.yml", "", "yarnPath: x.cjs"),
    ).toBe(true);
    expect(changedVerificationConfig(".pnpmfile.cjs", "", "x")).toBe(true);
  });
  it("matches only pytest's own dotted keys, not a package named pytest-*", () => {
    const poetry = (v: string) =>
      `[tool.poetry.group.dev.dependencies]\npytest-cov = "${v}"\n`;
    expect(
      changedVerificationConfig("pyproject.toml", poetry("^4"), poetry("^5")),
    ).toBe(false);
    expect(
      changedVerificationConfig(
        "pyproject.toml",
        "[tool]\npytest.ini_options.addopts = 'a'\n",
        "[tool]\npytest.ini_options.addopts = 'b'\n",
      ),
    ).toBe(true);
  });
  it("accepts a source-only patch and a non-test package.json edit", async () => {
    const root = await workspace({
      "src/a.ts": "export const a = 1;\n",
      "package.json": pkg,
    });
    await expect(edit(root, "src/a.ts", "1", "2")).resolves.toEqual([
      "src/a.ts",
    ]);
    await expect(
      edit(root, "package.json", '"tsc"', '"tsc -p ."'),
    ).resolves.toEqual(["package.json"]);
  });
  it("accepts a path a person approved in the policy", async () => {
    const root = await workspace({
      "vitest.config.ts": "export default { test: { retry: 0 } };\n",
    });
    const policy = {
      ...DEFAULT_POLICY,
      approvedVerificationConfigPaths: ["vitest.config.ts"],
    };
    await expect(
      edit(root, "vitest.config.ts", "retry: 0", "retry: 1", policy),
    ).resolves.toEqual(["vitest.config.ts"]);
    // Approval covers only the named path.
    const other = await workspace({ "jest.config.js": "{}\n" });
    await expect(
      edit(other, "jest.config.js", "{}", "{ }", policy),
    ).rejects.toThrow(/jest\.config\.js/);
  });
  it("reads each config shape and ignores malformed input", () => {
    const changed = (file: string, before: string, after: string) =>
      changedVerificationConfig(file, before, after);
    expect(changed("tox.ini", "a", "b")).toBe(true);
    expect(changed("tox.ini", "a", "a")).toBe(false);
    expect(changed(".pytest.ini", "", "[pytest]")).toBe(true);
    expect(changed("pytest.toml", "", "x")).toBe(true);
    expect(changed("Vitest.Config.TS", "a", "b")).toBe(true);
    expect(
      changed(
        "pyproject.toml",
        "[project]\nname='a'\n",
        "tool.pytest.ini_options.addopts = '-x'\n[project]\nname='a'\n",
      ),
    ).toBe(true);
    expect(
      changed(
        "pyproject.toml",
        'dependencies = ["pytest>=7"]\n',
        'dependencies = ["pytest>=8"]\n',
      ),
    ).toBe(false);
    expect(changed("sub/conftest.py", "", "x")).toBe(true);
    expect(
      changed(
        "pyproject.toml",
        "[tool.pytest.ini_options]\naddopts = '-x'\n",
        "[tool.pytest.ini_options]\naddopts = ''\n",
      ),
    ).toBe(true);
    expect(
      changed(
        "pyproject.toml",
        "[project]\nname='a'\n",
        "[project]\nname='b'\n",
      ),
    ).toBe(false);
    expect(changed("package.json", pkg, pkg.replace("vitest run", "x"))).toBe(
      true,
    );
    expect(changed("package.json", pkg, pkg.replace("tsc", "x"))).toBe(false);
    expect(changed("package.json", "{bad", "{bad2")).toBe(false);
    expect(changed("src/a.ts", "a", "b")).toBe(false);
    const plain = '{"scripts":{"test":"vitest run"}}';
    const weak = '{"scripts":{"test":"true"}}';
    // npm strips a leading BOM, so it must not hide an edit.
    expect(changed("package.json", plain, "\uFEFF" + weak)).toBe(true);
    expect(changed("package.json", "\uFEFF" + plain, weak)).toBe(true);
    // Readable before, unreadable after: fail closed.
    expect(changed("package.json", plain, "{bad")).toBe(true);
  });
  it("refuses an edit to a script a test or check script runs", async () => {
    const chained =
      '{"scripts":{"check":"npm run typecheck && npm test","typecheck":"tsc","test":"vitest run","docs":"x"}}';
    expect(
      changedVerificationConfig(
        "package.json",
        chained,
        chained.replace('"tsc"', '"true"'),
      ),
    ).toBe(true);
    // Dropping the reference and editing the target in one patch is caught.
    expect(
      changedVerificationConfig(
        "package.json",
        chained,
        chained.replace("npm run typecheck && ", "").replace('"tsc"', '"true"'),
      ),
    ).toBe(true);
    expect(
      changedVerificationConfig(
        "package.json",
        chained,
        chained.replace('"x"', '"y"'),
      ),
    ).toBe(false);
    // pre and post hooks of a reached script run inside the check.
    expect(
      changedVerificationConfig(
        "package.json",
        chained,
        chained.replace('"docs"', '"pretypecheck":"sh ./n.sh","docs"'),
      ),
    ).toBe(true);
    const loop = '{"scripts":{"test":"npm run test"}}';
    expect(changedVerificationConfig("package.json", loop, loop + " ")).toBe(
      false,
    );
    const root = await workspace({ "package.json": chained });
    await expect(edit(root, "package.json", '"tsc"', '"true"')).rejects.toThrow(
      /Verification configuration needs approval: package\.json/,
    );
  });
  it("validates the approval list in a policy", () => {
    const policy = (paths: unknown) => ({
      ...DEFAULT_POLICY,
      approvedVerificationConfigPaths: paths,
    });
    expect(() => assertProjectPolicy(policy(["a/b.config.ts"]))).not.toThrow();
    expect(() => assertProjectPolicy(policy(["a/../b"]))).toThrow();
    expect(() => assertProjectPolicy(policy([1]))).toThrow();
  });
});
