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
  describe("pytest options in pyproject.toml, however they are spelled", () => {
    const changed = (before: string, after: string) =>
      changedVerificationConfig("pyproject.toml", before, after);
    const base = "[project]\nname = 'a'\n";
    it("sees a dotted key with spaces around the dots", () => {
      expect(
        changed(
          base,
          'tool . pytest . ini_options.addopts = "-k nothing"\n' + base,
        ),
      ).toBe(true);
    });
    it("decodes escapes in double-quoted keys", () => {
      const add = '["\\u0074ool".pytest.ini_options]\naddopts = "-k nothing"\n';
      expect(changed(base, base + add)).toBe(true);
      expect(
        changed(
          base,
          '"\\u0074ool".pytest.ini_options.addopts = "-k x"\n' + base,
        ),
      ).toBe(true);
      expect(
        changed(
          "[tool]\n",
          '[tool]\n"py\\u0074est" = { ini_options = { addopts = "-k x" } }\n',
        ),
      ).toBe(true);
    });
    it("sees a quoted or spaced table header", () => {
      expect(
        changed(
          base,
          base + '[ "tool" . "pytest" . ini_options ]\naddopts = "-k x"\n',
        ),
      ).toBe(true);
      expect(
        changed(base, base + "[ 'tool'.pytest ]\nini_options = {}\n"),
      ).toBe(true);
    });
    it("sees inline tables at any depth", () => {
      expect(
        changed(
          base,
          'tool = { pytest = { ini_options = { addopts = "-k x" } } }\n' + base,
        ),
      ).toBe(true);
      expect(
        changed(
          base + "[tool]\n",
          base + '[tool]\npytest = { ini_options = { addopts = "-k x" } }\n',
        ),
      ).toBe(true);
      expect(
        changed(
          base + "[tool.pytest]\nini_options = { addopts = '-x' }\n",
          base + "[tool.pytest]\nini_options = { addopts = '-y' }\n",
        ),
      ).toBe(true);
    });
    it("sees an edit to a continuation line of a multi-line value", () => {
      const v = (o: string) =>
        `tool.pytest.ini_options.addopts = [\n  "${o}",\n  "-q",\n]\n`;
      expect(changed(v("-x"), v("-k nothing"))).toBe(true);
      const t = (o: string) =>
        `tool.pytest.ini_options.addopts = """\n${o}\n"""\n` + base;
      expect(changed(t("-x"), t("-k nothing"))).toBe(true);
    });
    it("treats the same options spelled another way as unchanged", () => {
      expect(
        changed(
          "tool.pytest.ini_options.addopts = '-x'  # note\n" + base,
          base +
            "[tool.pytest.ini_options]\naddopts = '-x'\n[tool.other]\nx = 1\n",
        ),
      ).toBe(false);
    });
    it("leaves ordinary dependency bumps alone, including inline tables", () => {
      const dev = (v: string) =>
        base +
        `[tool.poetry.dev-dependencies]\npytest-cov = { version = "${v}", extras = ["a"] }\npytest = "^${v}"\n`;
      expect(changed(dev("4"), dev("5"))).toBe(false);
      const arr = (v: string) =>
        base +
        `[project.optional-dependencies]\ntest = [\n "pytest>=${v}",\n]\n`;
      expect(changed(arr("7"), arr("8"))).toBe(false);
    });
    it("fails closed when the file cannot be read", () => {
      expect(changed(base, base + 'tool.pytest.x = "unterminated\n')).toBe(
        true,
      );
      expect(changed(base, base + "tool.pytest.x = [1, 2\n")).toBe(true);
      expect(changed(base + "junk\n", base + "junk2\n")).toBe(true);
    });
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
  it("follows npm run, pnpm and yarn with option flags before the script", () => {
    for (const run of [
      "npm run -s unit",
      "npm run --silent unit",
      "npm --silent run unit",
      "yarn --silent unit",
      "pnpm -s run unit",
    ]) {
      const m = (u: string) =>
        JSON.stringify({ scripts: { test: run, unit: u } });
      expect(
        changedVerificationConfig("package.json", m("vitest run"), m("true")),
        run,
      ).toBe(true);
    }
  });
  it("refuses a weakened script in a workspace a root test script delegates to", async () => {
    const rootManifest = (run: string) =>
      JSON.stringify({ scripts: { test: run } });
    const child = (u: string) => JSON.stringify({ scripts: { unit: u } });
    for (const run of [
      "npm run unit --workspace child",
      "npm run unit -w child",
      "npm run unit --workspaces",
      "npm --prefix child run unit",
      "pnpm --filter child unit",
      "pnpm -r run unit",
      "yarn workspace child unit",
      "yarn workspace child run unit",
    ]) {
      expect(
        changedVerificationConfig(
          "child/package.json",
          child("vitest run"),
          child("true"),
          [rootManifest(run)],
        ),
        run,
      ).toBe(true);
    }
    // A script nothing reaches stays editable.
    expect(
      changedVerificationConfig(
        "child/package.json",
        JSON.stringify({ scripts: { docs: "a" } }),
        JSON.stringify({ scripts: { docs: "b" } }),
        [rootManifest("npm run unit -w child")],
      ),
    ).toBe(false);
    // Without the other manifests, a nested script change fails closed.
    expect(
      changedVerificationConfig(
        "child/package.json",
        child("vitest run"),
        child("true"),
      ),
    ).toBe(true);
    const root = await workspace({
      "package.json": rootManifest("npm run unit --workspace child"),
      "child/package.json": child("vitest run"),
      "other/package.json": JSON.stringify({ scripts: { docs: "a" } }),
    });
    await expect(
      edit(root, "child/package.json", '"vitest run"', '"true"'),
    ).rejects.toThrow(
      /Verification configuration needs approval: child\/package\.json/,
    );
    await expect(
      edit(root, "other/package.json", '"a"', '"b"'),
    ).resolves.toBeDefined();
  });
  it("resolves the script after value-taking options, else gates every script", () => {
    for (const run of [
      "npm run --script-shell /bin/sh unit",
      "npm --prefix . run unit",
      "pnpm --filter child run unit",
      "pnpm --dir . run unit",
      "yarn --cwd . run unit",
      "npm run -C . unit",
      "npm run --unknown-option value unit",
    ]) {
      const m = (u: string) =>
        JSON.stringify({ scripts: { test: run, unit: u, docs: "a" } });
      expect(
        changedVerificationConfig("package.json", m("vitest run"), m("true")),
        run,
      ).toBe(true);
    }
    // An invocation that cannot be resolved gates every script of the manifest.
    const m = (d: string) =>
      JSON.stringify({
        scripts: { test: "npm run --unknown-option value unit", docs: d },
      });
    expect(changedVerificationConfig("package.json", m("a"), m("b"))).toBe(
      true,
    );
  });
  it("reads runner invocations inside quoted commands", () => {
    for (const run of [
      'concurrently "npm run unit" "npm run lint"',
      "sh -c 'npm run unit --workspace child'",
      'concurrently "npm run lint && npm run unit"',
    ]) {
      const m = (u: string) =>
        JSON.stringify({ scripts: { test: run, unit: u, docs: "a" } });
      expect(
        changedVerificationConfig("package.json", m("vitest run"), m("true")),
        run,
      ).toBe(true);
    }
  });
  it("treats -w as pnpm's boolean workspace-root but npm's workspace value", () => {
    for (const run of [
      "pnpm -w unit",
      "pnpm -w run unit",
      "npm run -w child unit",
    ]) {
      const m = (u: string) =>
        JSON.stringify({ scripts: { test: run, unit: u, docs: "a" } });
      expect(
        changedVerificationConfig("package.json", m("vitest run"), m("true")),
        run,
      ).toBe(true);
      // Resolved, so an unrelated script stays editable.
      const d = (x: string) =>
        JSON.stringify({ scripts: { test: run, unit: "vitest run", docs: x } });
      expect(
        changedVerificationConfig("package.json", d("a"), d("b")),
        run,
      ).toBe(false);
    }
  });
  it("stops reading options at -- and after the script", () => {
    for (const run of [
      "npm run unit -- --reporter dot",
      "npm exec -w child -- vitest",
      "pnpm unit --reporter dot",
    ]) {
      const m = (x: string) =>
        JSON.stringify({ scripts: { test: run, unit: "vitest run", lint: x } });
      expect(
        changedVerificationConfig("package.json", m("a"), m("b")),
        run,
      ).toBe(false);
    }
  });
  it("follows node --run to a package.json script", () => {
    for (const run of ["node --run unit", "node --no-warnings --run unit"]) {
      const m = (u: string) =>
        JSON.stringify({ scripts: { test: run, unit: u } });
      expect(
        changedVerificationConfig("package.json", m("vitest run"), m("true")),
        run,
      ).toBe(true);
    }
  });
  it("gates karma.conf.js and .babelrc", () => {
    for (const f of ["karma.conf.js", ".babelrc", ".babelrc.json"])
      expect(changedVerificationConfig(f, "a", "b"), f).toBe(true);
  });
  it("reads a setup.cfg section header with a semicolon comment", () => {
    expect(
      changedVerificationConfig(
        "setup.cfg",
        "[metadata]\nname = a\n",
        "[metadata]\nname = a\n[tool:pytest] ; x\naddopts = -k nothing\n",
      ),
    ).toBe(true);
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
