import { describe, it, expect } from "vitest";
import {
  changedVerificationConfig as changed,
  internals,
} from "../src/execution/verification-config.js";

// Seeded generators, no dependency. Override the seed to replay a failure:
//   PROPERTY_SEED=123 npm test -w @agile-graph/engine -- tests/property-verification-config.test.ts
const SEED = Number(process.env.PROPERTY_SEED ?? 20260417);
const CASES = 300;
const { tokenize, runnerTargets, pytestIniSections, pytestToml } = internals;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Random = () => number;
const int = (random: Random, below: number) => Math.floor(random() * below);
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[int(random, items.length)]!;
const chance = (random: Random, p: number) => random() < p;
const fail = (detail: string) =>
  `${detail}\n(replay with PROPERTY_SEED=${SEED})`;
function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items];
  for (let at = copy.length - 1; at > 0; at--) {
    const other = int(random, at + 1);
    [copy[at], copy[other]] = [copy[other]!, copy[at]!];
  }
  return copy;
}
const string = (random: Random, alphabet: string, max: number) =>
  Array.from({ length: int(random, max + 1) }, () =>
    pick(random, [...alphabet]),
  ).join("");
const word = (random: Random, alphabet: string, max: number) =>
  pick(random, [...alphabet]) + string(random, alphabet, max);

describe("property: command tokenizer", () => {
  it("never throws, and unquoted words hold no separator or quote", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = string(random, "abz \t\n\"'&|;()`=-/.", 60);
      let segments: ReturnType<typeof tokenize> = [];
      expect(
        () => (segments = tokenize(text)),
        fail(JSON.stringify(text)),
      ).not.toThrow();
      for (const segment of segments)
        for (const part of segment)
          if (!part.quoted)
            expect(part.text, fail(JSON.stringify(text))).toMatch(
              /^[^\s&|;()`"']+$/,
            );
    }
  });
  it("reads plain words joined by spaces as one segment of unquoted words", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const words = Array.from({ length: 1 + int(random, 6) }, () =>
        word(random, "abz=-/.", 8),
      );
      const text = words.join(pick(random, [" ", "  ", "\t", " \t "]));
      expect(tokenize(text), fail(JSON.stringify(text))).toEqual([
        words.map((part) => ({ text: part, quoted: false })),
      ]);
    }
  });
  it("reads a quoted word with inner spaces as one quoted word", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const inner = string(random, "abz  \t&|;()`-", 20);
      const quote = pick(random, ["'", '"']);
      const text = `${quote}${inner}${quote}`;
      expect(tokenize(text), fail(JSON.stringify(text))).toEqual([
        [{ text: inner, quoted: true }],
      ]);
    }
  });
});

describe("property: package-runner targets", () => {
  const RUNNER_NAMES = ["npm", "pnpm", "yarn"] as const;
  const NOT_RUNNERS = new Set(["npm", "pnpm", "yarn", "node", "run"]);
  const scriptName = (random: Random) => {
    for (;;) {
      const name =
        word(random, "abcdefghijklmnopqrstuvwxyz0123456789", 0) +
        string(random, "abcdefghijklmnopqrstuvwxyz0123456789:-", 10);
      if (!NOT_RUNNERS.has(name)) return name;
    }
  };
  // runner, options, run, script, optional `-- junk`
  function command(random: Random, withJunk = true) {
    const runner = pick(random, RUNNER_NAMES);
    const booleans = [...internals.BOOLEAN_OPTIONS];
    const values = [...internals.VALUE_OPTIONS[runner]!];
    const options: string[] = [];
    for (let count = int(random, 4); count > 0; count--)
      if (chance(random, 0.5)) options.push(pick(random, booleans));
      else
        options.push(
          pick(random, values),
          pick(random, ["a", "b", "dir", "x1"]),
        );
    const script = scriptName(random);
    const junk =
      withJunk && chance(random, 0.4)
        ? [
            "--",
            ...Array.from({ length: 1 + int(random, 3) }, () =>
              pick(random, ["x", "--foo", "bar", "-k", "y=1"]),
            ),
          ]
        : [];
    const run = pick(random, ["run", "run-script"]);
    return {
      text: [runner, ...options, run, script, ...junk].join(" "),
      script,
    };
  }
  it("finds the script of every generated invocation", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const { text, script } = command(random);
      expect(runnerTargets(text), fail(text)).toEqual({
        targets: [script],
        unresolved: false,
      });
    }
  });
  it("reads node --run in both spellings", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const script = scriptName(random);
      for (const text of [`node --run ${script}`, `node --run=${script}`])
        expect(runnerTargets(text), fail(text)).toEqual({
          targets: [script],
          unresolved: false,
        });
    }
  });
  it("composes over && and ; and reads a quoted command line", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const a = command(random);
      const b = command(random);
      const joined = runnerTargets(
        `${a.text} ${pick(random, ["&&", ";", "|", "||"])} ${b.text}`,
      );
      expect(joined.targets, fail(`${a.text} / ${b.text}`)).toEqual([
        a.script,
        b.script,
      ]);
      expect(joined.unresolved).toBe(false);
      expect(runnerTargets(`sh -c '${a.text}'`), fail(a.text)).toEqual({
        targets: [a.script],
        unresolved: false,
      });
      expect(runnerTargets(`sh -c "${b.text}"`), fail(b.text)).toEqual({
        targets: [b.script],
        unresolved: false,
      });
    }
  });
  it("cannot resolve an unknown option followed by a word", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const runner = pick(random, RUNNER_NAMES);
      const text = `${runner} --nope x run ${scriptName(random)}`;
      expect(runnerTargets(text).unresolved, fail(text)).toBe(true);
    }
  });
  it("never throws on arbitrary text", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = string(random, "npmyarnode run-s\"'&|;() \t\n`=-/.", 80);
      expect(
        () => runnerTargets(text),
        fail(JSON.stringify(text)),
      ).not.toThrow();
    }
  });
});

