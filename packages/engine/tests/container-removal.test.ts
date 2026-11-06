import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";

// #273: every docker call is stubbed. `docker run` ends the way a timed-out
// check does (rejected, so its container may still run), and each case decides
// how `docker rm -f` and the follow-up `docker ps -a` listing end.
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  checked: vi.fn(),
  actual: undefined as undefined | typeof import("../src/util.js"),
}));
vi.mock("../src/util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util.js")>();
  mocks.actual = actual;
  mocks.checked.mockImplementation(actual.checked);
  return { ...actual, command: mocks.command, checked: mocks.checked };
});
import { verifyInContainer } from "../src/execution/docker.js";
import { ContainerRemovalError } from "../src/execution/container-removal.js";
import {
  OSV_DATABASE_HOST,
  runSecurityScan,
  updateOsvDatabase,
} from "../src/security/scan.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const TERMINATED = "Command terminated (SIGKILL)";
type Result = { code: number; stdout: string; stderr: string };
type Outcome = () => Promise<Result>;
const ok: Outcome = async () => ({ code: 0, stdout: "", stderr: "" });
const exit1: Outcome = async () => ({
  code: 1,
  stdout: "",
  stderr: "Error response from daemon: synthetic removal failure",
});
const rejects: Outcome = async () => {
  throw new Error("Command terminated (timeout or cancellation)");
};

const directories: string[] = [];
const directory = async (prefix: string) => {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(created);
  return created;
};
afterEach(async () => {
  mocks.command.mockReset();
  for (const created of directories.splice(0))
    await rm(created, { recursive: true, force: true });
});

