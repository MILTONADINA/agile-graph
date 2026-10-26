import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { GraphEngine } from "../src/service.js";
import { createServer } from "../src/server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(
  options: {
    dashboardRoot?: string;
    maxEventStreams?: number;
    logRequests?: boolean;
  } = {},
) {
  const engine = {
    store: {
      run: () => ({}),
      eventsAfter: (_id: string, after: number) => ({
        events: [],
        seqs: [],
        lastSeq: after,
      }),
    },
    context: {
      listMemories: () => {
        throw new TypeError("secret detail at /Users/someone/private/file.ts");
      },
      listSnapshots: () => {
        throw new SyntaxError("secret parse detail in /Users/someone/x.json");
      },
      currentSnapshot: () => {
        throw Object.assign(new Error("secret sqlite path /Users/someone/db"), {
          code: "SQLITE_BUSY",
        });
      },
      searchSymbols: () => {
        throw Object.assign(new Error("secret upstream detail"), {
          statusCode: 503,
        });
      },
      neighbors: () => {
        throw new Error("Symbol is not in this snapshot");
      },
      getContext: () => ({ ok: true }),
    },
    refresh: async () => ({}),
  } as unknown as GraphEngine;
  const { app } = createServer(engine, TOKEN, options);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    app.server.closeAllConnections();
    await app.close();
  });
  return { app, address };
}

function expectSecurityHeaders(response: Response, label: string) {
  const csp = response.headers.get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ])
    expect(csp, label).toContain(directive);
  expect(csp, label).not.toContain("unsafe-");
  expect(response.headers.get("x-frame-options"), label).toBe("DENY");
  expect(response.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(response.headers.get("referrer-policy"), label).toBe("no-referrer");
}