describe("property: pytest ini reader", () => {
  type Section = { header: string; pytest: boolean; lines: string[] };
  type Document = { prefix: string[]; sections: Section[] };
  const line = (random: Random) =>
    `${pick(random, ["addopts", "testpaths", "markers", "k"])}${int(random, 9)} = ${pick(random, ["-x", "a b", "1", "true", "-k nothing"])}`;
  const lines = (random: Random, count: number) =>
    Array.from({ length: count }, () =>
      chance(random, 0.15) ? "" : chance(random, 0.1) ? "# note" : line(random),
    );
  function document(random: Random): Document {
    const sections: Section[] = Array.from(
      { length: 1 + int(random, 4) },
      () => {
        const pytest = chance(random, 0.5);
        return {
          header: pytest
            ? pick(random, [
                "pytest",
                "tool:pytest",
                "tool.pytest",
                "pytest.extra",
              ])
            : pick(random, ["metadata", "flake8", "pytest2", "options"]),
          pytest,
          lines: lines(random, int(random, 5)),
        };
      },
    );
    if (!sections.some((section) => section.pytest))
      sections.push({
        header: "pytest",
        pytest: true,
        lines: lines(random, 2).concat(line(random)),
      });
    return { prefix: lines(random, int(random, 3)), sections };
  }
  // Only variation iniconfig ignores: line ending, trailing whitespace and a
  // trailing comment after a header. Leading indentation and spaces inside a
  // header change what pytest reads, so they are not generated.
  type Style = { eol: string; pad: () => string; note: () => string };
  const style = (random: Random): Style => ({
    eol: pick(random, ["\n", "\r\n"]),
    pad: () => pick(random, ["", " ", "\t", "  "]),
    note: () => pick(random, ["", " ; x", " # y"]),
  });
  function render(doc: Document, how: Style): string {
    const out = doc.prefix.map((text) => text + how.pad());
    for (const section of doc.sections) {
      out.push(`[${section.header}]${how.pad()}${how.note()}`);
      for (const text of section.lines) out.push(text + how.pad());
    }
    return out.join(how.eol) + how.eol;
  }
  it("never throws on arbitrary text", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = string(random, "[]pytest:. \t\r\n=#;ab", 80);
      expect(
        () => pytestIniSections(text),
        fail(JSON.stringify(text)),
      ).not.toThrow();
    }
  });
  it("is idempotent on its own output", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = render(document(random), style(random));
      const once = pytestIniSections(text);
      expect(pytestIniSections(once), fail(JSON.stringify(text))).toBe(once);
    }
  });
  it("ignores line endings, trailing whitespace and header comments", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const doc = document(random);
      const a = render(doc, style(random));
      const b = render(doc, style(random));
      expect(pytestIniSections(a), fail(JSON.stringify([a, b]))).toBe(
        pytestIniSections(b),
      );
      expect(changed("setup.cfg", a, b), fail(JSON.stringify([a, b]))).toBe(
        false,
      );
    }
  });
  it("ignores everything outside the pytest sections", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const doc = document(random);
      const other: Document = {
        prefix: lines(random, int(random, 3)),
        sections: doc.sections.map((section) =>
          section.pytest
            ? section
            : { ...section, lines: lines(random, int(random, 5)) },
        ),
      };
      const how = { ...style(random), note: () => "" };
      const a = render(doc, how);
      const b = render(other, how);
      expect(changed("setup.cfg", a, b), fail(JSON.stringify([a, b]))).toBe(
        false,
      );
    }
  });
  it("sees any changed or added line inside a pytest section", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const doc = document(random);
      const sections = doc.sections.filter((section) => section.pytest);
      const target = pick(random, sections);
      const edited: Document = {
        ...doc,
        sections: doc.sections.map((section) => {
          if (section !== target) return section;
          const copy = [...section.lines];
          if (copy.length && chance(random, 0.5)) {
            const at = int(random, copy.length);
            copy[at] = copy[at] + "x";
          } else copy.push(line(random));
          return { ...section, lines: copy };
        }),
      };
      const how = { ...style(random), note: () => "" };
      const a = render(doc, how);
      const b = render(edited, how);
      expect(changed("setup.cfg", a, b), fail(JSON.stringify([a, b]))).toBe(
        true,
      );
    }
  });
});

