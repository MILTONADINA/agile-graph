import path from "node:path";
import { z } from "zod";
import type {
  ProjectConfig,
  ProjectPolicy,
} from "@graph-engineering/contracts";
import {
  containsSecret,
  globAllowlist,
  isAllowedPath,
  redact,
  redactTail,
  wholeRepository,
} from "../policy.js";
import type { VerificationResult } from "../execution/docker.js";

/*
 * A verifier's optional reproducer for the advisory security audit: a new
 * test file the engine may run in the offline verification sandbox to
 * demonstrate a statically traced finding. It is model-written code, so it is
 * validated strictly, runs only through verifyInContainer with a registered
 * image on a temporary copy of the run's snapshot, and a demonstrated result
 * stays advisory.
 */

/** The largest reproducer the engine runs. */
export const MAX_REPRODUCER_BYTES = 65_536;
/** The most arguments a reproducer's argv may have. */
export const MAX_REPRODUCER_ARGS = 32;
export const MIN_EXPECTED_CHARS = 4;
export const MAX_EXPECTED_CHARS = 500;
/** Characters of the redacted output tail a record keeps. */
export const REPRODUCER_EXCERPT_CHARS = 2_000;

// The model's structured output is parsed loosely enough that a bad
// reproducer is refused with a reason, not a failed verifier call; the
// strict limits are in validateReproducer.
export const reproducerSchema = z
  .object({
    path: z.string().max(4000),
    content: z.string().max(1_000_000),
    argv: z.array(z.string().max(4000)).max(256),
    image: z.string().max(4000).nullable(),
    expected: z.string().max(4000),
  })
  .strict();
export type AuditReproducer = z.infer<typeof reproducerSchema>;
export const reproducerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content", "argv", "image", "expected"],
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    argv: { type: "array", items: { type: "string" } },
    image: { anyOf: [{ type: "string" }, { type: "null" }] },
    expected: { type: "string" },
  },
};

/** One plain argument: no shell metacharacter, quote or whitespace. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_./:=@+,%-]+$/;
/** Programs that would run argv as a shell command line. */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "busybox",
  "env",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
]);
/**
 * Output that shows the test never ran as a test: it failed to parse, load
 * or start. Compared without case; any one of them means not demonstrated.
 */
export const DID_NOT_RUN_MARKERS = [
  "SyntaxError",
  "Cannot find module",
  "Cannot find package",
  "ERR_MODULE_NOT_FOUND",
  "ModuleNotFoundError",
  "ImportError",
  "No test files found",
  "No tests found",
  "no tests ran",
  "command not found",
  "executable file not found",
] as const;
function didNotRunMarker(text: string): string | undefined {
  const lower = text.toLowerCase();
  return DID_NOT_RUN_MARKERS.find((marker) =>
    lower.includes(marker.toLowerCase()),
  );
}

export interface ReproducerContext {
  policy: ProjectPolicy;
  /** The project's test file globs: tester.writes or the tester's defaults. */
  testFiles: readonly string[];
  /** Files the run changed. */
  changedFiles: readonly string[];
  /** Files in the run's workspace, which a reproducer may not replace. */
  existingFiles: ReadonlySet<string>;
  /** The project's registered verification checks. */
  verification: ProjectConfig["verification"];
  /** Whether the auditor is a cloud provider. */
  cloud: boolean;
}

/** The registered image a reproducer runs in when it names none. */
export function defaultReproducerImage(
  verification: ProjectConfig["verification"],
): string | undefined {
  return (verification.find((check) => !check.optional) ?? verification[0])
    ?.image;
}

/**
 * The changed area: the first path segment of every changed file, or the
 * whole project when the run changed a top-level file.
 */
export function inChangedArea(
  relative: string,
  changedFiles: readonly string[],
): boolean {
  if (changedFiles.some((file) => !file.includes("/"))) return true;
  const top = relative.split("/")[0];
  return changedFiles.some((file) => file.split("/")[0] === top);
}

/**
 * Checks a proposed reproducer before anything runs: the reason it is
 * refused, or the registered image it runs in.
 */
