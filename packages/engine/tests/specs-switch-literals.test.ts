import { describe, expect, it } from "vitest";
import { testSwitch } from "../src/specs.js";

// #319: code written inside a string, template or comment neither gates a
// test nor encloses one, so switch detection reads only real structure.
// One open brace, so a later real closing brace would pair with it.
const gate = 'describe.runIf(process.env.A === "1")("a", () => {';

describe("environment switches inside literals (#319)", () => {
  it.each([
    {
      label: "a single-quoted string",
      wrapped: `const s = '${gate.replaceAll("'", "\\'")}';`,
    },
    { label: "a template literal", wrapped: `const s = \`${gate}\`;` },
    { label: "a block comment", wrapped: `/* ${gate} */` },
  ])("ignores a gated describe written inside $label", ({ wrapped }) => {
    const text = `function f() {\n${wrapped}\nit("target", () => {});\n}\n`;
    expect(testSwitch(text, "target")).toBeUndefined();
  });

  it("ignores a test name written inside a string in a gated block", () => {
    const text = [
      `describe.runIf(process.env.A === "1")("a", () => {`,
      `  const note = 'it("target", () => {})';`,
      `});`,
      `it("target", () => {});`,
    ].join("\n");
    expect(testSwitch(text, "target")).toBeUndefined();
  });

  it("ignores braces inside strings when pairing a gated block", () => {
    const text = [
      `describe.runIf(process.env.A === "1")("a", () => {`,
      `  const close = "}";`,
      `  it("target", () => {});`,
      `});`,
    ].join("\n");
    expect(testSwitch(text, "target")).toBe("A");
  });

  it("ignores braces inside regex literals but not division", () => {
    const text = [
      `describe.runIf(process.env.A === "1")("a", () => {`,
      `  const brace = /}/, half = total / 2, ratio = (a / b) * 2;`,
      `  it("target", () => {});`,
      `});`,
    ].join("\n");
    expect(testSwitch(text, "target")).toBe("A");
  });

  it("reads a comment opener inside a regex literal as part of the regex", () => {
    const text = [
      `describe.runIf(process.env.A === "1")("a", () => {`,
      `  it("target", () => {});`,
      `  const pattern = /[/*]/;`,
      `});`,
    ].join("\n");
    expect(testSwitch(text, "target")).toBe("A");
  });

  it("reads a slash after a postfix increment as division", () => {
    const text = [
      `describe.runIf(process.env.A === "1")("a", () => {`,
      `  counter++ / 2; it("target", () => {}); const ratio = a / b;`,
      `});`,
    ].join("\n");
    expect(testSwitch(text, "target")).toBe("A");
  });
});
