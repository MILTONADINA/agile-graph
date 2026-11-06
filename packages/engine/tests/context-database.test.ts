import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../src/util.js";
import { ContextDatabase } from "../src/context/database.js";

// Every wait on a database request is bounded, so a request that never settles
// fails its test instead of waiting out the test timeout.
const SETTLE_BOUND_MS = 10_000;

async function settle<T>(
  promise: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`request still pending after ${SETTLE_BOUND_MS} ms`)),
      SETTLE_BOUND_MS,
    );
  });
  try {
    return await Promise.race([
      promise.then(
        (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
        (reason: unknown): PromiseSettledResult<T> => ({
          status: "rejected",
          reason,
        }),
      ),
      bound,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withDatabase(
  run: (database: ContextDatabase) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-context-db-"));
  const database = new ContextDatabase(path.join(directory, "context.sqlite"));
  try {
    await run(database);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// Requests posted to the worker and not yet settled.
const pendingCount = (database: ContextDatabase) =>
  (database as unknown as { pending: Map<number, unknown> }).pending.size;

const closedRejection = {
  status: "rejected",
  reason: expect.objectContaining({ message: "Context database is closed" }),
};

it("does not inherit module-only eval flags or loaders into the fixed SQLite worker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-worker-mode-"));
  try {
    const moduleUrl = new URL("../src/context/database.ts", import.meta.url)
      .href;
    const script = `import {ContextDatabase} from ${JSON.stringify(moduleUrl)}; const db=new ContextDatabase(${JSON.stringify(path.join(directory, "context.sqlite"))}); try { await db.exec("CREATE TABLE check_worker(id INTEGER)"); console.log("ready"); } finally { await db.close(); }`;
    const result = await command(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        timeoutMs: 15000,
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a query issued while close() is in flight instead of hanging", async () => {
  await withDatabase(async (database) => {
    const closing = database.close();
    await expect(settle(database.get("select 1 as a"))).resolves.toEqual(
      closedRejection,
    );
    await closing;
    expect(pendingCount(database)).toBe(0);
  });
});

it("rejects every request issued after close() has started, whatever its operation", async () => {
  await withDatabase(async (database) => {
    const closing = database.close();
    const later = [
      database.exec("select 1"),
      database.run("select 1"),
      database.get("select 1"),
      database.all("select 1"),
      database.vectorStatus(),
    ];
    for (const request of later)
      await expect(settle(request)).resolves.toEqual(closedRejection);
    await closing;
    expect(pendingCount(database)).toBe(0);
  });
});

it("settles a request issued before close() with its own result", async () => {
  await withDatabase(async (database) => {
    const before = database.get<{ a: number }>("select 1 as a");
    const closing = database.close();
    await expect(settle(before)).resolves.toEqual({
      status: "fulfilled",
      value: { a: 1 },
    });
    await closing;
  });
});

it("removes a request's pending entry when posting it throws", async () => {
  await withDatabase(async (database) => {
    // A function cannot be cloned, so posting this request to the worker throws.
    await expect(
      settle(database.run("select 1", [() => undefined])),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(pendingCount(database)).toBe(0);
    await expect(database.get("select 1 as a")).resolves.toEqual({ a: 1 });
  });
});
