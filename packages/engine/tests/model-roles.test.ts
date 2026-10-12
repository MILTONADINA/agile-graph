import { describe, expect, it } from "vitest";
import type { ExecutionPlan, ProviderConfig } from "@agile-graph/contracts";
import { modelRoles } from "../src/service.js";

describe("model role locality", () => {
  it("counts every non-worker step as local without changing provider roles", () => {
    // A kind the step schema does not admit, as a future kind would be,
    // counts as local too, so the boundary errs conservatively.
    const plan = {
      steps: [
        { id: "later", kind: "future" },
        { id: "regenerate", kind: "generator" },
        { id: "implement", kind: "worker", providerId: "cloud" },
        { id: "test", kind: "worker", providerId: "qwen" },
        { id: "removed", kind: "worker", providerId: "retired" },
      ],
    } as unknown as ExecutionPlan;
    const providers: ProviderConfig[] = [
      { id: "cloud", kind: "anthropic", model: "claude" },
      { id: "qwen", kind: "local", model: "qwen" },
    ];

    expect(modelRoles(plan, providers, "cloud")).toEqual([
      { role: "future step later", local: true },
      { role: "generator step regenerate", local: true },
      { role: "step implement (cloud)", local: false },
      { role: "step test (qwen)", local: true },
      { role: "the reviewer (cloud)", local: false },
    ]);
  });
});
