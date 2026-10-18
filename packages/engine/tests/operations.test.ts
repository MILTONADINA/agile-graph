import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  DEFAULT_POLICY,
  SCHEMA_VERSION,
  type ProjectConfig,
} from "@agile-graph/contracts";
import { ContextEngine } from "../src/context/index.js";
import { RunStore } from "../src/store.js";
import { backupProject, restoreProject } from "../src/operations.js";

const directories: string[] = [],
  engines: ContextEngine[] = [],
  stores: RunStore[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "graph-operations-"));
  directories.push(directory);
  const root = join(directory, "repo"),
    dataDir = join(directory, "data");
  await mkdir(root);
  await mkdir(dataDir);
  await writeFile(
    join(root, "main.ts"),
    "export function main() { return 1; }",
  );
  const projectId = "operations-project",
    config: ProjectConfig = {
      version: SCHEMA_VERSION,
      projectId,
      name: "Operations",
      policy: structuredClone(DEFAULT_POLICY),
      verification: [],
    };
  const context = new ContextEngine({
    projectId,
    root,
    dataDir,
    policy: config.policy,
  });
  engines.push(context);
  const store = new RunStore(dataDir, projectId);
  stores.push(store);
  const snapshot = await context.index();
  store.savePlan({ id: "plan-1", projectId, snapshotId: snapshot.id } as any);
  await writeFile(
    join(dataDir, "providers.json"),
    JSON.stringify([
      {
        id: "local",
        kind: "local",
        model: "local-model",
        endpoint: "http://127.0.0.1:11434/v1",
        apiKeyEnv: "LOCAL_API_KEY",
      },
    ]),
  );
  await writeFile(join(dataDir, "decisions.json"), "[]");
  await writeFile(join(dataDir, "promotions.json"), "[]");
  return {
    directory,
    root,
    dataDir,
    projectId,
    config,
    context,
    store,
    snapshot,
    destination: join(directory, "backup"),
  };
}
afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("project archive lifecycle", () => {
  it("round-trips both stores, private config and unknown costs without copying models or credentials", async () => {
    const fixtureData = await fixture();
    const { directory, dataDir, projectId, store, destination } = fixtureData;
    await mkdir(join(dataDir, "models"));
    await writeFile(join(dataDir, "models/large.onnx"), "excluded weights");
    await writeFile(join(dataDir, ".env"), "excluded environment");
    store.reserveCall("plan-1", "unsettled-call", "local", null, null);
    const manifest = await backupProject(fixtureData);
    expect(manifest.schema.runs).toBe(5);
    expect(manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "context.sqlite",
        "runs.sqlite",
        "providers.json",
        "project-config.reference.json",
      ]),
    );
    expect(manifest.resumePolicy).toBe("manual-reconciliation-required");
    await expect(readFile(join(destination, ".env"))).rejects.toThrow();
    const restoredDir = join(directory, "restored");
    await restoreProject({
      backupDirectory: destination,
      dataDir: restoredDir,
      projectId,
    });
    const restored = new RunStore(restoredDir, projectId);
    stores.push(restored);
    expect(restored.planSnapshotIds()).toEqual([fixtureData.snapshot.id]);
    expect(restored.usage("plan-1").costUsd).toBeNull();
    expect(
      await readFile(join(restoredDir, "providers.json"), "utf8"),
    ).toContain("LOCAL_API_KEY");
    expect(
      await readFile(join(restoredDir, "restore-receipt.json"), "utf8"),
    ).toContain("not restored");
    await expect(
      restoreProject({
        backupDirectory: destination,
        dataDir: restoredDir,
        projectId,
      }),
    ).rejects.toThrow();
  });
  it("rejects active runs and raw credential configuration before creating an archive", async () => {
    const data = await fixture();
    data.store.saveRun({
      id: "run-1",
      status: "running",
      projectId: data.projectId,
    } as any);
    await expect(backupProject(data)).rejects.toThrow("active runs");
    data.store.saveRun({
      id: "run-1",
      status: "cancelled",
      projectId: data.projectId,
    } as any);
    await writeFile(
      join(data.dataDir, "providers.json"),
      JSON.stringify([
        { id: "unsafe", kind: "local", model: "x", apiKey: "never copy me" },
      ]),
    );
    await expect(backupProject(data)).rejects.toThrow("credential");
    await expect(
      readFile(join(data.destination, "manifest.json")),
    ).rejects.toThrow();
  });
  it("refuses cross-project, corrupted, newer-schema and missing-snapshot archives", async () => {
    const data = await fixture();
    await backupProject(data);
    await expect(
      restoreProject({
        backupDirectory: data.destination,
        dataDir: join(data.directory, "wrong"),
        projectId: "other-project",
      }),
    ).rejects.toThrow("identity");
    const manifestPath = join(data.destination, "manifest.json"),
      original = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...original,
        schema: { ...original.schema, runs: 999 },
      }),
    );
    await expect(
      restoreProject({
        backupDirectory: data.destination,
        dataDir: join(data.directory, "future"),
        projectId: data.projectId,
      }),
    ).rejects.toThrow();
    await writeFile(manifestPath, JSON.stringify(original));
    await writeFile(join(data.destination, "providers.json"), "[]");
    await expect(
      restoreProject({
        backupDirectory: data.destination,
        dataDir: join(data.directory, "corrupt"),
        projectId: data.projectId,
      }),
    ).rejects.toThrow("checksum");
    data.store.savePlan({
      id: "orphaned",
      projectId: data.projectId,
      snapshotId: "f".repeat(64),
    } as any);
    await expect(
      backupProject({ ...data, destination: join(data.directory, "orphaned") }),
    ).rejects.toThrow("missing a plan");
  });
  it("does not mark a concurrently changed archive complete", async () => {
    const data = await fixture(),
      original = data.store.backup.bind(data.store);
    vi.spyOn(data.store, "backup").mockImplementation(async (destination) => {
      await original(destination);
      data.store.reserveCall("plan-1", "concurrent", "local", null, null);
    });
    await expect(backupProject(data)).rejects.toThrow("changed during backup");
    await expect(
      readFile(join(data.destination, "manifest.json")),
    ).rejects.toThrow();
  });
  it("run-store migration preserves legacy rows and refuses a newer database", async () => {
    const data = await fixture();
    data.store.close();
    const databasePath = join(data.dataDir, "runs.sqlite"),
      legacy = new Database(databasePath);
    legacy.exec(
      "DROP TABLE inference_calls; DROP TABLE worker_leases; PRAGMA user_version=1;",
    );
    legacy.close();
    const migrated = new RunStore(data.dataDir, data.projectId);
    stores.push(migrated);
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.planSnapshotIds()).toEqual([data.snapshot.id]);
    migrated.close();
    const future = new Database(databasePath);
    future.pragma("user_version=999");
    future.close();
    expect(() => new RunStore(data.dataDir, data.projectId)).toThrow("newer");
  });
});

