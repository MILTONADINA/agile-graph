import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import { applyProposal } from "../src/execution/workspace.js";
import {
  dependencyNames,
  newDependencies,
} from "../src/execution/dependencies.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dep-gate-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
const edit = (root: string, file: string, before: string, after: string) =>
  applyProposal(
    root,
    { summary: "edit", requests: [], changes: [{ path: file, before, after }] },
    DEFAULT_POLICY,
  );

describe("new dependency gate", () => {
  it("refuses an added npm dependency and names it", async () => {
    const original =
      '{\n  "dependencies": {\n    "left-pad": "1.0.0"\n  }\n}\n';
    const root = await workspace({ "package.json": original });
    await expect(
      edit(
        root,
        "package.json",
        '"left-pad": "1.0.0"',
        '"left-pad": "1.0.0",\n    "totally-new-pkg": "^1.0.0"',
      ),
    ).rejects.toThrow(
      /New dependency needs approval: package\.json adds totally-new-pkg/,
    );
    expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(
      original,
    );
  });
  it("refuses an added Python dependency", async () => {
    const root = await workspace({ "requirements-dev.txt": "requests==2.0\n" });
    await expect(
      edit(
        root,
        "requirements-dev.txt",
        "requests==2.0\n",
        "requests==2.0\nrequestz>=1\n",
      ),
    ).rejects.toThrow(
      /requirements-dev\.txt adds requestz.*A new dependency needs/,
    );
  });
  it("refuses a created manifest that lists dependencies", async () => {
    const root = await workspace({});
    await expect(
      applyProposal(
        root,
        {
          summary: "create",
          requests: [],
          changes: [
            {
              path: "sub/go.mod",
              before: null,
              after: "module toy\n\nrequire example.com/new v1.0.0\n",
            },
          ],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow(/sub\/go\.mod adds example\.com\/new/);
  });
  it("allows a version bump of an existing name", async () => {
    const root = await workspace({
      "package.json": '{"dependencies":{"left-pad":"1.0.0"}}',
      "requirements.txt": "Flask_Login==1.0\n",
    });
    await expect(
      edit(root, "package.json", '"1.0.0"', '"2.0.0"'),
    ).resolves.toEqual(["package.json"]);
    await expect(
      edit(root, "requirements.txt", "==1.0", "==2.0 ; python_version>'3'"),
    ).resolves.toEqual(["requirements.txt"]);
  });
  it("allows removing a dependency", async () => {
    const root = await workspace({
      "package.json": '{"dependencies":{"a":"1","b":"1"}}',
    });
    await expect(edit(root, "package.json", '"a":"1",', "")).resolves.toEqual([
      "package.json",
    ]);
  });
  it("leaves a patch to an unrelated file alone", async () => {
    const root = await workspace({ "src/a.js": "let a = 1;\n" });
    await expect(edit(root, "src/a.js", "1", "2")).resolves.toEqual([
      "src/a.js",
    ]);
  });
  it("reads each manifest format", () => {
    const names = (file: string, text: string) => [
      ...dependencyNames(file, text),
    ];
    expect(
      names(
        "package.json",
        '{"dependencies":{"a":"1"},"devDependencies":{"b":"1"},"name":"x"}',
      ),
    ).toEqual(["a", "b"]);
    expect(
      names("requirements.txt", "# c\n-r other.txt\nA_b==1 # x\nc[x]>=2\n"),
    ).toEqual(["a-b", "c"]);
    expect(
      names(
        "pyproject.toml",
        '[project]\nname = "t"\ndependencies = [\n  "alpha>=1",\n  "beta",\n]\n[project.optional-dependencies]\ndev = ["gamma"]\n[tool.poetry.dependencies]\npython = "^3.9"\ndelta = "^1"\n',
      ).sort(),
    ).toEqual(["alpha", "beta", "delta", "gamma"]);
    expect(
      names(
        "Cargo.toml",
        '[package]\nname = "t"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n[dev-dependencies.rand]\nversion = "0.8"\n',
      ).sort(),
    ).toEqual(["rand", "serde", "tokio"]);
    expect(
      names(
        "go.mod",
        "module t\n\ngo 1.21\n\nrequire (\n\texample.com/a v1.0.0\n\texample.com/b v1.0.0 // indirect\n)\nrequire example.com/c v1.0.0\n",
      ),
    ).toEqual(["example.com/a", "example.com/b", "example.com/c"]);
    expect(
      names(
        "pubspec.yaml",
        "name: t\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.0.0\ndev_dependencies:\n  test: ^1.0.0\n",
      ),
    ).toEqual(["flutter", "http", "test"]);
    expect(names("src/a.js", "anything")).toEqual([]);
    expect(
      newDependencies("package.json", "{bad", '{"dependencies":{"a":"1"}}'),
    ).toEqual(["a"]);
    expect(
      newDependencies("package.json", '{"dependencies":{"a":"1"}}', "{bad"),
    ).toEqual([]);
  });
});
