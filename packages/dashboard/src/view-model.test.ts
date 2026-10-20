import { describe, expect, it } from "vitest";
import type { AccountingGroup, AccountingSummary } from "./types";
import { accountingCost, date } from "./view-model";

const emptyGroup = (): AccountingGroup => ({
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
  callCount: 0,
  settledCallCount: 0,
  unresolvedCallCount: 0,
  unknownCostCallCount: 0,
  estimatedCallCount: 0,
  knownCostUsd: 0,
  unresolvedReservedCostUsd: 0,
});
const fixture = (): AccountingSummary => ({
  ...emptyGroup(),
  source: "inference-call-ledger",
  untrackedRunCount: 0,
  planningOnly: {
    ...emptyGroup(),
    savedPlanCallCount: 0,
    unsavedPlanCallCount: 0,
  },
});

describe("ledger usage reporting", () => {
  it("does not present absent measurements as a measured zero", () => {
    expect(accountingCost(null).value).toBe("—");
    expect(accountingCost(fixture())).toMatchObject({
      value: "—",
      detail: "No inference calls recorded",
    });
  });
  it("distinguishes a measured zero, estimated totals, and a partial known subtotal", () => {
    const summary = fixture();
    summary.callCount = 1;
    expect(accountingCost(summary)).toMatchObject({
      label: "Reported total cost",
      value: "$0.0000",
    });
    summary.totals = { ...summary.totals, costUsd: 0.25, estimated: true };
    expect(accountingCost(summary)).toMatchObject({
      label: "Estimated total + reserves",
      value: "$0.2500",
    });
    summary.totals.costUsd = null;
    summary.knownCostUsd = 0.25;
    summary.unknownCostCallCount = 1;
    expect(accountingCost(summary)).toEqual({
      label: "Total cost unknown",
      value: "Unknown",
      detail: "Known subtotal $0.2500; some usage is unreported",
    });
  });
  it("keeps legacy untracked runs unknown even when there are no ledger calls", () => {
    const summary = fixture();
    summary.untrackedRunCount = 1;
    summary.totals.costUsd = null;
    expect(accountingCost(summary).value).toBe("Unknown");
  });
});

describe("date", () => {
  const at = "2026-10-19T21:02:00Z";
  const zoneName = (timeZone: string) =>
    new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "short" })
      .formatToParts(new Date(at))
      .find((part) => part.type === "timeZoneName")?.value;
  it("labels the time zone", () => {
    for (const zone of ["UTC", "America/Chicago"]) {
      const label = zoneName(zone);
      expect(label).toBeTruthy();
      expect(date(at, zone).endsWith(label as string)).toBe(true);
    }
  });
  it("shows different local times per zone", () => {
    expect(date(at, "UTC")).not.toBe(date(at, "America/Chicago"));
  });
  it("keeps the fallbacks", () => {
    expect(date()).toBe("Not yet");
    expect(date("garbage")).toBe("garbage");
  });
});
