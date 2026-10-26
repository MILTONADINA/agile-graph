// Reads the README's Install quick start so a test and the npm smoke share
// one source: the commands users are told to run and the Node range.

/** The text of the first sh block under the Install heading. */
function installBlock(readme) {
  const section = /^## Install\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme);
  return section ? /```sh\n([\s\S]*?)```/.exec(section[1])?.[1] : undefined;
}

/**
 * Parses the Install section. Each `graph-engine -C <path> ...` line becomes
 * { line, args } with the path left out, so a caller supplies its own.
 */
export function quickstart(readme) {
  const block = installBlock(readme);
  if (block === undefined)
    throw new Error("README.md has no sh block under the Install heading");
  const commands = [];
  for (const line of block.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "graph-engine") continue;
    if (words[1] !== "-C" || words.length < 4)
      throw new Error(
        `README line is not "graph-engine -C <path> ...": ${line}`,
      );
    commands.push({ line: line.trim(), args: words.slice(3) });
  }
  const sentence = /You need (Node\.js .*?) and Git\./.exec(
    readme.replace(/\s+/g, " "),
  )?.[1];
  return { commands, sentence };
}

/** The README wording of an `engines.node` range such as "^22.18.0 || >=24 <27". */
export function nodeSentence(range) {
  const match = /^\^(\d+)\.(\d+)\.\d+ \|\| >=(\d+) <(\d+)$/.exec(range);
  if (!match) throw new Error(`unsupported engines.node range: ${range}`);
  const [, major, minor, from, below] = match;
  return `Node.js ${major} (${major}.${minor} or later) or ${from} to ${below - 1}`;
}

/**
 * Problems with the quick start, as messages. helpOf(subcommand) returns the
 * built CLI's help for a subcommand, or throws when it does not exist.
 */
export function checkQuickstart(readme, { helpOf, nodeRange }) {
  const problems = [];
  let parsed;
  try {
    parsed = quickstart(readme);
  } catch (error) {
    return [error.message];
  }
  for (const { line, args } of parsed.commands) {
    const [subcommand, ...rest] = args;
    let help;
    try {
      help = helpOf(subcommand);
    } catch {
      problems.push(`${line}: the CLI has no subcommand ${subcommand}`);
      continue;
    }
    for (const flag of rest.filter((word) => word.startsWith("-")))
      if (!new RegExp(`(^|[\\s,])${flag}([\\s,<\\[=]|$)`, "m").test(help))
        problems.push(`${line}: ${subcommand} has no option ${flag}`);
  }
  if (parsed.commands.length === 0)
    problems.push("the Install block has no graph-engine command");
  const expected = nodeSentence(nodeRange);
  if (parsed.sentence !== expected)
    problems.push(
      `README Node range is "${parsed.sentence}", engines.node says "${expected}"`,
    );
  return problems;
}
