import { displayFinding, type SecurityFinding } from "./scan.js";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

type SarifFinding = Pick<
  SecurityFinding,
  "tool" | "rule" | "path" | "line" | "message" | "fingerprint"
>;

/**
 * A SARIF 2.1.0 log of scan findings, for code hosts, editors and other
 * review tools. It holds only what the scan reports: callers pass messages
 * already redacted, and paths stay repository-relative. With `newFingerprints`
 * each result says whether the reviewed baseline already held it.
 */
export function toSarif(
  findings: readonly SarifFinding[],
  version: string,
  options: { newFingerprints?: ReadonlySet<string> } = {},
) {
  const rules: { id: string; name: string }[] = [];
  const ruleIds = new Set<string>();
  const results = findings.map((finding) => {
    const ruleId = `${finding.tool}/${finding.rule}`;
    if (!ruleIds.has(ruleId)) {
      ruleIds.add(ruleId);
      rules.push({ id: ruleId, name: finding.rule });
    }
    return {
      ruleId,
      level: "warning" as const,
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: finding.path.replaceAll("\\", "/") },
            ...(Number.isInteger(finding.line) && finding.line > 0
              ? { region: { startLine: finding.line } }
              : {}),
          },
        },
      ],
      partialFingerprints: { "graphEngineering/v1": finding.fingerprint },
      ...(options.newFingerprints
        ? {
            baselineState: options.newFingerprints.has(finding.fingerprint)
              ? ("new" as const)
              : ("unchanged" as const),
          }
        : {}),
      properties: { tool: finding.tool },
    };
  });
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0" as const,
    runs: [
      {
        tool: {
          driver: {
            name: "graph-engineering",
            version,
            informationUri: "https://github.com/MILTONADINA/graph-engineering",
            rules,
          },
        },
        results,
      },
    ],
  };
}

/**
 * The SARIF a scan writes: every finding, with tool-quoted text redacted as
 * it is for display, each marked new or unchanged against the baseline.
 */
export function scanSarif(
  findings: readonly SecurityFinding[],
  fresh: readonly SecurityFinding[],
  version: string,
) {
  return toSarif(findings.map(displayFinding), version, {
    newFingerprints: new Set(fresh.map((finding) => finding.fingerprint)),
  });
}