describe("property: pyproject.toml pytest reader", () => {
  const KEYS = [
    "addopts",
    "testpaths",
    "markers",
    "minversion",
    "xfail_strict",
    "filterwarnings",
    "python_files",
    "norecursedirs",
  ];
  type Leaf = { key: string; items: string[]; array: boolean };
  const scalar = (random: Random) =>
    pick(random, [
      () => String(int(random, 1000)),
      () => pick(random, ["true", "false"]),
      () => `"${string(random, "abcxyz 019-_=.", 8)}"`,
    ])();
  function leafValue(random: Random): Pick<Leaf, "items" | "array"> {
    if (chance(random, 0.7)) return { items: [scalar(random)], array: false };
    return {
      items: Array.from({ length: 1 + int(random, 3) }, () => scalar(random)),
      array: true,
    };
  }
  const signature = (leaf: Pick<Leaf, "items" | "array">) =>
    JSON.stringify([leaf.array, leaf.items]);
  function leaves(random: Random, count: number): Leaf[] {
    return shuffled(random, KEYS)
      .slice(0, count)
      .map((key) => ({ key, ...leafValue(random) }));
  }
  type Other = { header: string; key: string; value: string };
  const others = (random: Random): Other[] =>
    Array.from({ length: int(random, 3) }, (_, at) =>
      pick(random, [
        { header: "tool.other", key: `x${at}`, value: scalar(random) },
        { header: "project", key: `name${at}`, value: scalar(random) },
        { header: "tool.poetry", key: `v${at}`, value: scalar(random) },
      ]),
    ).filter(
      (entry, at, all) =>
        all.findIndex(
          (o) => o.header === entry.header && o.key === entry.key,
        ) === at,
    );

  // How one document is laid out: comments, blank lines, indentation, EOL.
  function decorate(random: Random, text: string, crlf: boolean): string {
    const out: string[] = [];
    for (const raw of text.split("\n")) {
      if (chance(random, 0.15)) out.push("");
      if (chance(random, 0.15))
        out.push(pick(random, ["# note", "  # a = [b", "#"]));
      let body = raw;
      if (body && chance(random, 0.15))
        body = pick(random, ["\t", "  "]) + body;
      if (body && !body.endsWith("[") && chance(random, 0.2))
        body += pick(random, [" # c", "\t# [x]", "  #"]);
      out.push(body);
    }
    const joined = out.join("\n");
    return crlf ? joined.replace(/\n/g, "\r\n") : joined;
  }
  const space = (random: Random) => pick(random, ["", " ", "  ", "\t"]);
  function dotted(random: Random, parts: string[], decorated: boolean): string {
    return parts
      .map((text) => {
        if (!decorated && !chance(random, 0.15)) return text;
        const quote = pick(random, ['"', "'"]);
        return quote + text + quote;
      })
      .join(
        decorated
          ? `${space(random)}.${space(random)}`
          : chance(random, 0.1)
            ? " . "
            : ".",
      );
  }
  const value = (random: Random, leaf: Leaf, multiline: boolean): string => {
    if (!leaf.array) return leaf.items[0]!;
    const sep = pick(random, [",", ", ", " , "]);
    const trailing = chance(random, 0.3) ? "," : "";
    if (multiline && chance(random, 0.4))
      return `[\n${leaf.items.map((item) => `  ${item}, ${chance(random, 0.3) ? "# i" : ""}`).join("\n")}\n]`;
    return `[${space(random)}${leaf.items.join(sep)}${trailing}${space(random)}]`;
  };
  const assign = (random: Random, keyText: string, text: string) => {
    const gap = space(random);
    return `${keyText}${gap}=${gap}${text}`;
  };

  const STYLES = 8;
  function render(
    index: number,
    random: Random,
    ast: Leaf[],
    other: Other[],
  ): string {
    const order = shuffled(random, ast);
    const table = (name: string[], decorated = false) =>
      `[${space(random)}${dotted(random, name, decorated)}${space(random)}]`;
    const inline = (inner: string[]) =>
      `{${space(random)}${inner.join(", ")}${space(random)}}`;
    const entries = (prefix: string[]) =>
      order.map((leaf) =>
        assign(
          random,
          dotted(random, [...prefix, leaf.key], false),
          value(random, leaf, true),
        ),
      );
    const inlineEntries = () =>
      order.map((leaf) =>
        assign(
          random,
          dotted(random, [leaf.key], false),
          value(random, leaf, false),
        ),
      );
    const body: string[] = [];
    let topLevel = false;
    switch (index) {
      case 0:
        body.push(table(["tool", "pytest", "ini_options"]), ...entries([]));
        break;
      case 1:
        body.push(table(["tool", "pytest"]), ...entries(["ini_options"]));
        break;
      case 2:
        body.push(table(["tool"]), ...entries(["pytest", "ini_options"]));
        break;
      case 3:
        topLevel = true;
        body.push(...entries(["tool", "pytest", "ini_options"]));
        break;
      case 4:
        topLevel = true;
        body.push(
          assign(
            random,
            dotted(random, ["tool", "pytest"], false),
            inline([assign(random, "ini_options", inline(inlineEntries()))]),
          ),
        );
        break;
      case 5:
        body.push(
          table(["tool", "pytest"]),
          assign(random, "ini_options", inline(inlineEntries())),
        );
        break;
      case 6:
        body.push(
          table(["tool", "pytest", "ini_options"], true),
          ...entries([]),
        );
        break;
      default:
        body.push(
          table(["tool"]),
          assign(
            random,
            "pytest",
            inline([assign(random, "ini_options", inline(inlineEntries()))]),
          ),
        );
    }
    const extra = other.map(
      (entry) => `[${entry.header}]\n${assign(random, entry.key, entry.value)}`,
    );
    const before = !topLevel && chance(random, 0.5);
    const text =
      (before ? [...extra, ...body] : [...body, ...extra]).join("\n") + "\n";
    return decorate(random, text, chance(random, 0.3));
  }

  it("never throws, and answers a string or undefined, on arbitrary text", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = string(random, "[]{}tool.pytest_ini\"'=,#\\ \t\r\n01a-", 80);
      let result: string | undefined;
      expect(
        () => (result = pytestToml(text)),
        fail(JSON.stringify(text)),
      ).not.toThrow();
      expect(["string", "undefined"]).toContain(typeof result);
      expect(changed("pyproject.toml", text, text + "\n#")).toBeTypeOf(
        "boolean",
      );
    }
  });
  it("never throws on a truncated or corrupted valid document", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = render(
        int(random, STYLES),
        random,
        leaves(random, 1 + int(random, 4)),
        others(random),
      );
      const cut = text.slice(0, int(random, text.length + 1));
      const hit = int(random, text.length);
      const corrupt =
        text.slice(0, hit) +
        pick(random, ['"', "[", "{", "\\", "=", "'''"]) +
        text.slice(hit + 1);
      for (const sample of [cut, corrupt])
        expect(
          () => pytestToml(sample),
          fail(JSON.stringify(sample)),
        ).not.toThrow();
    }
  });
  it("reads every spelling of the same settings as the same settings", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const ast = leaves(random, 1 + int(random, 4));
      const rest = others(random);
      const texts = Array.from({ length: STYLES }, (_, style) =>
        render(style, random, ast, rest),
      );
      const first = pytestToml(texts[0]!);
      expect(first, fail(JSON.stringify(texts[0]))).toBeTypeOf("string");
      texts.forEach((text, style) => {
        expect(
          pytestToml(text),
          fail(`style ${style} vs 0: ${JSON.stringify([text, texts[0]])}`),
        ).toBe(first);
      });
      const x = pick(random, texts);
      const y = pick(random, texts);
      expect(
        changed("pyproject.toml", x, y),
        fail(JSON.stringify([x, y])),
      ).toBe(false);
    }
  });
  it("sees any changed, added or removed setting under tool.pytest, in any spelling", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const ast = leaves(random, 1 + int(random, 4));
      const rest = others(random);
      const at = int(random, ast.length);
      const mutations: Record<string, Leaf[]> = {
        changed: ast.map((leaf, n) => {
          if (n !== at) return leaf;
          for (;;) {
            const next = leafValue(random);
            if (signature(next) !== signature(leaf))
              return { key: leaf.key, ...next };
          }
        }),
        added: [
          ...ast,
          {
            key: KEYS.find((key) => !ast.some((leaf) => leaf.key === key))!,
            ...leafValue(random),
          },
        ],
        removed: ast.filter((_, n) => n !== at),
      };
      for (const [name, next] of Object.entries(mutations))
        for (let x = 0; x < STYLES; x++)
          for (let y = 0; y < STYLES; y++) {
            const a = render(x, random, ast, rest);
            const b = render(y, random, next, rest);
            expect(
              changed("pyproject.toml", a, b),
              fail(`${name} ${x}->${y}: ${JSON.stringify([a, b])}`),
            ).toBe(true);
          }
    }
  });
  it("ignores any change outside tool.pytest", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const ast = leaves(random, 1 + int(random, 4));
      const rest = others(random);
      const next = rest.map((entry) =>
        chance(random, 0.6) ? { ...entry, value: scalar(random) } : entry,
      );
      next.push({ header: "tool.other", key: "added", value: scalar(random) });
      const x = int(random, STYLES);
      const y = int(random, STYLES);
      const a = render(x, random, ast, rest);
      const b = render(y, random, ast, next);
      expect(
        changed("pyproject.toml", a, b),
        fail(`${x}->${y}: ${JSON.stringify([a, b])}`),
      ).toBe(false);
    }
  });
});

