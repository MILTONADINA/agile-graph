import { readFile } from "node:fs/promises";
import type {
  ProjectConfig,
  ProjectPolicy,
} from "@graph-engineering/contracts";
import { safePath } from "../policy.js";
import type { AddedFile, verifyInContainer } from "./docker.js";
import { generateMutants, type Mutant } from "./mutants.js";

/** At most this many mutants are run per analysis, across all files. */
export const MUTANTS_LIMIT = 12;
/** At most this many surviving mutants go back to the tester. */
export const SURVIVORS_FED_BACK = 10;

export type MutationOutcome =
  | {
      status: "baseline-failed" | "no-mutants";
      mutants: number;
      killed: number;
      survivors: Omit<Mutant, "content">[];
      score: null;
    }
  | {
      status: "analyzed";
      mutants: number;
      killed: number;
      survivors: Omit<Mutant, "content">[];
      /** killed / mutants. */
      score: number;
    };

/**
 * Runs a tester's proposed tests against mutants of the files the plan
 * names, each in the offline sandbox on a temporary view of the workspace
 * (the workspace is never written). Only checks that pass on the unmutated
 * code with the tests count: a mutant is killed when one of them fails on
 * it. When none pass, as before an implementation exists, nothing can be
 * measured and the analysis is skipped.
 */
export async function analyzeMutants(options: {
  workspace: string;
  /** The tester's proposal, staged: path to whole new content. */
  tests: ReadonlyMap<string, string>;
  /** Source files the plan names; test files are left out. */
  targets: readonly string[];
  checks: ProjectConfig["verification"];
  policy: ProjectPolicy;
  snapshotHash: string;
  verify: typeof verifyInContainer;
  signal?: AbortSignal;
}): Promise<MutationOutcome> {
  const added: AddedFile[] = [],
    replaced: AddedFile[] = [];
  for (const [file, content] of options.tests) {
    let exists = true;
    try {
      await readFile(await safePath(options.workspace, file, options.policy));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    (exists ? replaced : added).push({ path: file, content });
  }
  const run = (
    checks: ProjectConfig["verification"],
    mutated: AddedFile[] = [],
  ) =>
    options.verify(
      options.workspace,
      checks,
      options.policy,
      options.snapshotHash,
      options.signal,
      { added, replaced: [...replaced, ...mutated] },
    );
  // The sandbox stops at a check's first failure, so each runs on its own.
  const passing: ProjectConfig["verification"] = [];
  for (const check of options.checks) {
    const [result] = await run([check]);
    if (result?.code === 0) passing.push(check);
  }
  const mutants: Mutant[] = [];
  for (const file of [...options.targets].sort()) {
    if (options.tests.has(file) || mutants.length >= MUTANTS_LIMIT) continue;
    let content: string;
    try {
      content = await readFile(
        await safePath(options.workspace, file, options.policy),
        "utf8",
      );
    } catch {
      continue;
    }
    mutants.push(
      ...generateMutants(file, content, MUTANTS_LIMIT - mutants.length),
    );
  }
  const strip = ({ path, line, description }: Mutant) => ({
    path,
    line,
    description,
  });
  if (!passing.length)
    return {
      status: "baseline-failed",
      mutants: mutants.length,
      killed: 0,
      survivors: [],
      score: null,
    };
  if (!mutants.length)
    return {
      status: "no-mutants",
      mutants: 0,
      killed: 0,
      survivors: [],
      score: null,
    };
  const survivors: Mutant[] = [];
  for (const mutant of mutants) {
    if (options.signal?.aborted) throw new Error("Run cancelled");
    const results = await run(passing, [
      { path: mutant.path, content: mutant.content },
    ]);
    const killed =
      results.length < passing.length ||
      results.some((result) => result.code !== 0);
    if (!killed) survivors.push(mutant);
  }
  return {
    status: "analyzed",
    mutants: mutants.length,
    killed: mutants.length - survivors.length,
    survivors: survivors.map(strip),
    score: (mutants.length - survivors.length) / mutants.length,
  };
}

/** What the tester is told about surviving mutants: locations and operators only. */
export function mutationFeedback(
  survivors: readonly Omit<Mutant, "content">[],
): string {
  return [
    "Your tests are not applied yet. They were run against small changes (mutants) of the code the plan names, and these changes went unnoticed by every check that passes on the current code:",
    ...survivors
      .slice(0, SURVIVORS_FED_BACK)
      .map(
        ({ path, line, description }) => `- ${path}:${line}: ${description}`,
      ),
    ...(survivors.length > SURVIVORS_FED_BACK
      ? [`- and ${survivors.length - SURVIVORS_FED_BACK} more`]
      : []),
    "Propose your complete set of new tests again, adding assertions that would fail under these changes. If a change cannot alter observable behaviour, or cannot be observed before the change is implemented, propose the same tests unchanged.",
  ].join("\n");
}
