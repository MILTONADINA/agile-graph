import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(path.join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [path.join(dir, entry.name)]
        : [],
  );
}

/** The method chain that follows the closing parenthesis at `close`. */
function chainAfter(text: string, close: number): string {
  let i = close + 1;
  let chain = "";
  for (;;) {
    const rest = text.slice(i);
    const next = /^\s*\.([A-Za-z]+)\(/.exec(rest);
    if (!next) return chain;
    let depth = 0;
    let j = i + next[0].length - 1;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    chain += `.${next[1]}(`;
    i = j + 1;
  }
}

it("installs zod 4.6.6 or later, which closes GHSA-mrhx-c7xc-m3w5", () => {
  const require = createRequire(import.meta.url);
  const { version } = require("zod/package.json") as { version: string };
  const [major, minor, patch] = version.split(".").map(Number);
  expect(major).toBe(4);
  expect(minor! > 6 || (minor === 6 && patch! >= 6)).toBe(true);
  const manifest = JSON.parse(
    readFileSync(path.join(here, "..", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  expect(manifest.dependencies.zod).toMatch(/^\^4\.6\.[6-9]|^\^4\.[7-9]/);
});

it("bounds every array schema with an explicit maximum or exact length", () => {
  const unbounded: string[] = [];
  for (const file of sourceFiles(source)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bz\s*\.array\(/g)) {
      let depth = 0;
      let close = match.index! + match[0].length - 1;
      for (; close < text.length; close++) {
        if (text[close] === "(") depth++;
        else if (text[close] === ")" && --depth === 0) break;
      }
      const chain = chainAfter(text, close);
      if (!/\.(max|length)\(/.test(chain)) {
        const line = text.slice(0, match.index).split("\n").length;
        unbounded.push(`${path.relative(source, file)}:${line}`);
      }
    }
  }
  expect(unbounded).toEqual([]);
});
