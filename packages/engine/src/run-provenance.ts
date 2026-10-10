import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ProjectPolicy,
  ProviderConfig,
  RunEvent,
  RunRecord,
} from "@graph-engineering/contracts";
import { managedGit } from "./execution/git.js";
import { runEvidence } from "./overview.js";
import { planSha256 } from "./store.js";
import { hash, subprocessEnvironment, writeJson } from "./util.js";

/**
 * An unsigned in-toto Statement v1 for an accepted run: what the run produced
 * (its result commit and the bytes of each file it changed) and how (the plan
 * and policy it was bound to, the approval it used, the workers that ran, the
 * gates it passed and when). It carries hashes, identifiers and timestamps
 * only: never a prompt, an objective, a note, file contents, a secret, a path
 * outside the repository or anything naming the person.
 *
 * It is never signed. Signing (for example with Sigstore) is an owner-gated
 * future option, and must never use the promotion keys.
 */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const RUN_PROVENANCE_PREDICATE_TYPE =
  "https://github.com/MILTONADINA/graph-engineering/provenance/run/v1";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitObject = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
const timestamp = z.string().datetime();
const gate = z
  .object({
    gate: z.enum(["verification", "review", "security"]),
    passed: z.boolean(),
    snapshotHash: sha256.nullable(),
    current: z.boolean(),
    at: timestamp,
    by: z.enum(["reviewer", "person"]).optional(),
  })
  .strict();
