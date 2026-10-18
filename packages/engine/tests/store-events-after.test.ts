import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunStore } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("reads a run's events after a position, in order, with a bounded limit", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-events-after-"));
  directories.push(dataDir);
  const store = new RunStore(dataDir, "p1");
  try {
    expect(store.eventsAfter("run-1", 0, 10)).toEqual({
      events: [],
      seqs: [],
      lastSeq: 0,
    });
    // Interleaved with another run, which must not appear in the pages.
    for (let i = 0; i < 5; i++) {
      store.event("run-1", `t${i}`, { i });
      store.event("run-2", "other", {});
    }
    const first = store.eventsAfter("run-1", 0, 2);
    expect(first.events.map((e) => e.type)).toEqual(["t0", "t1"]);
    const second = store.eventsAfter("run-1", first.lastSeq, 2);
    expect(second.events.map((e) => e.type)).toEqual(["t2", "t3"]);
    expect(second.seqs[0]).toBeGreaterThan(first.lastSeq);
    const rest = store.eventsAfter("run-1", second.lastSeq, 10);
    expect(rest.events.map((e) => e.type)).toEqual(["t4"]);
    // Past the end: empty, and the cursor does not move.
    expect(store.eventsAfter("run-1", rest.lastSeq, 10)).toEqual({
      events: [],
      seqs: [],
      lastSeq: rest.lastSeq,
    });
    expect(store.events("run-1").map((e) => e.type)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  } finally {
    store.close();
  }
});
