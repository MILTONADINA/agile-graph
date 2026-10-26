// The README's Install quick start must name commands the built CLI has and
// the Node range the package declares, so a rename cannot leave it stale.
// Run from a built checkout (npm run build).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkQuickstart, quickstart } from "./readme-quickstart.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(
  new URL("../packages/engine/dist/cli.js", import.meta.url),
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const { engines } = JSON.parse(
  await readFile(new URL("../packages/engine/package.json", import.meta.url)),
);

/** Help text of `graph-engine <subcommand>` from the built CLI; throws for an unknown one. */
const helpOf = (subcommand) =>
  execFileSync("node", [cli, subcommand, "--help"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GRAPH_ENGINE_NO_FEEDBACK: "1" },
  });
const options = { helpOf, nodeRange: engines.node };

test("the README quick start uses the init, index --lexical and serve commands", () => {
  const { commands } = quickstart(readme);
  assert.deepEqual(
    commands.map(({ args }) => args),
    [["init"], ["index", "--lexical"], ["serve"]],
  );
});

test("every README graph-engine command and flag exists in the built CLI", () => {
  assert.deepEqual(checkQuickstart(readme, options), []);
});

test("the README Node range sentence equals engines.node", () => {
  assert.match(engines.node, /\|\|/);
  assert.deepEqual(checkQuickstart(readme, options), []);
});

test("a renamed README command is reported", () => {
  const doctored = readme.replace(
    "graph-engine -C /path/to/your/project index --lexical",
    "graph-engine -C /path/to/your/project reindex --lexical",
  );
  assert.notEqual(doctored, readme);
  const problems = checkQuickstart(doctored, options);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reindex/);
});

test("a renamed README flag is reported", () => {
  const doctored = readme.replace("index --lexical", "index --lexicon");
  assert.notEqual(doctored, readme);
  assert.match(checkQuickstart(doctored, options).join("\n"), /--lexicon/);
});

test("a stale README Node range is reported", () => {
  const doctored = readme.replace("24 to 26", "24 to 25");
  assert.notEqual(doctored, readme);
  assert.match(checkQuickstart(doctored, options).join("\n"), /Node/);
});

test("a README without an Install quick start is reported", () => {
  assert.match(
    checkQuickstart("# Title\n\nNo install here.\n", options).join("\n"),
    /Install/,
  );
});
