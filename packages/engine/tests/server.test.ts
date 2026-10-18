import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createServer } from "../src/server.js";

it("requires a local token, rejects hostile origins, and returns real persisted memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-http-"));
  const config = await initializeProject(root);
  const engine = await GraphEngine.open(root);
  const { app } = createServer(engine, "test-token");
  try {
    expect(
      (await app.inject({ url: "/api/health", headers: { host: "localhost" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: {
            host: "attacker.example",
            authorization: "Bearer test-token",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: {
            host: "localhost",
            origin: "https://attacker.example",
            authorization: "Bearer test-token",
          },
        })
      ).statusCode,
    ).toBe(403);
    const headers = { host: "localhost", authorization: "Bearer test-token" };
    expect((await app.inject({ url: "/api/health", headers })).json()).toEqual({
      ok: true,
    });
    expect(
      (
        await app.inject({
          url: "/api/overview",
          headers: { host: "localhost" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/api/insights", headers })).json(),
    ).toMatchObject({
      runs: 0,
      decisions: [],
      note: expect.stringContaining("not scores"),
    });
    expect(
      (await app.inject({ url: "/api/overview", headers })).json(),
    ).toEqual({
      counts: { "needs-you": 0, "in-progress": 0, done: 0 },
      cards: [],
      project: {
        name: config.name,
        reviewer: null,
        workingSet: null,
        maxWorkers: config.policy.maxWorkers,
        decisionMode: "shadow",
      },
    });
    expect(
      (await app.inject({ url: "/api/snapshots/current", headers })).json(),
    ).toBeNull();
    expect(
      (await app.inject({ url: "/api/usage", headers: { host: "localhost" } }))
        .statusCode,
    ).toBe(401);
    engine.store.reserveCall(
      "unsaved-plan",
      "test-usage-reservation",
      "jev",
      0.2,
      null,
    );
    expect(
      (await app.inject({ url: "/api/usage", headers })).json(),
    ).toMatchObject({
      source: "inference-call-ledger",
      callCount: 1,
      unresolvedCallCount: 1,
      totals: { costUsd: 0.2, estimated: true },
      planningOnly: { callCount: 1, unsavedPlanCallCount: 1 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers,
      payload: { kind: "decision", text: "Use dev for integration" },
    });
    expect(created.statusCode).toBe(200);
    const memory = created.json();
    const assertions = {
      version: "1.0.0",
      claims: [
        {
          subject: "git",
          predicate: "integration-branch",
          scope: {},
          value: { type: "string", value: "dev" },
          exclusive: true,
        },
      ],
      review: {
        reviewer: "unit-test",
        reviewedAt: memory.createdAt,
        evidence: ["Synthetic review fixture"],
      },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/memories/${memory.id}/assertions`,
          headers: { host: "localhost" },
          payload: assertions,
        })
      ).statusCode,
    ).toBe(401);
    const annotated = await app.inject({
      method: "POST",
      url: `/api/memories/${memory.id}/assertions`,
      headers,
      payload: assertions,
    });
    expect(annotated.statusCode).toBe(200);
    expect(annotated.json()).toMatchObject({
      status: "proposed",
      visibility: "private",
      assertions,
    });
    const list = await app.inject({ url: "/api/memories", headers });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].visibility).toBe("private");
  } finally {
    await app.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});

// A run's event stream stays open until its client leaves, and closing the
// server waits for every open request, so without ending the streams `serve`
// could not stop, and the engine that cancels its runs would never close.
it("ends an open run event stream when the server closes, after sending the events recorded so far", async () => {
  const events: { type: string }[] = [{ type: "run.started" }];
  const engine = {
    store: {
      run: () => ({}),
      eventsAfter: (_id: string, after: number, limit: number) => {
        const page = events.slice(after, after + limit);
        return {
          events: page,
          seqs: page.map((_, i) => after + i + 1),
          lastSeq: after + page.length,
        };
      },
    },
  } as unknown as GraphEngine;
  const { app } = createServer(engine, "test-token");
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  let closed: Promise<string> | undefined;
  try {
    const response = await fetch(`${address}/api/runs/run-1/events`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const stream = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "ended";
        text += decoder.decode(value, { stream: true });
      }
    })().catch((error: unknown) => `failed: ${String(error)}`);
    // Recorded after the stream's first flush.
    events.push({ type: "run.cancelled" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    closed = app.close().then(() => "closed");
    const outcome = await Promise.race([
      closed,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still open after 5 s"), 5000);
      }),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe("closed");
    expect(await stream).toBe("ended");
    expect(
      text
        .split("\n\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line.replace(/^data: /, ""))),
    ).toEqual(events);
  } finally {
    // Frees a close the stream held open, so a failure cannot hang the file.
    app.server.closeAllConnections();
    await (closed ?? app.close());
  }
});

// The stream reads only what follows the last event it sent, one bounded page
// at a time, so a long run is not re-read in full every second.
it("streams only events after the last one sent, in bounded pages", async () => {
  const events = Array.from({ length: 1201 }, (_, i) => ({ type: `e${i}` }));
  const calls: [number, number][] = [];
  const engine = {
    store: {
      run: () => ({}),
      eventsAfter: (_id: string, after: number, limit: number) => {
        calls.push([after, limit]);
        const page = events.slice(after, after + limit);
        return {
          events: page,
          seqs: page.map((_, i) => after + i + 1),
          lastSeq: after + page.length,
        };
      },
    },
  } as unknown as GraphEngine;
  const { app } = createServer(engine, "test-token");
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${address}/api/runs/run-1/events`, {
      headers: { authorization: "Bearer test-token" },
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.split("\n\n").filter(Boolean).length < 1201) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(calls).toEqual([
      [0, 500],
      [500, 500],
      [1000, 500],
    ]);
    // A later tick asks only for what follows event 1201.
    events.push({ type: "late" });
    while (calls.length < 4) await new Promise((r) => setTimeout(r, 100));
    expect(calls[3]).toEqual([1201, 500]);
    await reader.cancel();
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});

it("returns a bounded page of run events with a nextAfter cursor", async () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ type: `e${i}` }));
  const engine = {
    store: {
      run: () => ({ id: "run-1", plan: { steps: [] } }),
      eventsAfter: (_id: string, after: number, limit: number) => {
        const page = events.slice(after, after + limit);
        return {
          events: page,
          seqs: page.map((_, i) => after + i + 1),
          lastSeq: after + page.length,
        };
      },
    },
  } as unknown as GraphEngine;
  const { app } = createServer(engine, "test-token");
  const headers = { authorization: "Bearer test-token" };
  const get = async (query: string) => {
    const res = await app.inject({
      url: `/api/runs/run-1${query}`,
      headers,
    });
    return { status: res.statusCode, body: res.json() };
  };
  try {
    const first = await get("?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.events.map((e: { type: string }) => e.type)).toEqual([
      "e0",
      "e1",
    ]);
    expect(first.body.nextAfter).toBe(2);
    const last = await get("?after=4&limit=2");
    expect(last.body.events).toHaveLength(1);
    expect(last.body.nextAfter).toBeUndefined();
    const all = await get("");
    expect(all.body.events).toHaveLength(5);
    expect(all.body.nextAfter).toBeUndefined();
    expect((await get("?limit=5001")).status).toBe(400);
    expect((await get("?limit=0")).status).toBe(400);
    expect((await get("?after=-1")).status).toBe(400);
    expect((await get("?after=x")).status).toBe(400);
  } finally {
    await app.close();
  }
});
