import {
  isInstalledKind,
  type ProjectPolicy,
  type ProviderKind,
} from "@agile-graph/contracts";

/** null deliberately means completion-driven, never a missing default. */
export function installedWorkerTimeoutMs(policy: ProjectPolicy): number | null {
  const seconds = policy.installedWorkerTimeoutSeconds;
  return seconds === null ? null : (seconds ?? policy.timeoutSeconds) * 1000;
}

/** Unknown and non-installed providers always keep the ordinary deadline. */
export function workerTimeoutMs(
  policy: ProjectPolicy,
  kind: ProviderKind | undefined,
): number | null {
  return kind !== undefined && isInstalledKind(kind)
    ? installedWorkerTimeoutMs(policy)
    : policy.timeoutSeconds * 1000;
}
