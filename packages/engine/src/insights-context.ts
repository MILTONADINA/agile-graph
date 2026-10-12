import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPacket,
  DecisionRecord,
  RunEvent,
} from "@agile-graph/contracts";
import { estimateTokens, tokensForBytes } from "./tokens.js";

/** What one delivered worker packet cost against sending whole files. */
export interface PacketSavings {
  /** The packet's own estimate, memory and outlines included. */
  packetTokens: number;
  /** Tokens of the source excerpts in the packet. */
  excerptTokens: number;
  /** Tokens of the whole files those excerpts came from, each file once. */
  wholeFileTokens: number;
  /** Excerpted files, and those whose size could not be read now. */
  files: number;
  unreadableFiles: number;
}

/**
 * Measures a packet against the whole-file baseline with the engine's own
 * token estimator. It reads file sizes only, never contents, and records
 * counts only, never paths or text.
 */
export async function packetSavings(
  root: string,
  packet: Pick<ContextPacket, "items" | "estimatedTokens">,
): Promise<PacketSavings> {
  const excerpts = packet.items.filter(
    (item) => item.kind !== "memory" && item.source,
  );
  const paths = [...new Set(excerpts.map((item) => item.source!.path))];
  let wholeFileTokens = 0,
    unreadableFiles = 0;
  const base = path.resolve(root);
  for (const file of paths) {
    const full = path.resolve(base, file);
    const relative = path.relative(base, full);
    try {
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("outside the workspace");
      // lstat, not stat: a symlink may point outside the workspace, so it
      // counts as unreadable rather than adding an external file's size.
      const info = await lstat(full);
      if (!info.isFile()) throw new Error("not a regular file");
      wholeFileTokens += tokensForBytes(info.size);
    } catch {
      unreadableFiles++;
    }
  }
  return {
    packetTokens: packet.estimatedTokens,
    excerptTokens: excerpts.reduce(
      (total, item) => total + estimateTokens(item.text),
      0,
    ),
    wholeFileTokens,
    files: paths.length,
    unreadableFiles,
  };
}

export interface ContextSavingsRun {
  runId: string;
  packets: number;
  packetTokens: number;
  excerptTokens: number;
  wholeFileTokens: number;
  /** wholeFileTokens minus excerptTokens; negative when excerpts cost more. */
  savedTokens: number;
  /** excerptTokens / wholeFileTokens, or null without a baseline. */
  ratio: number | null;
  unreadableFiles: number;
}

export interface DecisionQualityRow {
  provider: string;
  category: string;
  questions: number;
  answered: number;
  abstained: number;
  /** Abstention reasons as the engine recorded them, with counts. */
  abstainReasons: Record<string, number>;
  latencyMs: { calls: number; mean: number | null; max: number | null };
  /** Charged USD of the calls whose first question is in this row. */
  spendUsd: number;
  callsWithUnknownCost: number;
}

export interface DecisionAgreementRow {
  providers: [string, string];
  category: string;
  /** Questions both providers answered in the same decision batch. */
  compared: number;
  agreed: number;
  rate: number | null;
}

export interface ContextInsights {
  contextSavings: {
    runs: ContextSavingsRun[];
    total: Omit<ContextSavingsRun, "runId"> & { runs: number };
  };
  decisionQuality: {
    byProviderCategory: DecisionQualityRow[];
    agreement: DecisionAgreementRow[];
  };
  note: string;
}

const numberField = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

function savingsRow(
  runId: string,
  packets: PacketSavings[],
): ContextSavingsRun {
  const sum = (key: keyof PacketSavings) =>
    packets.reduce(
      (total, packet) => total + (numberField(packet[key]) ?? 0),
      0,
    );
  const excerptTokens = sum("excerptTokens"),
    wholeFileTokens = sum("wholeFileTokens");
  return {
    runId,
    packets: packets.length,
    packetTokens: sum("packetTokens"),
    excerptTokens,
    wholeFileTokens,
    savedTokens: wholeFileTokens - excerptTokens,
    ratio: wholeFileTokens > 0 ? excerptTokens / wholeFileTokens : null,
    unreadableFiles: sum("unreadableFiles"),
  };
}

/**
 * Local report: context savings from each run's recorded `context.packet`
 * events, and decision quality from the decision records. Counts and
 * engine-written reasons only; no file contents, paths or state text.
 */