export function validateReproducer(
  reproducer: AuditReproducer,
  context: ReproducerContext,
): { ok: true; image: string } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  const { path: file, content, argv, expected } = reproducer;
  const policy = wholeRepository(context.policy);
  if (!isAllowedPath(file, policy))
    return refuse(
      "its path is not a safe relative project path (no .., absolute, excluded or protected path)",
    );
  if (!globAllowlist(context.testFiles)(file))
    return refuse("its path does not match the project's test file globs");
  if (!inChangedArea(file, context.changedFiles))
    return refuse("its path is outside the area the run changed");
  if (context.existingFiles.has(file))
    return refuse("its path already exists; a reproducer must be a new file");
  if (context.cloud && !isAllowedPath(file, context.policy, true))
    return refuse(
      "a cloud auditor's reproducer must have a path in policy.exportPaths",
    );
  const bytes = Buffer.byteLength(content);
  if (!content.trim()) return refuse("its content is empty");
  if (bytes > MAX_REPRODUCER_BYTES)
    return refuse(`its content is larger than ${MAX_REPRODUCER_BYTES} bytes`);
  if (content.includes("\0")) return refuse("its content has a NUL byte");
  if (containsSecret(content))
    return refuse("its content contains a potential secret");
  if (argv.length < 1 || argv.length > MAX_REPRODUCER_ARGS)
    return refuse(`its argv must have 1 to ${MAX_REPRODUCER_ARGS} arguments`);
  if (!argv.every((argument) => PLAIN_ARGUMENT.test(argument)))
    return refuse(
      "its argv has an argument with a shell metacharacter, quote or space",
    );
  if (SHELLS.has(path.posix.basename(argv[0]!).toLowerCase()))
    return refuse("its argv starts with a shell");
  if (!argv.includes(file))
    return refuse("its argv does not name the reproducer's path");
  const signal = expected.trim();
  if (signal.length < MIN_EXPECTED_CHARS || signal.length > MAX_EXPECTED_CHARS)
    return refuse(
      `its expected failure text must be ${MIN_EXPECTED_CHARS} to ${MAX_EXPECTED_CHARS} characters`,
    );
  if (didNotRunMarker(signal))
    return refuse(
      "its expected failure text is a load or syntax error, which never demonstrates a finding",
    );
  const registered = new Set(context.verification.map((check) => check.image));
  const image =
    reproducer.image ?? defaultReproducerImage(context.verification);
  if (image === undefined)
    return refuse("the project has no registered verification image");
  if (!registered.has(image))
    return refuse("its image is not a registered verification image");
  return { ok: true, image };
}

export type ReproducerOutcome =
  | "demonstrated"
  | "not_demonstrated"
  | "refused"
  | "unavailable"
  | "skipped"
  | "error";

/** What happened to one verifier's reproducer; never instructions. */
export interface ReproducerRun {
  outcome: ReproducerOutcome;
  /** Why, in one redacted sentence. */
  note: string;
  path: string;
  argv: string[];
  expected: string;
  image?: string;
  imageId?: string;
  snapshotHash?: string;
  exitCode?: number;
  /** The redacted tail of the test's output. */
  excerpt?: string;
}

/**
 * The demonstration rule. A reproducer demonstrates its finding exactly when
 * the sandbox returned one result (a throw is an error, judged by the
 * caller), the test exited with a code from 1 to 124, its stdout and stderr
 * together contain the expected text (line endings normalized), and that
 * output contains none of the did-not-run markers.
 */
export function judgeReproducer(
  results: readonly VerificationResult[],
  expected: string,
): Pick<ReproducerRun, "outcome" | "note" | "exitCode" | "excerpt"> & {
  imageId?: string;
} {
  if (results.length !== 1)
    return {
      outcome: "error",
      note: `The sandbox returned ${results.length} results for one reproducer.`,
    };
  const [result] = results as [VerificationResult];
  const output = `${result.stdout}\n${result.stderr}`.replace(/\r\n?/g, "\n");
  const excerpt = redactTail(output.trim(), REPRODUCER_EXCERPT_CHARS);
  const base = {
    exitCode: result.code,
    excerpt,
    ...(result.imageId === undefined ? {} : { imageId: result.imageId }),
  };
  const not = (note: string) => ({
    ...base,
    outcome: "not_demonstrated" as const,
    note,
  });
  if (result.code === 0)
    return not("The reproducer passed (exit code 0), so nothing failed.");
  if (result.code >= 125 && result.code <= 127)
    return not(
      `The reproducer could not start (exit code ${result.code}: Docker or the command failed to run it).`,
    );
  if (result.code < 1 || result.code > 124)
    return not(
      `The reproducer was killed or ended abnormally (exit code ${result.code}).`,
    );
  const marker = didNotRunMarker(output);
  if (marker)
    return not(
      `The reproducer errored before its test ran (its output shows ${JSON.stringify(marker)}).`,
    );
  if (!output.includes(expected.trim().replace(/\r\n?/g, "\n")))
    return not(
      `The reproducer failed (exit code ${result.code}), but not with the expected failure text.`,
    );
  return {
    ...base,
    outcome: "demonstrated",
    note: `The reproducer failed with exit code ${result.code} and the expected failure text.`,
  };
}

/** A sandbox error as a reproducer note, redacted. */
export function reproducerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(`The sandbox could not run the reproducer: ${message}`).slice(
    0,
    1000,
  );
}