describe("run store project indexes and orphan check", () => {
  const INDEXED = [
    "plans",
    "runs",
    "decisions",
    "plan_approvals",
    "worker_leases",
    "owner_proofs",
  ];
  const leading = (db: Database.Database, table: string) =>
    (db.pragma(`index_list(${table})`) as { name: string }[]).filter(
      (index) =>
        (
          db.pragma(`index_info(${index.name})`) as {
            seqno: number;
            name: string;
          }[]
        ).find((column) => column.seqno === 0)?.name === "project_id",
    );
  it("adds project_id indexes to an existing database without changing its version", async () => {
    const data = await fixture();
    data.store.close();
    const databasePath = join(data.dataDir, "runs.sqlite"),
      legacy = new Database(databasePath);
    for (const table of INDEXED)
      for (const index of leading(legacy, table))
        if (index.name.endsWith("_project"))
          legacy.exec(`DROP INDEX ${index.name}`);
    legacy.pragma("user_version=5");
    for (const table of INDEXED) expect(leading(legacy, table)).toEqual([]);
    legacy.close();
    const migrated = new RunStore(data.dataDir, data.projectId);
    stores.push(migrated);
    migrated.close();
    const inspect = new Database(databasePath);
    expect(inspect.pragma("user_version", { simple: true })).toBe(5);
    for (const table of INDEXED)
      expect(leading(inspect, table).length).toBeGreaterThan(0);
    const plan = inspect
      .prepare(
        "EXPLAIN QUERY PLAN SELECT json FROM plan_approvals WHERE project_id=?",
      )
      .all("p") as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toMatch(
      /USING (COVERING )?INDEX plan_approvals_project/,
    );
    const ordered = inspect
      .prepare(
        "EXPLAIN QUERY PLAN SELECT json FROM decisions WHERE project_id=? ORDER BY rowid",
      )
      .all("p") as { detail: string }[];
    expect(ordered.map((row) => row.detail).join(" ")).toContain(
      "decisions_project",
    );
    inspect.close();
  });
  it("counts orphan rows as a warning and reports zero for a clean store", async () => {
    const data = await fixture();
    const warnings: string[] = [];
    data.store.saveRun({
      id: "run-1",
      planId: "plan-1",
      projectId: data.projectId,
      status: "succeeded",
    } as any);
    const { countRunStoreOrphans: countClean } =
      await import("../src/operations.js");
    const { ContextDatabase: Ctx } = await import("../src/context/database.js");
    const cleanRuns = new Ctx(join(data.dataDir, "runs.sqlite"), {
      readonly: true,
    });
    try {
      expect(await countClean(cleanRuns)).toEqual({
        runEvents: 0,
        runOutcomes: 0,
        planApprovals: 0,
      });
    } finally {
      await cleanRuns.close();
    }
    await backupProject({
      ...data,
      destination: join(data.directory, "clean"),
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    data.store.close();
    const db = new Database(join(data.dataDir, "runs.sqlite"));
    db.prepare(
      "INSERT INTO run_events(id,run_id,project_id,json) VALUES(?,?,?,?)",
    ).run("e1", "ghost", data.projectId, "{}");
    db.prepare(
      "INSERT INTO run_events(id,run_id,project_id,json) VALUES(?,?,?,?)",
    ).run("e2", "ghost", data.projectId, "{}");
    db.prepare(
      "INSERT INTO run_events(id,run_id,project_id,json) VALUES(?,?,?,?)",
    ).run("e3", "run-1", data.projectId, "{}");
    db.prepare(
      "INSERT INTO run_outcomes(run_id,project_id,json) VALUES(?,?,?)",
    ).run("ghost", data.projectId, "{}");
    db.prepare(
      "INSERT INTO plan_approvals(plan_id,project_id,json) VALUES(?,?,?)",
    ).run("no-plan", data.projectId, "{}");
    db.close();
    const store = new RunStore(data.dataDir, data.projectId);
    stores.push(store);
    const { countRunStoreOrphans } = await import("../src/operations.js");
    const { ContextDatabase } = await import("../src/context/database.js");
    const runs = new ContextDatabase(join(data.dataDir, "runs.sqlite"), {
      readonly: true,
    });
    try {
      expect(await countRunStoreOrphans(runs)).toEqual({
        runEvents: 2,
        runOutcomes: 1,
        planApprovals: 1,
      });
    } finally {
      await runs.close();
    }
    await backupProject({
      ...data,
      store,
      destination: join(data.directory, "orphaned"),
      onWarning: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([
      "Run store has orphan rows (run_events: 2, run_outcomes: 1, plan_approvals: 1); nothing was deleted",
    ]);
  });
  it("treats a table missing from an older archive as zero orphans", async () => {
    const data = await fixture();
    data.store.close();
    const db = new Database(join(data.dataDir, "runs.sqlite"));
    db.exec("DROP TABLE run_outcomes; DROP TABLE plan_approvals;");
    db.close();
    const { countRunStoreOrphans } = await import("../src/operations.js");
    const { ContextDatabase } = await import("../src/context/database.js");
    const runs = new ContextDatabase(join(data.dataDir, "runs.sqlite"), {
      readonly: true,
    });
    try {
      expect(await countRunStoreOrphans(runs)).toEqual({
        runEvents: 0,
        runOutcomes: 0,
        planApprovals: 0,
      });
    } finally {
      await runs.close();
    }
  });
});