/** Stubs docker; `docker run` rejects unless `runOk`. Returns run names and mounts. */
function fakeDocker(rmResult: Outcome, psResult: Outcome, runOk = false) {
  const runs: string[][] = [];
  const calls: string[] = [];
  mocks.command.mockImplementation(
    async (executable: string, argv: string[], options?: object) => {
      if (executable !== "docker")
        return mocks.actual!.command(executable, argv, options);
      calls.push(argv[0]!);
      if (argv[0] === "image")
        return { code: 0, stdout: `${IMAGE_ID}\n`, stderr: "" };
      if (argv[0] === "run") {
        runs.push(argv);
        if (runOk) return { code: 0, stdout: "", stderr: "" };
        throw new Error(TERMINATED);
      }
      if (argv[0] === "rm") return rmResult();
      if (argv[0] === "ps") {
        const listed = await psResult();
        // A successful listing still shows the surviving container.
        const name = runs.at(-1)![runs.at(-1)!.indexOf("--name") + 1]!;
        return listed.code === 0 ? { ...listed, stdout: `${name}\n` } : listed;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  mocks.checked.mockImplementation(
    async (executable: string, argv: string[], options?: object) => {
      if (executable === "docker") return IMAGE_ID;
      return mocks.actual!.checked(executable, argv, options);
    },
  );
  const nameOf = (argv: string[]) => argv[argv.indexOf("--name") + 1]!;
  const mountOf = (argv: string[], target: string) => {
    for (const entry of argv) {
      const match = /^type=bind,source=(.+),target=([^,]+)(,readonly)?$/.exec(
        entry,
      );
      if (match?.[2] === target) return match[1]!;
    }
    throw new Error(`no mount for ${target}`);
  };
  return { runs, calls, nameOf, mountOf };
}

async function repository() {
  const root = await directory("graph-removal-repo-");
  await mocks.actual!.checked("git", ["init", "-b", "dev"], { cwd: root });
  await writeFile(path.join(root, "toy.js"), "export const value = 1;\n");
  return root;
}

const failures = [
  {
    label: "docker rm -f exits 1 and the listing still shows it",
    rm: exit1,
    ps: ok,
  },
  {
    label: "docker rm -f and the listing both reject",
    rm: rejects,
    ps: rejects,
  },
];

describe("verification container removal (#273)", () => {
  it.each(failures)(
    "a timed-out check names its container and keeps its view when $label",
    async ({ rm: rmResult, ps }) => {
      const root = await repository();
      const docker = fakeDocker(rmResult, ps);
      const error = await verifyInContainer(
        root,
        [{ image: "toy-verify", argv: ["sleep", "300"] }],
        { ...DEFAULT_POLICY, verificationTimeoutSeconds: 3 },
        "toy-snapshot",
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ContainerRemovalError);
      const name = docker.nameOf(docker.runs[0]!);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).toContain(TERMINATED);
      expect((error as Error).cause).toBeInstanceOf(Error);
      // The surviving container may still mount it, so the view stays.
      const view = docker.mountOf(docker.runs[0]!, "/workspace");
      await expect(access(view)).resolves.toBeUndefined();
      directories.push(view);
    },
  );

  it("a timed-out check whose removal is confirmed rejects as before and removes its view", async () => {
    const root = await repository();
    const docker = fakeDocker(ok, ok);
    await expect(
      verifyInContainer(
        root,
        [{ image: "toy-verify", argv: ["sleep", "300"] }],
        { ...DEFAULT_POLICY, verificationTimeoutSeconds: 3 },
        "toy-snapshot",
      ),
    ).rejects.toThrow(new Error(TERMINATED));
    const view = docker.mountOf(docker.runs[0]!, "/workspace");
    await expect(access(view)).rejects.toMatchObject({ code: "ENOENT" });
    expect(docker.calls).not.toContain("ps");
  });

  it("trusts a listing without the name when --rm already removed the container", async () => {
    const root = await repository();
    const docker = fakeDocker(exit1, async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    // The ps stub appends the name to a successful listing; replace it.
    const original = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation(
      async (executable, argv: string[], options?: object) =>
        argv[0] === "ps"
          ? { code: 0, stdout: "some-other-container\n", stderr: "" }
          : original(executable, argv, options),
    );
    await expect(
      verifyInContainer(
        root,
        [{ image: "toy-verify", argv: ["sleep", "300"] }],
        { ...DEFAULT_POLICY, verificationTimeoutSeconds: 3 },
        "toy-snapshot",
      ),
    ).rejects.toThrow(new Error(TERMINATED));
    const view = docker.mountOf(docker.runs[0]!, "/workspace");
    await expect(access(view)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a check that completed does not list containers when rm -f fails", async () => {
    const root = await repository();
    const docker = fakeDocker(exit1, rejects, true);
    const results = await verifyInContainer(
      root,
      [{ image: "toy-verify", argv: ["true"] }],
      DEFAULT_POLICY,
      "toy-snapshot",
    );
    expect(results).toHaveLength(1);
    expect(docker.calls).not.toContain("ps");
  });
});

describe("security scan container removal (#273)", () => {
  it.each(failures)(
    "a scanner that may survive fails the scan by name when $label",
    async ({ rm: rmResult, ps }) => {
      const root = await directory("graph-removal-scan-");
      await writeFile(path.join(root, "package-lock.json"), "{}\n");
      const database = await directory("graph-removal-db-");
      const before = new Set(await readdir(os.tmpdir()));
      const docker = fakeDocker(rmResult, ps);
      const error = await runSecurityScan({
        root,
        image: "graph-security:local",
        profile: {
          files: ["package-lock.json"],
          authorizedTargets: [],
          configuredTools: [],
        },
        osvDatabase: database,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ContainerRemovalError);
      const name = docker.nameOf(docker.runs[0]!);
      expect((error as Error).message).toContain(name);
      // Only the first scanner ran: the scan stopped instead of recording it.
      expect(docker.runs).toHaveLength(1);
      // Its work directory, still mounted by the survivor, is kept.
      const scan = docker.mountOf(docker.runs[0]!, "/scan");
      await expect(access(scan)).resolves.toBeUndefined();
      for (const entry of await readdir(os.tmpdir()))
        if (!before.has(entry) && entry.startsWith("graph-security-"))
          directories.push(path.join(os.tmpdir(), entry));
    },
  );

  it("a scanner timeout with confirmed removal is recorded per tool and the scan continues", async () => {
    const root = await directory("graph-removal-scan-");
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    const database = await directory("graph-removal-db-");
    const docker = fakeDocker(ok, ok);
    const scan = await runSecurityScan({
      root,
      image: "graph-security:local",
      profile: {
        files: ["package-lock.json"],
        authorizedTargets: [],
        configuredTools: [],
      },
      osvDatabase: database,
    });
    expect(docker.runs.length).toBe(scan.tools.length);
    expect(docker.runs.length).toBeGreaterThan(1);
    expect(scan.errors).toHaveLength(scan.tools.length);
    for (const error of scan.errors) expect(error).toContain(TERMINATED);
  });

  it.each(failures)(
    "a database download that may survive fails by name and drops the freshness stamp when $label",
    async ({ rm: rmResult, ps }) => {
      const root = await directory("graph-removal-osv-");
      const dataDir = await directory("graph-removal-data-");
      await writeFile(path.join(root, "package-lock.json"), "{}\n");
      const download = () =>
        updateOsvDatabase({
          root,
          dataDir,
          image: "graph-security:local",
          files: ["package-lock.json"],
          policy: { network: "allowlisted", allowedHosts: [OSV_DATABASE_HOST] },
        });
      // A first, successful download writes the stamp.
      fakeDocker(ok, ok, true);
      const first = await download();
      await expect(
        access(path.join(first.path, "graph-updated.json")),
      ).resolves.toBeUndefined();
      const docker = fakeDocker(rmResult, ps);
      const error = await download().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ContainerRemovalError);
      expect((error as Error).message).toContain(
        docker.nameOf(docker.runs[0]!),
      );
      await expect(
        access(path.join(first.path, "graph-updated.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const scan = docker.mountOf(docker.runs[0]!, "/scan");
      directories.push(path.dirname(scan));
    },
  );
});
