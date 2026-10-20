import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  clarifications,
  definesTest,
  parseSpec,
  planFromSpec,
  specTemplate,
  testSwitch,
  withoutComments,
} from "../src/specs.js";
import { decompositionSchema } from "../src/workers/plan.js";
import { proposalSchema } from "../src/workers/api.js";

// Seeded generators, no dependency. Replay a failure with
//   PROPERTY_SEED=123 npm test -w @agile-graph/engine -- tests/property-parsers.test.ts
const SEED = Number(process.env.PROPERTY_SEED ?? 20260417);
const CASES = 300;

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

const POLLUTION_KEYS = ["__proto__", "constructor", "prototype", "toString"];
const FRAGMENTS = [
  "# Title",
  "## Problem",
  "## Acceptance criteria",
  "## Security considerations",
  "## Non-goals",
  "## __proto__",
  "## constructor",
  "## hasOwnProperty",
  "- ID: x",
  "- Status: ready",
  "- Area: a",
  "- Epic: e",
  "- __proto__: polluted",
  "- constructor: polluted",
  "- AC1: first",
  "- AC2: second",
  "  - Test: a/b.test.ts :: name",
  "  wrapped",
  "```",
  "````",
  "~~~",
  "```js",
  "[NEEDS CLARIFICATION: why?]",
  "<!-- c -->",
  "",
  " ",
  "\t",
  "\r",
  "é ​ \u0000 \u{1F600}",
  "- ",
  "## ",
  "#",
];
function specText(random: Random): string {
  const lines: string[] = [];
  for (let count = int(random, 30); count > 0; count--)
    lines.push(
      random() < 0.1
        ? String.fromCharCode(
            ...Array.from({ length: 8 }, () => int(random, 0x250)),
          )
        : pick(random, FRAGMENTS),
    );
  return lines.join(random() < 0.3 ? "\r\n" : "\n");
}

const pristine = () => ({}) as Record<string, unknown>;
function expectNoPollution() {
  const probe = pristine();
  expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);
  expect(probe["polluted"]).toBeUndefined();
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain(
    "polluted",
  );
}

