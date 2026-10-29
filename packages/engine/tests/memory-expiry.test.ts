import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_POLICY,
  type MemoryAssertion,
  type MemoryRecord,
} from "@agile-graph/contracts";
import { ContextEngine } from "../src/context/index.js";
import {
  memoryExpired,
  memoryExpiresAt,
  parseMemoryExpiry,
} from "../src/context/memory-assertions.js";
import { checked } from "../src/util.js";

// Memories that expire: a person sets validUntil at proposal or acceptance,
// and once it passes, retrieval leaves the memory out. Toy synthetic project.

const DAY = 86_400_000;
const START = Date.parse("2030-01-01T00:00:00.000Z");
const directories: string[] = [],
  engines: ContextEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "graph-memory-expiry-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "main.ts"),
    "export function main() { return 1; }\n",
  );
  const clock = { now: START };
  const engine = new ContextEngine({
    projectId: "expiry-project",
    root,
    dataDir: join(directory, "data"),
    policy: structuredClone(DEFAULT_POLICY),
    now: () => clock.now,
  });
  engines.push(engine);
  return { engine, clock, root };
}

const iso = (ms: number) => new Date(ms).toISOString();

function record(
  validUntil: string | undefined,
  claims: Partial<MemoryAssertion>[] = [],
): MemoryRecord {
  return {
    version: "1.0.0",
    id: "memory-0001",
    projectId: "expiry-project",
    kind: "constraint",
    text: "Toy constraint",
    visibility: "private",
    status: "accepted",
    createdAt: iso(START),
    sources: [],
    ...(validUntil ? { validUntil } : {}),
    ...(claims.length
      ? {
          assertions: {
            version: "1.0.0",
            claims: claims.map((claim) => ({
              subject: "toy",
              predicate: "uses",
              scope: {},
              value: { type: "string", value: "x" },
              exclusive: true,
              ...claim,
            })),
            review: {
              reviewer: "toy",
              reviewedAt: iso(START),
              evidence: ["e"],
            },
          },
        }
      : {}),
  } as MemoryRecord;
}

it("expires a memory only at its own validUntil, never because its reviewed claims' windows have ended", () => {
  const soon = iso(START + DAY),
    later = iso(START + 3 * DAY);
  expect(memoryExpiresAt(record(undefined))).toBeUndefined();
  expect(memoryExpiresAt(record(soon))).toBe(START + DAY);
  // A claim's validUntil says when that fact held. Claims whose windows have
  // all ended leave a memory without its own expiry open-ended...
  const lapsedClaims = record(undefined, [
    { validUntil: soon },
    { validUntil: later },
  ]);
  expect(memoryExpiresAt(lapsedClaims)).toBeUndefined();
  expect(memoryExpired(lapsedClaims, START + 100 * DAY)).toBe(false);
  // ...and neither shorten nor extend a memory's own expiry.
  expect(memoryExpiresAt(record(later, [{ validUntil: soon }]))).toBe(
    START + 3 * DAY,
  );
  expect(memoryExpiresAt(record(soon, [{ validUntil: later }]))).toBe(
    START + DAY,
  );
  // Validity is half-open: expired from the instant it ends.
  expect(memoryExpired(record(soon), START + DAY - 1)).toBe(false);
  expect(memoryExpired(record(soon), START + DAY)).toBe(true);
});