export function summarizeContextInsights(
  runs: readonly { runId: string; events: readonly RunEvent[] }[],
  decisions: readonly DecisionRecord[],
): ContextInsights {
  const runRows = runs
    .map(({ runId, events }) =>
      savingsRow(
        runId,
        events
          .filter((event) => event.type === "context.packet")
          .map((event) => event.data as unknown as PacketSavings),
      ),
    )
    .filter((row) => row.packets > 0);
  const total = savingsRow("", []);
  for (const row of runRows)
    for (const key of [
      "packets",
      "packetTokens",
      "excerptTokens",
      "wholeFileTokens",
      "unreadableFiles",
    ] as const)
      total[key] += row[key];
  total.savedTokens = total.wholeFileTokens - total.excerptTokens;
  total.ratio =
    total.wholeFileTokens > 0
      ? total.excerptTokens / total.wholeFileTokens
      : null;
  const { runId: _unused, ...totals } = total;

  const rows = new Map<string, DecisionQualityRow & { latencies: number[] }>();
  const seenCalls = new Set<string>();
  for (const record of decisions) {
    const key = `${record.provider}\u0000${record.category}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        provider: record.provider,
        category: record.category,
        questions: 0,
        answered: 0,
        abstained: 0,
        abstainReasons: {},
        latencyMs: { calls: 0, mean: null, max: null },
        spendUsd: 0,
        callsWithUnknownCost: 0,
        latencies: [],
      };
      rows.set(key, row);
    }
    row.questions++;
    const failure = record.evidence.failure;
    if (record.selected !== null && failure === undefined) row.answered++;
    else {
      row.abstained++;
      const reason =
        typeof failure === "string" ? failure : "No permitted answer";
      row.abstainReasons[reason] = (row.abstainReasons[reason] ?? 0) + 1;
    }
    const callId = record.evidence.callId;
    if (typeof callId === "string" && !seenCalls.has(callId)) {
      seenCalls.add(callId);
      const latency = numberField(record.evidence.latencyMs);
      if (latency !== null) row.latencies.push(latency);
      const usage = record.evidence.usage as
        { chargedUsd?: unknown } | undefined;
      if (usage) {
        const charged = numberField(usage.chargedUsd);
        if (charged === null) row.callsWithUnknownCost++;
        else row.spendUsd += charged;
      }
    }
  }
  const byProviderCategory = [...rows.values()].map(
    ({ latencies, ...row }) => ({
      ...row,
      latencyMs: {
        calls: latencies.length,
        mean: latencies.length
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : null,
        max: latencies.length ? Math.max(...latencies) : null,
      },
    }),
  );

  // Answers to the same question in the same batch, one per provider.
  const questions = new Map<string, Map<string, DecisionRecord>>();
  for (const record of decisions) {
    const { batchId, questionId, failure } = record.evidence;
    if (
      typeof batchId !== "string" ||
      typeof questionId !== "string" ||
      record.selected === null ||
      failure !== undefined
    )
      continue;
    const key = `${batchId}\u0000${questionId}`;
    const answers = questions.get(key) ?? new Map<string, DecisionRecord>();
    answers.set(record.provider, record);
    questions.set(key, answers);
  }
  const agreement = new Map<string, DecisionAgreementRow>();
  for (const answers of questions.values()) {
    const providers = [...answers.keys()].sort();
    for (let i = 0; i < providers.length; i++)
      for (let j = i + 1; j < providers.length; j++) {
        const a = answers.get(providers[i]!)!,
          b = answers.get(providers[j]!)!;
        const key = `${providers[i]}\u0000${providers[j]}\u0000${a.category}`;
        const row = agreement.get(key) ?? {
          providers: [providers[i]!, providers[j]!] as [string, string],
          category: a.category,
          compared: 0,
          agreed: 0,
          rate: null,
        };
        row.compared++;
        if (a.selected === b.selected) row.agreed++;
        row.rate = row.agreed / row.compared;
        agreement.set(key, row);
      }
  }
  return {
    contextSavings: {
      runs: runRows,
      total: { runs: runRows.length, ...totals },
    },
    decisionQuality: { byProviderCategory, agreement: [...agreement.values()] },
    note: "Local analysis of recorded runs and decisions. Token counts use the engine's conservative estimator; the baseline is the whole files the delivered excerpts came from. Decisions recorded before batch IDs and latency existed are not paired or timed. Never promotion evidence.",
  };
}