describe("dashboard server hardening", () => {
  it("sends the security headers on HTML, JSON, refusals and event streams", async () => {
    const dashboardRoot = await mkdtemp(path.join(os.tmpdir(), "graph-ui-"));
    cleanups.push(() => rm(dashboardRoot, { recursive: true, force: true }));
    await writeFile(path.join(dashboardRoot, "index.html"), "<p>board</p>");
    const { address } = await listen({ dashboardRoot });

    const html = await fetch(`${address}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expectSecurityHeaders(html, "html");
    expectSecurityHeaders(await fetch(`${address}/some/route`), "spa fallback");
    expectSecurityHeaders(
      await fetch(`${address}/api/health`, { headers: auth }),
      "json",
    );
    const unauthorized = await fetch(`${address}/api/health`);
    expect(unauthorized.status).toBe(401);
    expectSecurityHeaders(unauthorized, "401");
    const forbidden = await fetch(`${address}/api/health`, {
      headers: { ...auth, origin: "http://attacker.example" },
    });
    expect(forbidden.status).toBe(403);
    expectSecurityHeaders(forbidden, "403");
    const unknown = await fetch(`${address}/api/nothing`, { headers: auth });
    expect(unknown.status).toBe(404);
    expectSecurityHeaders(unknown, "404");

    const stream = await fetch(`${address}/api/runs/r1/events`, {
      headers: auth,
    });
    expect(stream.status).toBe(200);
    expectSecurityHeaders(stream, "event stream");
    await stream.body!.cancel();
  });

  it("answers 413 for an oversized body and 415 for a wrong content type", async () => {
    const { app, address } = await listen();
    // Injected, not sent over a socket: the server answers 413 and closes the
    // connection while a real client is still writing the body, which some
    // platforms report to the client as ECONNRESET instead of the response.
    const injected = await app.inject({
      method: "POST",
      url: "/api/context",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ query: "x".repeat(1_100_000) }),
    });
    const tooLarge = new Response(null, {
      status: injected.statusCode,
      headers: Object.entries(injected.headers).map(
        ([name, value]) => [name, String(value)] as [string, string],
      ),
    });
    expect(tooLarge.status).toBe(413);
    expectSecurityHeaders(tooLarge, "413");
    const wrongType = await fetch(`${address}/api/context`, {
      method: "POST",
      headers: { ...auth, "content-type": "text/plain" },
      body: "query",
    });
    expect(wrongType.status).toBe(415);
    expectSecurityHeaders(wrongType, "415");
  });

  it("keeps 400 for malformed input", async () => {
    const { address } = await listen();
    const malformed = await fetch(`${address}/api/context`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expectSecurityHeaders(malformed, "400");
    const invalid = await fetch(`${address}/api/context`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("answers 500 with a generic message for an unexpected failure", async () => {
    const { address } = await listen();
    const response = await fetch(`${address}/api/memories`, { headers: auth });
    expect(response.status).toBe(500);
    expectSecurityHeaders(response, "500");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Internal server error" });
    expect(text).not.toMatch(/secret|\/Users|\.ts|at /);
  });

  it("keeps 500 generic for syntax, system-code and 5xx errors and 400 for a plain engine refusal", async () => {
    const { address } = await listen();
    for (const url of [
      "/api/snapshots",
      "/api/snapshots/current",
      "/api/symbols",
    ]) {
      const response = await fetch(`${address}${url}`, { headers: auth });
      expect(response.status, url).toBe(500);
      expect(await response.json(), url).toEqual({
        error: "Internal server error",
      });
    }
    const refusal = await fetch(`${address}/api/neighbors?symbolId=a`, {
      headers: auth,
    });
    expect(refusal.status).toBe(400);
    expect(await refusal.json()).toEqual({
      error: "Symbol is not in this snapshot",
    });
  });

  it("marks event streams uncacheable and unbuffered, caps them with 503, and ends them on shutdown", async () => {
    const { app, address } = await listen({ maxEventStreams: 2 });
    const open = async () =>
      fetch(`${address}/api/runs/r1/events`, { headers: auth });
    const first = await open();
    const second = await open();
    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
    }
    const refused = await open();
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expectSecurityHeaders(refused, "503");

    // Closing the server ends the open streams instead of waiting on them.
    const ended = Promise.all(
      [first, second].map(async (response) => {
        const reader = response.body!.getReader();
        for (;;) if ((await reader.read()).done) return "ended";
      }),
    );
    await app.close();
    expect(await ended).toEqual(["ended", "ended"]);
  });

  describe("request log", () => {
    const engine = {
      context: {
        listMemories: () => {
          throw new TypeError(
            `boom at /Users/someone/private/file.ts password=hunter2hunter2hunter2 ${TOKEN} q=reflected-query&token=secret`,
          );
        },
        listSnapshots: () => {
          throw Object.assign(
            new Error(
              "ENOENT: no such file or directory, open '/home/Jane Doe/private/project.json'",
            ),
            { code: "ENOENT" },
          );
        },
      },
    } as unknown as GraphEngine;
    const capture = () => {
      const lines: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation(((
        chunk: string | Uint8Array,
      ) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      return lines;
    };
    afterEach(() => vi.restoreAllMocks());

    it("writes nothing by default", async () => {
      const lines = capture();
      const { app } = createServer(engine, TOKEN);
      await app.inject({ url: "/api/health?token=secret", headers: auth });
      await app.inject({ url: "/api/memories", headers: auth });
      await app.close();
      expect(lines).toEqual([]);
    });

    const parse = (lines: string[]) =>
      lines.map((line) => {
        expect(line.endsWith("\n")).toBe(true);
        return JSON.parse(line) as Record<string, unknown>;
      });

    it("logs one JSON line with the route pattern, status and duration, not the query", async () => {
      const lines = capture();
      const { app } = createServer(engine, TOKEN, { logRequests: true });
      await app.inject({
        url: "/api/health?token=secret",
        headers: { ...auth, cookie: "sid=cookie-value" },
      });
      await app.inject({ url: "/api/nope?token=secret", headers: auth });
      await app.close();
      expect(lines).toHaveLength(2);
      const [ok, missing] = parse(lines);
      expect(Object.keys(ok!).sort()).toEqual(
        [
          "duration_ms",
          "level",
          "method",
          "request_id",
          "route",
          "status",
          "time",
        ].sort(),
      );
      expect(ok).toMatchObject({
        level: "info",
        method: "GET",
        route: "/api/health",
        status: 200,
      });
      expect(typeof ok!.duration_ms).toBe("number");
      expect(new Date(ok!.time as string).toISOString()).toBe(ok!.time);
      expect(typeof ok!.request_id).toBe("string");
      expect(ok!.request_id).not.toBe(missing!.request_id);
      expect(missing).toMatchObject({ level: "warn", route: "(unmatched)" });
      const all = lines.join("");
      for (const leak of ["secret", TOKEN, "cookie-value", "?"])
        expect(all).not.toContain(leak);
    });

    it("never logs authorization, cookie or token headers or an inbound request id", async () => {
      const lines = capture();
      const { app } = createServer(engine, TOKEN, { logRequests: true });
      await app.inject({
        url: "/api/health?access_token=abc123&api_key=xyz789",
        headers: {
          ...auth,
          cookie: "sid=cookie-value",
          "x-api-token": "header-token-value",
          "x-request-id": "caller-chosen-id",
        },
      });
      await app.close();
      const all = lines.join("");
      for (const leak of [
        TOKEN,
        "Bearer",
        "authorization",
        "cookie-value",
        "header-token-value",
        "abc123",
        "xyz789",
        "caller-chosen-id",
      ])
        expect(all).not.toContain(leak);
    });

    it("logs a 500 at error level with a redacted message and no stack or body", async () => {
      const lines = capture();
      const { app } = createServer(engine, TOKEN, { logRequests: true });
      const response = await app.inject({
        url: "/api/memories?q=reflected-query&token=secret",
        headers: auth,
      });
      await app.close();
      expect(response.statusCode).toBe(500);
      expect(lines).toHaveLength(1);
      const [entry] = parse(lines);
      expect(entry).toMatchObject({
        level: "error",
        method: "GET",
        route: "/api/memories",
        status: 500,
      });
      expect(entry!.error).toMatchObject({ name: "TypeError" });
      expect(Object.keys(entry!.error as object).sort()).toEqual([
        "message",
        "name",
      ]);
      const all = lines.join("");
      expect(all).not.toContain("Internal server error");
      for (const leak of [
        "hunter2",
        "/Users/someone",
        "secret",
        TOKEN,
        "reflected-query",
        "\\n    at ",
      ])
        expect(all).not.toContain(leak);
    });

    it("redacts a quoted path that contains spaces", async () => {
      const lines = capture();
      const { app } = createServer(engine, TOKEN, { logRequests: true });
      const response = await app.inject({
        url: "/api/snapshots",
        headers: auth,
      });
      await app.close();
      expect(response.statusCode).toBe(500);
      const [entry] = parse(lines);
      expect(entry).toMatchObject({ level: "error", route: "/api/snapshots" });
      const all = lines.join("");
      expect(all).toContain("ENOENT");
      for (const leak of ["Jane", "Doe", "private", "project.json"])
        expect(all).not.toContain(leak);
    });

    it("logs an event stream when it closes", async () => {
      const lines = capture();
      const { address } = await listen({ logRequests: true });
      const stream = await fetch(`${address}/api/runs/r1/events?token=secret`, {
        headers: auth,
      });
      expect(stream.status).toBe(200);
      await stream.body!.cancel();
      await vi.waitFor(() =>
        expect(lines.join("")).toMatch(
          /"route":"\/api\/runs\/:id\/events","status":200/,
        ),
      );
      expect(lines.join("")).not.toContain("secret");
    });
  });
});