it("keeps an expired memory out of the mandatory set and retrieved items, naming only its ID", async () => {
  const { engine, clock } = await fixture();
  const constraintText = "EXPIRING_CONSTRAINT_CANARY freeze the toy release";
  const observationText = "EXPIRING_OBSERVATION_CANARY toy release notes";
  const lastingText = "LASTING_CONSTRAINT_CANARY keep the toy main export";
  const constraint = await engine.proposeMemory({
    kind: "constraint",
    text: constraintText,
    validUntil: "2030-01-02T01:00:00+01:00",
  });
  // Stored as the same instant in UTC.
  expect(constraint.validUntil).toBe("2030-01-02T00:00:00.000Z");
  const observation = await engine.proposeMemory({
    kind: "observation",
    text: observationText,
  });
  const lasting = await engine.proposeMemory({
    kind: "constraint",
    text: lastingText,
  });
  await engine.acceptMemory(constraint.id);
  await engine.acceptMemory(observation.id, {
    validUntil: iso(START + 2 * DAY),
  });
  await engine.acceptMemory(lasting.id);
  const query = { query: "toy release", retrieval: "lexical" as const };

  const before = await engine.getContext(query);
  expect(before.mandatory).toEqual([constraintText, lastingText]);
  expect(before.items.map((item) => item.memoryId)).toContain(observation.id);

  clock.now = START + DAY;
  const halfway = await engine.getContext(query);
  expect(halfway.mandatory).toEqual([lastingText]);
  expect(halfway.mandatorySources.map((entry) => entry.memoryId)).toEqual([
    lasting.id,
  ]);
  expect(halfway.items.map((item) => item.memoryId)).toContain(observation.id);
  const warning = halfway.coverage.warnings.find((text) =>
    text.startsWith("Expired memory"),
  );
  expect(warning).toContain(constraint.id);
  expect(JSON.stringify(halfway)).not.toContain(constraintText);

  clock.now = START + 2 * DAY;
  const after = await engine.getContext(query);
  expect(after.mandatory).toEqual([lastingText]);
  expect(after.items.some((item) => item.memoryId === observation.id)).toBe(
    false,
  );
  expect(JSON.stringify(after)).not.toContain(observationText);
  expect(
    after.coverage.warnings.find((text) => text.startsWith("Expired memory")),
  ).toContain(`${constraint.id}, ${observation.id}`);

  // Expiry is computed when context is read: the records stay accepted.
  const stored = await engine.listMemories();
  expect(stored.map((memory) => memory.status)).toEqual([
    "accepted",
    "accepted",
    "accepted",
  ]);
});

it("keeps an expired mandatory memory only for a run that started with it, under the same export checks", async () => {
  const { engine, clock } = await fixture();
  const constraintText = "RETAINED_CONSTRAINT_CANARY freeze the toy release";
  const observationText = "RETAINED_OBSERVATION_CANARY toy release notes";
  const constraint = await engine.proposeMemory({
    kind: "constraint",
    text: constraintText,
    validUntil: iso(START + DAY),
  });
  const observation = await engine.proposeMemory({
    kind: "observation",
    text: observationText,
    validUntil: iso(START + DAY),
  });
  await engine.acceptMemory(constraint.id);
  await engine.acceptMemory(observation.id);
  const query = { query: "toy release", retrieval: "lexical" as const };
  clock.now = START + 2 * DAY;
  const retained = await engine.getContext({
    ...query,
    retainExpired: [constraint.id, observation.id, "memory-unknown"],
  });
  // Only the mandatory kind is kept; nothing is added.
  expect(retained.mandatory).toEqual([constraintText]);
  expect(retained.mandatorySources).toEqual([
    expect.objectContaining({
      memoryId: constraint.id,
      text: constraintText,
      exportAuthorized: false,
    }),
  ]);
  expect(JSON.stringify(retained)).not.toContain(observationText);
  const warnings = retained.coverage.warnings.join("\n");
  expect(warnings).toContain(
    `Expired memory kept for the run in progress that started with it: ${constraint.id}.`,
  );
  expect(warnings).toContain(
    `Expired memory left out of context: ${observation.id}.`,
  );
  // A private, unauthorized memory kept for a run is still refused for export.
  await expect(
    engine.getContext({
      ...query,
      exportOnly: true,
      retainExpired: [constraint.id],
    }),
  ).rejects.toThrow(constraint.id);
  // Without the run's starting set, expiry applies as usual.
  expect((await engine.getContext(query)).mandatory).toEqual([]);
});

