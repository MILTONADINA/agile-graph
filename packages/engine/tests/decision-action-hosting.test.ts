import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type DecisionRecord,
} from "@graph-engineering/contracts";
import {
  DECISION_ESCALATION_FLOOR,
  decideBatch,
  decisionAction,
  type DecisionBatchOptions,
  type DecisionQuestion,
} from "../src/decision-batch.js";
import {
  decisionProviderSchema,
  decisionProviders,
  providerHosting,
  type DecisionProvider,
  type PromotionEvidence,
} from "../src/decisions.js";
import { routePlan } from "../src/planning.js";
import { RunStore } from "../src/store.js";
import * as promotionAuthority from "../src/promotion-authority.js";
import * as promotionRoute from "../src/promotion-route.js";

// Synthetic toy providers and questions only; no request leaves the process.
const model = "toy-action-model";
const directories: string[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const tempDir = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-action-"));
  directories.push(directory);
  return directory;
};
const proof = (category: string): PromotionEvidence => ({
  version: "b".repeat(64),
  category,
  provider: "laya",
  model,
  calibrationCount: 60,
  heldOutCount: 240,
  taskCount: 60,
  policyViolations: 0,
  additionalFailures: 0,
  baselineCost: 60,
  candidateCost: 30,
  calibrationError: 0.01,
  minimumConfidence: 0.9,
  dataOrigin: "recorded",
  provenanceComplete: true,
  datasetId: "toy-fixture",
});
const question = (exportable = true): DecisionQuestion => ({
  id: "workflow",
  category: "workflow",
  candidates: { safe: "Baseline", alternative: "Alternative" },
  baseline: "safe",
  exportable,
});
const laya = (): DecisionProvider => ({
  id: "laya",
  model,
  endpoint: "http://127.0.0.1:7337/v1/decide",
  maxStateChars: 1200,
});
const hostedProvider = (id: string): DecisionProvider => ({
  id,
  ...(id === "jev" ? {} : { hosting: "hosted" as const }),
  model,
  endpoint: "https://api.example.test/decide",
  maxStateChars: 1200,
  pricing: { unit: "question", usdPerUnit: 0.002, version: "toy-price" },
});
const options = (
  mode: "shadow" | "promoted" = "shadow",
): DecisionBatchOptions => ({
  projectId: "toy-action-project",
  state: { files: 2 },
  cloudState: { files: 2 },
  questions: [question()],
  policy: {
    ...DEFAULT_POLICY,
    inference: "allowlisted",
    network: "allowlisted",
    allowedHosts: ["api.example.test"],
    providers: ["laya", "jev", "acme"],
    decisionMode: mode,
    promotedCategories: mode === "promoted" ? ["workflow"] : [],
    maxCostUsd: null,
  },
  providers: [laya()],
  evidence: [proof("workflow")],
});
const answer = (choice: string, confidence?: number) =>
  new Response(
    JSON.stringify({
      model,
      answers: {
        workflow:
          confidence === undefined ? { choice } : { choice, confidence },
      },
    }),
  );
// Promotion is unreachable without a verified issuer, so the promoted paths
// below stub authority and the route check, as decision-batch.test.ts does.
const admitPromotion = () => {
  vi.spyOn(
    promotionAuthority,
    "authorizesPromotionFromBinding",
  ).mockResolvedValue(true);
  vi.spyOn(promotionRoute, "checkPromotionRoute").mockImplementation(
    (phase) => ({
      phase,
      admitted: true,
      refusal: null,
      routeSha256: "0".repeat(64),
    }),
  );
};

