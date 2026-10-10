/**
 * Simple, deterministic, language-agnostic mutants of a source file, for
 * checking that a tester's tests notice a change in behaviour. Each mutant
 * changes one operator or one return value on one line. Lines with no
 * executable code (blank, comment-only, import or package lines, braces)
 * are never mutated, which keeps out the most common equivalent mutants.
 */
export interface Mutant {
  path: string;
  /** 1-based line number. */
  line: number;
  /** What changed, naming operators only: never the line's text. */
  description: string;
  /** The whole mutated file. */
  content: string;
}

// Each operator, the one it becomes, and characters that may not touch it,
// so `=>`, `->`, `<<`, `>>`, `++`, `+=`, `**`, `//`, `/*` and `*/` are left
// alone.
const OPERATORS: readonly {
  from: string;
  to: string;
  pattern: RegExp;
}[] = [
  { from: "===", to: "!==", pattern: /(?<![=!<>])===(?!=)/g },
  { from: "!==", to: "===", pattern: /!==(?!=)/g },
  { from: "==", to: "!=", pattern: /(?<![=!<>])==(?!=)/g },
  { from: "!=", to: "==", pattern: /!=(?!=)/g },
  { from: "<=", to: "<", pattern: /(?<![<=])<=(?![=>])/g },
  { from: ">=", to: ">", pattern: /(?<![>=-])>=(?!=)/g },
  { from: "<", to: "<=", pattern: /(?<![<=\w])<(?![<=>/\w])/g },
  { from: ">", to: ">=", pattern: /(?<![>=\-/\w])>(?![>=])/g },
  { from: "&&", to: "||", pattern: /&&/g },
  { from: "||", to: "&&", pattern: /\|\|/g },
  { from: "+", to: "-", pattern: /(?<=\s)\+(?=\s)/g },
  { from: "-", to: "+", pattern: /(?<=\s)-(?=\s)/g },
  { from: "*", to: "/", pattern: /(?<=\s)\*(?=\s)/g },
  { from: "/", to: "*", pattern: /(?<=\s)\/(?=\s)/g },
];

const NOT_EXECUTABLE =
  /^(?:$|\/\/|#|\/\*|\*|--|import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|package\b|using\b|require\(|[{}()[\];,]+$)/;

/** Whether a line has no executable code worth mutating. */
export function notExecutable(line: string): boolean {
  return NOT_EXECUTABLE.test(line.trim());
}

// String literals are blanked before matching, so an operator inside a
// string is never counted; the mutation still edits the original line at
// the same offset.
function blankStrings(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (match) =>
    " ".repeat(match.length),
  );
}

/**
 * The mutants of one file, in line order, then operator order, at most
 * `limit` of them.
 */
export function generateMutants(
  file: string,
  content: string,
  limit = Number.POSITIVE_INFINITY,
): Mutant[] {
  const lines = content.split("\n");
  const mutants: Mutant[] = [];
  const mutate = (index: number, replacement: string, description: string) => {
    const copy = [...lines];
    copy[index] = replacement;
    mutants.push({
      path: file,
      line: index + 1,
      description,
      content: copy.join("\n"),
    });
  };
  for (const [index, line] of lines.entries()) {
    if (mutants.length >= limit) break;
    if (notExecutable(line)) continue;
    const code = blankStrings(line);
    for (const { from, to, pattern } of OPERATORS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(code);
      if (!match) continue;
      mutate(
        index,
        line.slice(0, match.index) + to + line.slice(match.index + from.length),
        `replaced ${from} with ${to}`,
      );
    }
    const condition =
      /^(\s*(?:\}\s*else\s+)?(?:if|while)\s*\()(.*)\)(\s*\{?\s*)$/.exec(line);
    if (condition)
      mutate(
        index,
        `${condition[1]}!(${condition[2]}))${condition[3]}`,
        "negated the condition",
      );
    const returned = /^(\s*return\s+)(.+?)(;?\s*)$/.exec(line);
    if (returned && !/^(?:true|false|0|null|None|nil)$/.test(returned[2]!))
      mutate(index, `${returned[1]}0${returned[3]}`, "returned a constant 0");
  }
  return mutants.slice(0, limit);
}