it("refuses a malformed or past expiry and an expiry change after acceptance, while acceptance may set or replace it", async () => {
  const { engine, clock } = await fixture();
  await expect(
    engine.proposeMemory({
      kind: "constraint",
      text: "Toy",
      validUntil: "2030-02-01",
    }),
  ).rejects.toThrow("ISO 8601 date-time with a time zone");
  await expect(
    engine.createMemory({
      kind: "constraint",
      text: "Toy",
      validUntil: "2029-12-31T00:00:00Z",
    }),
  ).rejects.toThrow("has already passed");
  // A date that does not exist on the calendar is refused, not rolled over
  // to 2 or 3 March.
  for (const impossible of [
    "2030-02-31T00:00:00Z",
    "2031-02-29T12:00:00Z",
    "2030-04-31T00:00:00+02:00",
  ])
    await expect(
      engine.proposeMemory({
        kind: "constraint",
        text: "Toy",
        validUntil: impossible,
      }),
    ).rejects.toThrow("ISO 8601 date-time with a time zone");
  expect(parseMemoryExpiry("2032-02-29T23:59:59+05:00")).toBe(
    "2032-02-29T18:59:59.000Z",
  );

  const replaced = await engine.proposeMemory({
    kind: "decision",
    text: "Toy decision",
    validUntil: iso(START + DAY),
  });
  const accepted = await engine.acceptMemory(replaced.id, {
    validUntil: iso(START + 5 * DAY),
  });
  expect(accepted.validUntil).toBe(iso(START + 5 * DAY));
  // Re-accepting with the same expiry is a no-op; a different one is refused.
  await expect(
    engine.acceptMemory(replaced.id, { validUntil: iso(START + 5 * DAY) }),
  ).resolves.toMatchObject({ status: "accepted" });
  await expect(
    engine.acceptMemory(replaced.id, { validUntil: iso(START + 9 * DAY) }),
  ).rejects.toThrow("already accepted");

  // A proposal whose expiry lapsed before acceptance needs a later one.
  const lapsed = await engine.proposeMemory({
    kind: "decision",
    text: "Toy lapsed decision",
    validUntil: iso(START + DAY),
  });
  clock.now = START + 2 * DAY;
  await expect(engine.acceptMemory(lapsed.id)).rejects.toThrow(
    "has already passed",
  );
  await expect(
    engine.acceptMemory(lapsed.id, { validUntil: iso(START + DAY) }),
  ).rejects.toThrow("has already passed");
  expect(
    await engine.acceptMemory(lapsed.id, { validUntil: iso(START + 3 * DAY) }),
  ).toMatchObject({ status: "accepted", validUntil: iso(START + 3 * DAY) });
});

it("memory-review flags expired and expiring memories by ID and date within a configurable window", async () => {
  const { engine, clock } = await fixture();
  const ids: Record<string, string> = {};
  for (const [name, days] of [
    ["expired", 1],
    ["soon", 10],
    ["later", 30],
    ["never", undefined],
  ] as const) {
    const memory = await engine.proposeMemory({
      kind: "constraint",
      text: `Toy ${name} constraint`,
      ...(days ? { validUntil: iso(START + days * DAY) } : {}),
    });
    await engine.acceptMemory(memory.id);
    ids[name] = memory.id;
  }
  clock.now = START + 2 * DAY;
  const validity = (
    reviews: Awaited<ReturnType<typeof engine.reviewMemories>>,
  ) =>
    Object.fromEntries(
      reviews.flatMap((review) =>
        review.flags
          .filter((flag) => flag.method === "validity")
          .map((flag) => [review.memoryId, [flag.kind, flag.validUntil]]),
      ),
    );

  const defaults = await engine.reviewMemories();
  expect(validity(defaults)).toEqual({
    [ids.expired!]: ["expired", iso(START + DAY)],
    [ids.soon!]: ["expiring", iso(START + 10 * DAY)],
  });
  // Dates only: no flag repeats memory text.
  for (const review of defaults)
    for (const flag of review.flags) expect(flag.reason).not.toMatch(/Toy/);

  expect(
    validity(await engine.reviewMemories(undefined, { withinDays: 60 })),
  ).toEqual({
    [ids.expired!]: ["expired", iso(START + DAY)],
    [ids.soon!]: ["expiring", iso(START + 10 * DAY)],
    [ids.later!]: ["expiring", iso(START + 30 * DAY)],
  });
  expect(
    validity(await engine.reviewMemories(undefined, { withinDays: 0 })),
  ).toEqual({ [ids.expired!]: ["expired", iso(START + DAY)] });
  await expect(
    engine.reviewMemories(undefined, { withinDays: -1 }),
  ).rejects.toThrow("--within-days");
});

it("marks a shared memory conflicted when its shared file changes the expiry, instead of silently keeping either", async () => {
  const { engine, root } = await fixture();
  const memory = await engine.proposeMemory({
    kind: "constraint",
    text: "Toy shared constraint",
    validUntil: iso(START + DAY),
  });
  await engine.acceptMemory(memory.id);
  const { path: shared } = await engine.promoteMemory(memory.id);
  expect(await engine.importSharedMemories()).toBe(0);
  expect((await engine.listMemories())[0]!.status).toBe("accepted");
  const file = join(root, shared);
  const edited = JSON.parse(await readFile(file, "utf8"));
  edited.validUntil = iso(START + 30 * DAY);
  await writeFile(file, JSON.stringify(edited, null, 2) + "\n");
  await engine.importSharedMemories();
  expect((await engine.listMemories())[0]).toMatchObject({
    status: "conflicted",
    validUntil: iso(START + DAY),
  });
});

