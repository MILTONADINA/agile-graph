import { command } from "../util.js";

/**
 * Raised when a named Docker container may still be running after cleanup.
 * The message names the container and the command that removes it, so a run
 * that timed out never reports only "Command terminated".
 */
export class ContainerRemovalError extends Error {
  constructor(
    readonly container: string,
    options?: ErrorOptions,
  ) {
    const cause = options?.cause;
    const prefix =
      cause === undefined
        ? ""
        : `${cause instanceof Error ? cause.message : String(cause)}; `;
    super(
      `${prefix}container ${container} could not be confirmed removed; remove it with: docker rm -f ${container}`,
      options,
    );
    this.name = "ContainerRemovalError";
  }
}

/**
 * Removes a named container. When `mayBeRunning` is false (its `docker run`
 * returned normally, so it has exited), removal is best effort. Otherwise
 * `docker rm -f` exiting 0 is proof it is gone, and failing that only a
 * successful daemon listing without the name is (`--rm` may already have
 * removed it). Without proof this throws ContainerRemovalError, carrying
 * `cause` (the step's own error) when there is one. A failed `docker kill`
 * needs no separate report: this check is its backstop.
 */
export async function removeContainer(
  name: string,
  mayBeRunning: boolean,
  cause?: unknown,
): Promise<void> {
  const removed = await command("docker", ["rm", "-f", name], {
    timeoutMs: 5000,
  }).catch(() => undefined);
  if (removed?.code === 0 || !mayBeRunning) return;
  const listed = await command(
    "docker",
    ["ps", "-a", "--format", "{{.Names}}"],
    { timeoutMs: 5_000, maxBytes: 100_000 },
  ).catch(() => undefined);
  if (listed?.code === 0 && !listed.stdout.split(/\r?\n/).includes(name))
    return;
  throw new ContainerRemovalError(
    name,
    cause === undefined ? undefined : { cause },
  );
}
