// A failure that holds for a whole run, not just the step that met it (a
// changed policy, plan or project, a spent cost or turn budget, a moved
// provider). The error object is tagged where it is thrown, so a DAG can stop
// starting steps on it without matching message text, and every other caller
// sees the same error it always did.
const tagged = new WeakSet<object>();

/** Tags the error (not a copy) and returns it, for `throw markRunWide(...)`. */
export function markRunWide<T>(error: T): T {
  if (typeof error === "object" && error !== null) tagged.add(error);
  return error;
}

/** Whether the error, or an error it wraps, was tagged run-wide. */
export function isRunWide(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if (tagged.has(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