describe("engine-derived decision action labels", () => {
  it("labels auto only for a promoted applied answer at its threshold with complete context", () => {
    const base = {
      mode: "promoted" as const,
      selected: "alternative",
      confidence: 0.9,
      failed: false,
      threshold: 0.9,
      contextComplete: true,
    };
    expect(decisionAction(base)).toBe("auto");
    expect(decisionAction({ ...base, mode: "shadow" })).toBe("review");
    expect(decisionAction({ ...base, contextComplete: false })).toBe("review");
    expect(decisionAction({ ...base, confidence: 0.89 })).toBe("escalate");
    expect(decisionAction({ ...base, confidence: null })).toBe("escalate");
    expect(decisionAction({ ...base, selected: null })).toBe("escalate");
    expect(decisionAction({ ...base, failed: true })).toBe("escalate");
    expect(decisionAction({ ...base, confidence: Number.NaN })).toBe(
      "escalate",
    );
  });
  it("applies the documented floor when no promotion threshold is in use", () => {
    expect(DECISION_ESCALATION_FLOOR).toBe(0.5);
    const shadow = {
      mode: "shadow" as const,
      selected: "safe",
      failed: false,
      threshold: null,
      contextComplete: true,
    };
    expect(decisionAction({ ...shadow, confidence: 0.5 })).toBe("review");
    expect(decisionAction({ ...shadow, confidence: 0.49 })).toBe("escalate");
    // With no threshold even a promoted record needs the floor; the model's
    // own confidence never labels itself auto below it.
    expect(
      decisionAction({ ...shadow, mode: "promoted", confidence: 0.49 }),
    ).toBe("escalate");
  });
  it("labels usable shadow answers review and never auto", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer("alternative", 0.99)),
    );
    const result = await decideBatch(options("shadow"));
    expect(result.records[0]).toMatchObject({
      mode: "shadow",
      selected: "alternative",
      action: "review",
    });
    expect(result.records[0]!.evidence.contextComplete).toBe(true);
  });
  it("escalates failed calls, malformed or refused answers and low confidence", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    fetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect((await decideBatch(options())).records[0]?.action).toBe("escalate");
    fetch.mockResolvedValueOnce(answer("not-a-candidate", 0.99));
    expect((await decideBatch(options())).records[0]?.action).toBe("escalate");
    fetch.mockResolvedValueOnce(answer("alternative"));
    expect((await decideBatch(options())).records[0]?.action).toBe("escalate");
    // Below the matching report's 0.9 threshold even in shadow.
    fetch.mockResolvedValueOnce(answer("alternative", 0.8));
    expect((await decideBatch(options())).records[0]?.action).toBe("escalate");
    // No report applies: the floor decides.
    fetch.mockResolvedValueOnce(answer("alternative", 0.4));
    expect(
      (await decideBatch({ ...options(), evidence: [] })).records[0]?.action,
    ).toBe("escalate");
    fetch.mockResolvedValueOnce(answer("alternative", 0.6));
    expect(
      (await decideBatch({ ...options(), evidence: [] })).records[0]?.action,
    ).toBe("review");
  });
  it("labels a promoted answer auto, but review when the caller truncated its state", async () => {
    admitPromotion();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer("alternative", 0.95)),
    );
    const promoted = await decideBatch(options("promoted"));
    expect(promoted.records[0]).toMatchObject({
      mode: "promoted",
      action: "auto",
    });
    const truncated = await decideBatch({
      ...options("promoted"),
      stateTruncated: true,
    });
    expect(truncated.records[0]).toMatchObject({
      mode: "promoted",
      action: "review",
    });
    expect(truncated.records[0]!.evidence.contextComplete).toBe(false);
  });
  it("escalates a promoted answer the engine withholds below its threshold", async () => {
    admitPromotion();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer("alternative", 0.7)),
    );
    const result = await decideBatch(options("promoted"));
    expect(result.records[0]).toMatchObject({
      mode: "promoted",
      selected: null,
      action: "escalate",
    });
    expect(result.selections.workflow).toBe("safe");
  });
  it("relabels a revoked promoted record escalate when policy changes in flight", async () => {
    admitPromotion();
    const input = options("promoted");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        input.policy.network = "deny";
        return answer("alternative", 0.99);
      }),
    );
    const result = await decideBatch(input);
    expect(result.records[0]).toMatchObject({
      mode: "shadow",
      action: "escalate",
    });
  });
  it("marks a routing decision with a cut objective as incomplete context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model,
            answers: Object.fromEntries(
              Object.keys(body.questions).map((key) => [
                key,
                {
                  choice: Object.keys(body.questions[key].criteria)[0],
                  confidence: 0.8,
                },
              ]),
            ),
          }),
        );
      }),
    );
    const plan = (objective: string) =>
      routePlan({
        projectId: "toy-action-project",
        objective,
        provider: { id: "local", kind: "local", model: "toy-worker" },
        policy: options().policy,
        providers: [laya()],
        evidence: [],
      });
    const short = await plan("Fix a failing toy test");
    expect(
      short.records.every((record) => record.evidence.contextComplete === true),
    ).toBe(true);
    const long = await plan(`Fix a failing toy test ${"x".repeat(900)}`);
    expect(
      long.records.every((record) => record.evidence.contextComplete === false),
    ).toBe(true);
  });
  it("reads decision rows stored before the action label existed", async () => {
    const store = new RunStore(await tempDir(), "toy-action-project");
    stores.push(store);
    const legacy: DecisionRecord = {
      version: "1.0.0",
      id: "legacy-decision",
      projectId: "toy-action-project",
      category: "workflow",
      candidates: ["safe", "alternative"],
      selected: "alternative",
      baseline: "safe",
      provider: "laya",
      modelVersion: model,
      policyVersion: "c".repeat(64),
      confidence: 0.8,
      mode: "shadow",
      createdAt: new Date(0).toISOString(),
      evidence: {},
    };
    store.decision(legacy);
    const [read] = store.decisions();
    expect(read).toEqual(legacy);
    expect(read?.action).toBeUndefined();
  });
});

