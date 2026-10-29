import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import { ContextEngine } from "../src/context/index.js";
import { memoryNotYetValid } from "../src/context/memory-assertions.js";
import type { MemoryRecord } from "@agile-graph/contracts";

// Memories that start later: a person sets validFrom at proposal or
// acceptance, and before that instant retrieval leaves the memory out.
// Toy synthetic project.

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
  const directory = await mkdtemp(join(tmpdir(), "graph-memory-valid-from-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "main.ts"),
    "export function main() { return 1; }\n",
  );
  const clock = { now: START };
  const engine = new ContextEngine({
    projectId: "valid-from-project",
    root,
    dataDir: join(directory, "data"),
    policy: structuredClone(DEFAULT_POLICY),
    now: () => clock.now,
  });
  engines.push(engine);
  return { engine, clock, root };
}

const iso = (ms: number) => new Date(ms).toISOString();

it("leaves a memory out of the packet before its validFrom and includes it from that instant", async () => {
  const { engine, clock } = await fixture();
  const text = "PENDING_CONSTRAINT_CANARY freeze the toy release";
  const memory = await engine.proposeMemory({
    kind: "constraint",
    text,
    validFrom: "2030-01-02T01:00:00+01:00",
  });
  // Stored as the same instant in UTC.
  expect(memory.validFrom).toBe("2030-01-02T00:00:00.000Z");
  await engine.acceptMemory(memory.id);
  const query = { query: "toy release", retrieval: "lexical" as const };

  const before = await engine.getContext(query);
  expect(before.mandatory).toEqual([]);
  expect(JSON.stringify(before)).not.toContain(text);
  expect(before.coverage.warnings.join("\n")).toContain(memory.id);

  clock.now = START + DAY - 1;
  expect((await engine.getContext(query)).mandatory).toEqual([]);
  clock.now = START + DAY;
  const at = await engine.getContext(query);
  expect(at.mandatory).toEqual([text]);
  expect(at.coverage.warnings.join("\n")).not.toContain("not yet valid");
  expect((await engine.listMemories())[0]!.status).toBe("accepted");
});

it("refuses a malformed validFrom, one at or after validUntil, and a change after acceptance", async () => {
  const { engine } = await fixture();
  for (const bad of ["2030-02-01", "2030-02-31T00:00:00Z", "soon"])
    await expect(
      engine.proposeMemory({ kind: "decision", text: "Toy", validFrom: bad }),
    ).rejects.toThrow("validFrom must be an ISO 8601 date-time");
  await expect(
    engine.proposeMemory({
      kind: "decision",
      text: "Toy",
      validFrom: iso(START + 2 * DAY),
      validUntil: iso(START + 2 * DAY),
    }),
  ).rejects.toThrow("cannot expire before it starts");

  const proposal = await engine.proposeMemory({
    kind: "decision",
    text: "Toy decision",
    validFrom: iso(START + DAY),
  });
  await expect(
    engine.acceptMemory(proposal.id, {
      validFrom: iso(START + 3 * DAY),
      validUntil: iso(START + 2 * DAY),
    }),
  ).rejects.toThrow("cannot expire before it starts");
  const accepted = await engine.acceptMemory(proposal.id, {
    validFrom: iso(START + 2 * DAY),
  });
  expect(accepted.validFrom).toBe(iso(START + 2 * DAY));
  await expect(
    engine.acceptMemory(proposal.id, { validFrom: iso(START + 5 * DAY) }),
  ).rejects.toThrow("validFrom cannot change");
  await expect(
    engine.acceptMemory(proposal.id, { validFrom: iso(START + 2 * DAY) }),
  ).resolves.toMatchObject({ status: "accepted" });
});

it("refuses a successor whose validFrom precedes its predecessor's and leaves both records unchanged", async () => {
  const { engine } = await fixture();
  const previous = await engine.proposeMemory({
    kind: "constraint",
    text: "Toy rule v1",
    validFrom: iso(START + 5 * DAY),
  });
  await engine.acceptMemory(previous.id);
  const early = await engine.proposeMemory({
    kind: "constraint",
    text: "Toy rule v2",
    supersedes: previous.id,
    validFrom: iso(START + 4 * DAY),
  });
  await expect(engine.acceptMemory(early.id)).rejects.toThrow(
    "validFrom cannot precede its predecessor's",
  );
  const stored = await engine.listMemories();
  expect(stored.find((m) => m.id === previous.id)?.status).toBe("accepted");
  expect(stored.find((m) => m.id === early.id)?.status).toBe("proposed");

  // Replacing the successor's start at acceptance repairs it; an equal start
  // is allowed.
  await expect(
    engine.acceptMemory(early.id, { validFrom: iso(START + 5 * DAY) }),
  ).resolves.toMatchObject({ status: "accepted" });
  expect((await engine.listMemories()).map((m) => m.status).sort()).toEqual([
    "accepted",
    "superseded",
  ]);
});

it("hides a memory only by its own validFrom, never by a reviewed claim's window", () => {
  const base = {
    version: "1.0.0",
    id: "memory-0001",
    projectId: "toy",
    kind: "constraint",
    text: "Toy constraint",
    visibility: "private",
    status: "accepted",
    createdAt: iso(START),
    sources: [],
    assertions: {
      version: "1.0.0",
      claims: [
        {
          subject: "toy",
          predicate: "uses",
          scope: {},
          value: { type: "string", value: "x" },
          exclusive: true,
          validFrom: iso(START + 5 * DAY),
        },
      ],
      review: {
        reviewer: "toy",
        reviewedAt: iso(START),
        evidence: ["e"],
      },
    },
  } as MemoryRecord;
  expect(memoryNotYetValid(base, START)).toBe(false);
  expect(
    memoryNotYetValid({ ...base, validFrom: iso(START + DAY) }, START),
  ).toBe(true);
});
