// The name the CLI shows in its usage line: the basename of the invoked binary,
// so `agile-graph --help` says agile-graph and `graph-engine --help` says
// graph-engine. Any other name (for example `node dist/cli.js`) defaults to
// agile-graph.
export type UsageName = "agile-graph" | "graph-engine";

export function usageName(invokedPath: string | undefined): UsageName {
  const base = invokedPath?.split(/[\\/]/).pop();
  return base === "graph-engine" ? "graph-engine" : "agile-graph";
}
