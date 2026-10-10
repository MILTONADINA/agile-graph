import { redact } from "../policy.js";
import {
  displayFinding,
  type SecurityFinding,
  type SecurityScan,
} from "./scan.js";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

/** The base every result URI is relative to: the scanned repository's root. */
export const SARIF_SOURCE_ROOT = "%SRCROOT%";

type SarifFinding = Pick<
  SecurityFinding,
  "tool" | "rule" | "path" | "line" | "message" | "fingerprint" | "tags"
>;

/**
 * A repository-relative path as a SARIF artifact location: forward slashes,
 * each segment percent-encoded so a space, `#`, `%` or non-ASCII character
 * cannot be read as URI syntax, relative to the source root.
 */
export function sarifArtifact(file: string) {
  return {
    uri: file
      .replaceAll("\\", "/")
      .split("/")
      .map(encodeURIComponent)
      .join("/"),
    uriBaseId: SARIF_SOURCE_ROOT,
  };
}

/**
 * A SARIF 2.1.0 log of scan findings, for code hosts, editors and other
 * review tools. It holds only what the scan reports: callers pass messages
 * already redacted, and paths stay repository-relative. With `newFingerprints`
 * each result says whether the reviewed baseline already held it. The one
 * invocation is successful only when the scan reported no `errors` and no
 * `unscanned` files; each of those becomes a notification, so a consumer
 * never takes an incomplete scan's results for a clean one.
 */
export function toSarif(
  findings: readonly SarifFinding[],
  version: string,
  options: {
    newFingerprints?: ReadonlySet<string>;
    errors?: readonly string[];
    unscanned?: readonly { path: string; reason: string }[];
  } = {},
) {
  const rules: {
    id: string;
    name: string;
    properties?: { tags: string[] };
  }[] = [];
  const ruleIds = new Set<string>();
  const results = findings.map((finding) => {
    const ruleId = `${finding.tool}/${finding.rule}`;
    const tags = finding.tags?.length ? [...finding.tags] : undefined;
    if (!ruleIds.has(ruleId)) {
      ruleIds.add(ruleId);
      rules.push({
        id: ruleId,
        name: finding.rule,
        ...(tags ? { properties: { tags } } : {}),
      });
    }
    return {
      ruleId,
      level: "warning" as const,
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: sarifArtifact(finding.path),
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
      properties: { tool: finding.tool, ...(tags ? { tags } : {}) },
    };
  });
  const errors = options.errors ?? [];
  const unscanned = options.unscanned ?? [];
  const notifications = [
    ...errors.map((error) => ({
      level: "error" as const,
      message: { text: error },
    })),
    ...unscanned.map((file) => ({
      level: "warning" as const,
      message: { text: `Not scanned: ${file.path} (${file.reason})` },
      locations: [
        { physicalLocation: { artifactLocation: sarifArtifact(file.path) } },
      ],
    })),
  ];
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
        invocations: [
          {
            executionSuccessful: notifications.length === 0,
            ...(notifications.length
              ? { toolExecutionNotifications: notifications }
              : {}),
          },
        ],
        results,
      },
    ],
  };
}

/**
 * The SARIF a scan writes: every finding, with tool-quoted text redacted as
 * it is for display, each marked new or unchanged against the baseline, and
 * the scan's redacted errors and unscanned files as notifications.
 */
export function scanSarif(
  scan: Pick<SecurityScan, "findings" | "errors" | "unscanned">,
  fresh: readonly SecurityFinding[],
  version: string,
) {
  return toSarif(scan.findings.map(displayFinding), version, {
    newFingerprints: new Set(fresh.map((finding) => finding.fingerprint)),
    errors: scan.errors.map(redact),
    unscanned: scan.unscanned,
  });
}