const worker = z
  .object({
    role: z.enum(["worker", "reviewer"]),
    providerId: z.string().min(1),
    kind: z.string().min(1).nullable(),
    model: z.string().nullable(),
    executable: z
      .object({
        sha256,
        version: z.string().nullable(),
        providerProfileSha256: sha256.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** The statement's schema; strict, so no field outside it can appear. */
export const runProvenanceSchema = z
  .object({
    _type: z.literal(IN_TOTO_STATEMENT_TYPE),
    subject: z
      .array(
        z
          .object({
            name: z.string().min(1),
            digest: z.union([
              z.object({ gitCommit: gitObject }).strict(),
              z.object({ sha256 }).strict(),
            ]),
          })
          .strict(),
      )
      .min(1),
    predicateType: z.literal(RUN_PROVENANCE_PREDICATE_TYPE),
    predicate: z
      .object({
        runId: z.string().min(1),
        planId: z.string().min(1),
        planSha256: sha256,
        policyHash: sha256,
        decisionMode: z.enum(["shadow", "promoted"]).nullable(),
        baseCommit: gitObject.nullable(),
        resultCommit: gitObject.nullable(),
        verifiedSnapshotHash: sha256.nullable(),
        removedFiles: z.array(z.string()),
        approval: z
          .object({
            planSha256: sha256,
            matchesPlan: z.boolean(),
            approvedAt: timestamp,
            approvedVia: z.enum(["terminal", "non-interactive"]).nullable(),
          })
          .strict()
          .nullable(),
        workers: z.array(worker),
        gates: z.array(gate),
        timestamps: z
          .object({
            planCreatedAt: timestamp,
            runCreatedAt: timestamp,
            succeededAt: timestamp.nullable(),
            acceptedAt: timestamp,
          })
          .strict(),
        signed: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type RunProvenance = z.infer<typeof runProvenanceSchema>;

export interface ChangedFiles {
  /** Repository-relative paths and the sha256 of their bytes at the commit. */
  files: { path: string; sha256: string }[];
  /** Paths the commit removed; with no bytes left they are not subjects. */
  removed: string[];
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const hex64 = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;

// A local provider's model may name a file on disk; only its base name says
// which model ran, and a full path can name the person's home directory.
function modelName(model: unknown): string | null {
  const name = text(model);
  if (name === null) return null;
  return /^([/~\\]|[A-Za-z]:[\\/])/.test(name)
    ? path.basename(name.replace(/\\/g, "/"))
    : name;
}

/**
 * Builds the statement from a run's stored record and events. Refuses a run
 * a person has not accepted, so a statement always describes a result some
 * person took. `policy` is the project's current policy: its decision mode
 * is reported only when its hash still matches the plan's.
 */
export function buildRunProvenance(input: {
  run: RunRecord;
  events: readonly RunEvent[];
  changed: ChangedFiles;
  providers: readonly ProviderConfig[];
  policy: ProjectPolicy | null;
}): RunProvenance {
  const { run, events, changed } = input;
  if (
    run.status !== "succeeded" ||
    run.completion?.humanAcceptance !== "accepted"
  )
    throw new Error(
      "Provenance is emitted only for a run a person accepted (graph-engine accept <runId>)",
    );
  const accepted = events.findLast(
    (event) =>
      event.type === "acceptance.recorded" &&
      event.data.decision === "accepted",
  );
  if (!accepted) throw new Error("This run recorded no acceptance");
  const verifiedSnapshotHash = hex64(accepted.data.snapshotHash);
  const currentPlan = planSha256(run.plan);
  const approved = events.findLast(
    (event) => event.type === "plan.approval_used",
  );
  const approvalHash = hex64(approved?.data.planSha256);
  const approvedAt = text(approved?.data.approvedAt);
  const via = approved?.data.approvedVia;
  const approval =
    approvalHash && approvedAt
      ? {
          planSha256: approvalHash,
          matchesPlan: approvalHash === currentPlan,
          approvedAt,
          approvedVia:
            via === "terminal" || via === "non-interactive" ? via : null,
        }
      : null;

  const kinds = new Map(input.providers.map((p) => [p.id, p.kind]));
  const identities = new Map<
    string,
    NonNullable<RunProvenance["predicate"]["workers"][number]["executable"]>
  >();
  for (const event of events)
    if (event.type === "worker.identity_used") {
      const providerId = text(event.data.providerId);
      const identity = event.data.identity as { sha256?: unknown } | undefined;
      const digest = hex64(identity?.sha256);
      if (providerId && digest)
        identities.set(providerId, {
          sha256: digest,
          version: text(event.data.version),
          providerProfileSha256: hex64(event.data.providerProfileSha256),
        });
    }
  for (const binding of run.plan.installedWorkers ?? [])
    if (!identities.has(binding.providerId))
      identities.set(binding.providerId, {
        sha256: binding.identity.sha256,
        version: null,
        providerProfileSha256: binding.providerProfileSha256,
      });
  const workers = new Map<
    string,
    RunProvenance["predicate"]["workers"][number]
  >();
  const addWorker = (
    role: "worker" | "reviewer",
    providerId: string | null,
    model: unknown,
  ) => {
    if (!providerId || workers.has(`${role}\0${providerId}`)) return;
    workers.set(`${role}\0${providerId}`, {
      role,
      providerId,
      kind: kinds.get(providerId) ?? null,
      model: modelName(model),
      executable: identities.get(providerId) ?? null,
    });
  };
  for (const event of events)
    if (event.type === "worker.dispatched")
      addWorker("worker", text(event.data.provider), event.data.model);
    else if (event.type === "review.completed" && event.data.by !== "person")
      addWorker("reviewer", text(event.data.providerId), event.data.model);

  const evidence = runEvidence(events);
  const gates: RunProvenance["predicate"]["gates"] = [];
  for (const name of ["verification", "review", "security"] as const) {
    const stage = evidence[name];
    if (!stage) continue;
    gates.push({
      gate: name,
      passed: stage.passed,
      snapshotHash: hex64(stage.snapshotHash),
      current: stage.current,
      at: stage.at,
      ...(name === "review" && evidence.review
        ? { by: evidence.review.by }
        : {}),
    });
  }

  const commit = run.commit ?? null;
  const subject: RunProvenance["subject"] = commit
    ? [
        { name: "git+commit", digest: { gitCommit: commit } },
        ...[...changed.files]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({
            name: file.path,
            digest: { sha256: file.sha256 },
          })),
      ]
    : verifiedSnapshotHash
      ? [
          {
            name: "graph-engineering+workspace-snapshot",
            digest: { sha256: verifiedSnapshotHash },
          },
        ]
      : [];
  if (!subject.length)
    throw new Error(
      "This run has neither a result commit nor a verified snapshot",
    );

  return runProvenanceSchema.parse({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject,
    predicateType: RUN_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      runId: run.id,
      planId: run.plan.id,
      planSha256: currentPlan,
      policyHash: run.plan.policyHash,
      decisionMode:
        input.policy && hash(input.policy) === run.plan.policyHash
          ? input.policy.decisionMode
          : null,
      baseCommit: run.baseCommit ?? null,
      resultCommit: commit,
      verifiedSnapshotHash,
      removedFiles: commit ? [...changed.removed].sort() : [],
      approval,
      workers: [...workers.values()],
      gates,
      timestamps: {
        planCreatedAt: run.plan.createdAt,
        runCreatedAt: run.createdAt,
        succeededAt:
          events.findLast((event) => event.type === "run.succeeded")?.at ??
          null,
        acceptedAt: accepted.at,
      },
      signed: false,
    },
  });
}

const execFileBuffer = promisify(execFile);

/**
 * The files a result commit changed against its base, each with the sha256
 * of its bytes at the commit. Read from the repository's object store (a run
 * workspace is a worktree of it), with hooks off and no filters applied.
 */
export async function changedFileDigests(
  root: string,
  baseCommit: string | undefined,
  commit: string,
): Promise<ChangedFiles> {
  // Every run the engine publishes records the commit it started from.
  if (!baseCommit)
    throw new Error("This run recorded no base commit to compare against");
  const listed = await managedGit(root, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--name-status",
    baseCommit,
    commit,
  ]);
  if (listed.code !== 0)
    throw new Error("Cannot list the files the result commit changed");
  const fields = listed.stdout.split("\0").filter(Boolean);
  const files: ChangedFiles["files"] = [];
  const removed: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!,
      file = fields[index + 1]!;
    if (status === "D") {
      removed.push(file);
      continue;
    }
    const { stdout } = await execFileBuffer(
      "git",
      [
        "-c",
        `core.hooksPath=${devNull}`,
        "cat-file",
        "blob",
        `${commit}:${file}`,
      ],
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 512 * 1024 * 1024,
        env: subprocessEnvironment(),
      },
    );
    files.push({
      path: file,
      sha256: createHash("sha256").update(stdout).digest("hex"),
    });
  }
  return { files, removed };
}

/** Where a run's statement is written when a person accepts it. */
export const runProvenanceFile = (dataDir: string, runId: string): string =>
  path.join(dataDir, "provenance", `${runId}.intoto.json`);

/** Builds and writes the statement for an accepted run; returns it. */
export async function writeRunProvenance(input: {
  root: string;
  dataDir: string;
  run: RunRecord;
  events: readonly RunEvent[];
  providers: readonly ProviderConfig[];
  policy: ProjectPolicy | null;
}): Promise<RunProvenance> {
  const changed = input.run.commit
    ? await changedFileDigests(
        input.root,
        input.run.baseCommit,
        input.run.commit,
      )
    : { files: [], removed: [] };
  const statement = buildRunProvenance({ ...input, changed });
  await writeJson(runProvenanceFile(input.dataDir, input.run.id), statement);
  return statement;
}
