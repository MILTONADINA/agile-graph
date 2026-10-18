import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkerInput, WorkerResult } from "../src/workers/api.js";

type Worker = (input: WorkerInput, workspace: string) => Promise<WorkerResult>;

// A scripted worker that edits a file must first have been shown it, as a
// real worker must: this asks for each of `paths` the context does not yet
// carry, then runs `worker` once they are all in view.
export function viewing(paths: string[], worker: Worker): Worker {
  return async (input, workspace) => {
    const seen = new Set(input.context.items.map((item) => item.source?.path));
    const missing = paths.filter((path) => !seen.has(path));
    if (missing.length)
      return {
        model: "fixture",
        proposal: { summary: "Read the files", requests: missing, changes: [] },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      };
    return worker(input, workspace);
  };
}

// Like `viewing`, for a worker whose edits are not known in advance: runs
// `worker` once, and when it proposes an edit to an existing file the
// context does not carry, answers with a request for those files instead and
// hands the held proposal back on the next call of that step. `worker` is
// therefore called once per logical turn, as before.
export function viewingEdits(worker: Worker): Worker {
  const held = new Map<string, WorkerResult>();
  return async (input, workspace) => {
    const seen = new Set(input.context.items.map((item) => item.source?.path));
    const key = `${input.provider.id}\0${input.objective}`;
    const pending = held.get(key);
    if (pending) {
      held.delete(key);
      return pending;
    }
    const result = await worker(input, workspace);
    const missing = [
      ...new Set(
        result.proposal.changes
          .filter((change) => change.before !== null)
          .map((change) => change.path)
          .filter(
            (file) => !seen.has(file) && existsSync(path.join(workspace, file)),
          ),
      ),
    ];
    if (!missing.length) return result;
    held.set(key, result);
    return {
      ...result,
      proposal: { summary: "Read the files", requests: missing, changes: [] },
    };
  };
}