describe("hosted decision providers are guarded by hosting, not name", () => {
  it("defaults hosting for the built-in ids and keeps existing decisions.json files loading", async () => {
    const directory = await tempDir();
    await writeFile(
      path.join(directory, "decisions.json"),
      JSON.stringify([laya(), hostedProvider("jev")]),
    );
    const loaded = await decisionProviders(directory);
    expect(loaded.map((provider) => provider.hosting)).toEqual([
      undefined,
      undefined,
    ]);
    expect(loaded.map(providerHosting)).toEqual(["local", "hosted"]);
    expect(providerHosting(hostedProvider("acme"))).toBe("hosted");
  });
  it("a hosted provider with another id refuses non-exportable state exactly as jev does", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const failures = async (id: string) => {
      const base = { ...options(), providers: [hostedProvider(id)] };
      const noCloudState = { ...base };
      delete noCloudState.cloudState;
      const notExportable = { ...base, questions: [question(false)] };
      return [
        (await decideBatch(noCloudState)).records[0]?.evidence.failure,
        (await decideBatch(notExportable)).records[0]?.evidence.failure,
      ];
    };
    const jev = await failures("jev");
    const acme = await failures("acme");
    expect(jev).toEqual([
      "Hosted decisions require explicitly exportable state and questions",
      "Hosted decisions require explicitly exportable state and questions",
    ]);
    expect(acme).toEqual(jev);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends a hosted provider with another id only its reviewed cloud state", async () => {
    const fetch = vi.fn(async () => answer("alternative", 0.9));
    vi.stubGlobal("fetch", fetch);
    await decideBatch({
      ...options(),
      state: { files: 2, secretPlan: "local only" },
      cloudState: { files: 2 },
      providers: [hostedProvider("acme")],
    });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(JSON.parse(body.state)).toEqual({ files: 2 });
  });
  it("applies offline policy and metered cost caps to any hosted id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const offline = options();
    offline.policy = { ...offline.policy, network: "deny" };
    offline.providers = [hostedProvider("acme")];
    // A denied network refuses the remote endpoint before the offline check.
    expect((await decideBatch(offline)).records[0]?.evidence.failure).toMatch(
      /denies endpoint|offline policy/,
    );
    const capped = options();
    capped.policy = { ...capped.policy, maxCostUsd: 1 };
    capped.providers = [{ ...hostedProvider("acme"), pricing: undefined }];
    expect((await decideBatch(capped)).records[0]?.evidence.failure).toContain(
      "Unknown hosted pricing",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a provider named jev configured as local instead of bypassing the guard", async () => {
    const relabelled = { ...hostedProvider("jev"), hosting: "local" as const };
    expect(decisionProviderSchema.safeParse(relabelled).success).toBe(false);
    expect(
      decisionProviderSchema.safeParse({ ...laya(), hosting: "hosted" })
        .success,
    ).toBe(false);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const input = { ...options(), providers: [relabelled] };
    delete input.cloudState;
    await expect(decideBatch(input)).rejects.toThrow(/must be hosted/);
    const directory = await tempDir();
    await writeFile(
      path.join(directory, "decisions.json"),
      JSON.stringify([relabelled]),
    );
    await expect(decisionProviders(directory)).rejects.toThrow(
      /must be hosted/,
    );
    // Even an object that skipped validation keeps jev's fixed hosting.
    expect(providerHosting(relabelled)).toBe("hosted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires another id to declare hosting and keeps a local one on loopback", async () => {
    const undeclared = { ...hostedProvider("acme") };
    delete undeclared.hosting;
    expect(decisionProviderSchema.safeParse(undeclared).success).toBe(false);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const remoteLocal = options();
    remoteLocal.providers = [
      { ...hostedProvider("acme"), hosting: "local", pricing: undefined },
    ];
    expect(
      (await decideBatch(remoteLocal)).records[0]?.evidence.failure,
    ).toContain("loopback");
    expect(fetch).not.toHaveBeenCalled();
  });
});
