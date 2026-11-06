import { afterEach, describe, expect, it, vi } from "vitest";

// The docker call is stubbed, so each case decides how `docker version` ends.
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/util.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util.js")>()),
  command: mocks.command,
}));
import { assertDockerRunning } from "../src/security/scan.js";

afterEach(() => mocks.command.mockReset());

describe("assertDockerRunning (#278)", () => {
  it("says Docker is not installed when the docker binary cannot be started", async () => {
    mocks.command.mockRejectedValue(
      Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
    );
    await expect(assertDockerRunning()).rejects.toThrow(
      "Docker is not installed or not on PATH; install it and retry",
    );
  });

  it("says Docker is not running when docker version exits non-zero", async () => {
    mocks.command.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "daemon down",
    });
    await expect(assertDockerRunning()).rejects.toThrow(
      "Docker is not running; start it and retry",
    );
  });

  it("says Docker is not running when docker version times out", async () => {
    mocks.command.mockRejectedValue(
      new Error("Command terminated (timeout or cancellation)"),
    );
    await expect(assertDockerRunning()).rejects.toThrow(
      "Docker is not running; start it and retry",
    );
  });

  it("passes when the daemon answers", async () => {
    mocks.command.mockResolvedValue({
      code: 0,
      stdout: "27.0.1\n",
      stderr: "",
    });
    await expect(assertDockerRunning()).resolves.toBeUndefined();
    expect(mocks.command).toHaveBeenCalledWith(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      expect.objectContaining({ timeoutMs: 10000 }),
    );
  });
});