describe("property: verification-config gate", () => {
  const FILES = [
    "package.json",
    "setup.cfg",
    "pyproject.toml",
    "vitest.config.ts",
    "src/data.txt",
    "pkg/package.json",
  ];
  it("never reports a change for identical text, and never throws", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = string(random, '{}[]":,=#\\ \n\tabtool.pytest01', 60);
      const other = string(random, '{}[]":,=#\\ \n\tabtool.pytest01', 60);
      for (const file of FILES) {
        expect(
          changed(file, text, text),
          fail(`${file} ${JSON.stringify(text)}`),
        ).toBe(false);
        expect(
          () => changed(file, text, other),
          fail(`${file} ${JSON.stringify([text, other])}`),
        ).not.toThrow();
      }
    }
  });
  it("answers the same in both directions for setup.cfg and pyproject.toml", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const a = string(random, "[]{}=.\n#abpytestool \"'01", 70);
      const b = chance(random, 0.5)
        ? a.replace(/pytest/g, "pytes")
        : string(random, "[]{}=.\n#abpytestool \"'01", 70);
      for (const file of ["setup.cfg", "pyproject.toml"])
        expect(
          changed(file, a, b),
          fail(`${file} ${JSON.stringify([a, b])}`),
        ).toBe(changed(file, b, a));
    }
  });
  it("sees a changed test script or runner key in package.json, not a changed name, version or dependency", () => {
    const random = mulberry32(SEED);
    const manifest = (parts: Record<string, unknown>) =>
      JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          scripts: { test: "vitest", build: "tsc" },
          dependencies: { left: "1.0.0" },
          ...parts,
        },
        null,
        2,
      );
    for (let index = 0; index < CASES; index++) {
      const text = "q" + word(random, "abz", 6);
      const script = pick(random, [
        "test",
        "pretest",
        "check",
        "verify:fast",
        "posttest",
      ]);
      const key = pick(random, ["jest", "vitest", "mocha", "ava", "nyc", "c8"]);
      const before = manifest({
        scripts: { test: "vitest", build: "tsc", [script]: "node a.js" },
      });
      expect(
        changed(
          "package.json",
          before,
          manifest({
            scripts: {
              test: "vitest",
              build: "tsc",
              [script]: `node ${text}.js`,
            },
          }),
        ),
        fail(script),
      ).toBe(true);
      expect(
        changed("package.json", manifest({}), manifest({ [key]: { a: text } })),
        fail(key),
      ).toBe(true);
      expect(
        changed(
          "package.json",
          manifest({}),
          manifest({ name: text, version: `${int(random, 9)}.0.0` }),
        ),
        fail(text),
      ).toBe(false);
      expect(
        changed(
          "package.json",
          manifest({}),
          manifest({
            dependencies: { left: `${int(random, 9)}.1.0`, [text]: "1.0.0" },
          }),
        ),
        fail(text),
      ).toBe(false);
      expect(
        changed(
          "package.json",
          manifest({}),
          manifest({ scripts: { test: "vitest", build: `tsc ${text}` } }),
        ),
        fail(text),
      ).toBe(false);
    }
  });
});