it("refuses a shared memory whose expiry is at or before its own creation", async () => {
  const { engine, root } = await fixture();
  const memory = await engine.proposeMemory({
    kind: "constraint",
    text: "Toy backdated constraint",
    validUntil: iso(START + DAY),
  });
  // createdAt comes from the engine's clock, the same one expiry is read by.
  expect(memory.createdAt).toBe(iso(START));
  await engine.acceptMemory(memory.id);
  const { path: shared } = await engine.promoteMemory(memory.id);
  const file = join(root, shared);
  const original = JSON.parse(await readFile(file, "utf8"));
  for (const validUntil of [iso(START), iso(START - DAY)]) {
    await writeFile(
      file,
      JSON.stringify({ ...original, validUntil }, null, 2) + "\n",
    );
    await expect(engine.importSharedMemories()).rejects.toThrow(
      "cannot expire before it was created",
    );
  }
  // The stored record is untouched.
  expect((await engine.listMemories())[0]).toMatchObject({
    status: "accepted",
    validUntil: iso(START + DAY),
  });
});

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../", import.meta.url));

it("memory-add and memory-accept take --valid-until, and memory-review --within-days lists expiring memory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "graph-memory-expiry-cli-"));
  const data = await mkdtemp(
    path.join(tmpdir(), "graph-memory-expiry-cli-data-"),
  );
  directories.push(root, data);
  await checked("git", ["init", "-q"], { cwd: root });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  Object.assign(env, {
    GRAPH_ENGINE_DATA_DIR: data,
    CI: "",
    GRAPH_ENGINE_NO_FEEDBACK: "1",
  });
  const graph = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", CLI, "-C", root, ...args],
        { cwd: ENGINE, env, timeout: 60_000, maxBuffer: 1_000_000 },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
          }),
      );
    });
  const json = async <T>(pending: ReturnType<typeof graph>): Promise<T> => {
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as T;
  };
  expect((await graph("init")).code).toBe(0);
  const inDays = (days: number) => iso(Date.now() + days * DAY);

  const proposed = await json<MemoryRecord>(
    graph(
      "memory-add",
      "--kind",
      "constraint",
      "--valid-until",
      inDays(3),
      "Toy CLI constraint",
    ),
  );
  expect(proposed.validUntil).toBeDefined();
  const past = await graph(
    "memory-add",
    "--valid-until",
    "2000-01-01T00:00:00Z",
    "Toy past observation",
  );
  expect(past.code).not.toBe(0);
  expect(past.stderr).toContain("has already passed");
  const expiry = inDays(5);
  const accepted = await json<MemoryRecord>(
    graph("memory-accept", proposed.id, "--valid-until", expiry),
  );
  expect(accepted).toMatchObject({ status: "accepted", validUntil: expiry });

  type Review = {
    memoryId: string;
    flags: { kind: string; validUntil?: string; reason: string }[];
  };
  const narrow = await json<Review[]>(
    graph("memory-review", "--within-days", "1"),
  );
  expect(
    narrow.flatMap((review) => review.flags).some((flag) => flag.validUntil),
  ).toBe(false);
  const wide = await json<Review[]>(graph("memory-review"));
  const flag = wide
    .find((review) => review.memoryId === proposed.id)
    ?.flags.find((entry) => entry.kind === "expiring");
  expect(flag).toMatchObject({ validUntil: expiry });
  expect(flag?.reason).not.toContain("Toy CLI constraint");

  // --valid-from on both commands; a malformed one is refused.
  const start = inDays(2);
  const later = await json<MemoryRecord>(
    graph("memory-add", "--valid-from", start, "Toy CLI later observation"),
  );
  expect(later.validFrom).toBe(start);
  const replacement = inDays(1);
  const restarted = await json<MemoryRecord>(
    graph("memory-accept", later.id, "--valid-from", replacement),
  );
  expect(restarted.validFrom).toBe(replacement);
  const pastStart = await json<MemoryRecord>(
    graph("memory-add", "--valid-from", iso(Date.now() - DAY), "Toy CLI past"),
  );
  expect(pastStart.validFrom).toBeDefined();
  expect(Date.parse(pastStart.validFrom ?? "")).toBeLessThan(Date.now());
  const badStart = await graph("memory-add", "--valid-from", "tomorrow", "Toy");
  expect(badStart.code).not.toBe(0);
  expect(badStart.stderr).toContain("validFrom must be an ISO 8601");
}, 120_000);