describe("spec parser properties", () => {
  it("never throws, is deterministic and leaves Object.prototype alone", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < CASES; index++) {
      const text = specText(random);
      const first = parseSpec("specs/x.md", text);
      expect(parseSpec("specs/x.md", text)).toEqual(first);
      expect(first.criteria.every((c) => /^AC\d+$/.test(c.id))).toBe(true);
      expect(Object.getPrototypeOf(first.sections)).toBe(Object.prototype);
      for (const spec of [first]) {
        expect(typeof spec.title).toBe("string");
        expect(typeof spec.id).toBe("string");
      }
      expectNoPollution();
      // The helpers built on a parsed spec fail only with a plain Error.
      clarifications(first);
      try {
        planFromSpec(first);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  it("treats a __proto__ heading or field as data, not as a prototype", () => {
    const spec = parseSpec(
      "specs/x.md",
      [
        "# T",
        "- __proto__: polluted",
        "- ID: ok",
        "## __proto__",
        "- AC1: stays out",
        "## Acceptance criteria",
        "- AC1: real",
      ].join("\n"),
    );
    expect(spec.id).toBe("ok");
    expect(spec.criteria.map((c) => c.text)).toEqual(["real"]);
    expect(Object.getPrototypeOf(spec.sections)).toBe(Object.prototype);
    expect(Object.hasOwn(spec.sections, "__proto__")).toBe(true);
    expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
  });

  it("round-trips specTemplate output for random ids, areas and titles", () => {
    const random = mulberry32(SEED + 1);
    const slug = () => {
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
      let value = pick(random, [..."abcdefghijklmnopqrstuvwxyz0123456789"]);
      for (let count = int(random, 12); count > 0; count--)
        value += pick(random, [...alphabet]);
      return value;
    };
    for (let index = 0; index < CASES; index++) {
      const title = `T ${slug()} é`;
      const options = {
        id: slug(),
        area: slug(),
        title,
        ...(random() < 0.5 ? { epic: `Epic ${slug()}` } : {}),
      };
      const spec = parseSpec("specs/x.md", specTemplate(options));
      expect(spec.title).toBe(title);
      expect(spec.id).toBe(options.id);
      expect(spec.area).toBe(options.area);
      expect(spec.status).toBe("draft");
      expect(spec.epic).toBe(options.epic);
      expect(spec.criteria.map((c) => c.id)).toEqual(["AC1"]);
    }
  });

  it("template refusals use a plain Error for any title or id", () => {
    const random = mulberry32(SEED + 2);
    for (let index = 0; index < CASES; index++) {
      const text = specText(random);
      try {
        specTemplate({ id: text, area: text, title: text });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});

describe("test-source scanners never throw on arbitrary text", () => {
  it("withoutComments keeps length and line breaks", () => {
    const random = mulberry32(SEED + 3);
    const pieces = [
      "//",
      "/*",
      "*/",
      '"',
      "'",
      "`",
      "\\",
      "\n",
      "x",
      "**/*.md",
      "${",
      "}",
      "it(",
      " ",
      "é",
    ];
    for (let index = 0; index < CASES; index++) {
      let text = "";
      for (let count = int(random, 40); count > 0; count--)
        text += pick(random, pieces);
      const stripped = withoutComments(text);
      expect(stripped.split("\n").length).toBe(text.split("\n").length);
      definesTest(text, "x");
      testSwitch(text, "x");
    }
  });
});

describe("plan and proposal JSON properties", () => {
  const JSON_ATOMS = [
    "null",
    "true",
    "0",
    "-1.5e300",
    '""',
    '"x"',
    "[]",
    "{}",
    "[[]]",
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{}}}',
    '{"rationale":"r","steps":[]}',
    "nope",
    "{",
    '"\\ud800"',
    "",
  ];
  function jsonText(random: Random): string {
    if (random() < 0.5) return pick(random, JSON_ATOMS);
    const key = pick(random, [
      "rationale",
      "steps",
      "__proto__",
      "summary",
      "changes",
      "requests",
    ]);
    return `{"${key}":${pick(random, JSON_ATOMS)},"${pick(random, POLLUTION_KEYS)}":${pick(random, JSON_ATOMS)}}`;
  }

  it("rejects arbitrary text with SyntaxError or ZodError only", () => {
    const random = mulberry32(SEED + 4);
    for (let index = 0; index < CASES; index++) {
      const text = jsonText(random);
      for (const schema of [decompositionSchema, proposalSchema]) {
        try {
          schema.parse(JSON.parse(text));
        } catch (error) {
          expect(
            error instanceof SyntaxError || error instanceof ZodError,
          ).toBe(true);
        }
      }
      expectNoPollution();
    }
  });

  it("refuses a __proto__ key in a step and does not pollute", () => {
    const text =
      '{"rationale":"r","steps":[{"id":"a","objective":"o","dependsOn":[],"__proto__":{"polluted":true}}]}';
    expect(decompositionSchema.safeParse(JSON.parse(text)).success).toBe(false);
    const proposal =
      '{"summary":"s","changes":[{"path":"p","before":null,"after":"","__proto__":{"polluted":1}}],"requests":[]}';
    expect(proposalSchema.safeParse(JSON.parse(proposal)).success).toBe(false);
    expectNoPollution();
  });

  it("round-trips generated valid decompositions and proposals", () => {
    const random = mulberry32(SEED + 5);
    const id = (n: number) => `s${n}-${int(random, 1000)}`;
    for (let index = 0; index < CASES; index++) {
      const count = 1 + int(random, 12);
      const decomposition = {
        rationale: String.fromCharCode(
          ...Array.from(
            { length: int(random, 20) },
            () => 32 + int(random, 0x200),
          ),
        ),
        steps: Array.from({ length: count }, (_, n) => ({
          id: id(n),
          objective: `do ${n} é`,
          dependsOn: n ? [id(n - 1)] : [],
          covers: random() < 0.5 ? ["AC1"] : [],
        })),
      };
      const parsed = decompositionSchema.parse(
        JSON.parse(JSON.stringify(decomposition)),
      );
      expect(parsed).toEqual(decomposition);
      const proposal = {
        summary: "s",
        changes: Array.from({ length: int(random, 5) }, (_, n) => ({
          path: `a/${n}.ts`,
          before: random() < 0.5 ? null : "x",
          after: "y\n",
        })),
        requests: [],
      };
      expect(
        proposalSchema.parse(JSON.parse(JSON.stringify(proposal))),
      ).toEqual(proposal);
    }
  });
});
