import { describe, expect, it } from "vitest";
import { containsSecret } from "../src/policy.js";
import { SARIF_SCHEMA, scanSarif, toSarif } from "../src/security/sarif.js";

const finding = (overrides: Record<string, unknown> = {}) => ({
  tool: "semgrep",
  rule: "js.eval",
  path: "src/app.ts",
  line: 7,
  message: "Avoid eval",
  fingerprint: "a".repeat(64),
  ...overrides,
});

describe("SARIF export", () => {
  it("writes one run with a rule per tool and rule pair and a warning per finding", () => {
    const log = toSarif(
      [
        finding(),
        finding({ line: 9, fingerprint: "b".repeat(64) }),
        finding({
          tool: "gitleaks",
          rule: "aws-key",
          fingerprint: "c".repeat(64),
        }),
      ],
      "1.2.3",
    );
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toBe(SARIF_SCHEMA);
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0]!;
    expect(run.tool.driver.name).toBe("agile-graph");
    expect(run.tool.driver.version).toBe("1.2.3");
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual([
      "semgrep/js.eval",
      "gitleaks/aws-key",
    ]);
    expect(run.results.map((result) => result.ruleId)).toEqual([
      "semgrep/js.eval",
      "semgrep/js.eval",
      "gitleaks/aws-key",
    ]);
    expect(run.results.every((result) => result.level === "warning")).toBe(
      true,
    );
    expect(run.results[0]!.message.text).toBe("Avoid eval");
  });

  it("locates each result by repository-relative path, a positive line and the finding's fingerprint", () => {
    const [located, lineless] = toSarif(
      [
        finding({ path: "src\\win\\app.ts" }),
        finding({ line: 0, fingerprint: "d".repeat(64) }),
      ],
      "1.2.3",
    ).runs[0]!.results;
    const location = located!.locations[0]!.physicalLocation;
    expect(location.artifactLocation).toEqual({
      uri: "src/win/app.ts",
      uriBaseId: "%SRCROOT%",
    });
    expect(location).toHaveProperty("region", { startLine: 7 });
    expect(located!.partialFingerprints).toEqual({
      "graphEngineering/v1": "a".repeat(64),
    });
    expect(lineless!.locations[0]!.physicalLocation).not.toHaveProperty(
      "region",
    );
    expect(toSarif([], "1.2.3").runs[0]!.results).toEqual([]);
  });

  it("redacts a scan's findings and marks each new or unchanged against the baseline", () => {
    // Built by concatenation so the source itself holds no credential shape.
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const leaked = finding({
      tool: "gitleaks",
      rule: "github-pat",
      message: `GitHub token found: ${token}`,
      fingerprint: "e".repeat(64),
    });
    const known = finding();
    const log = scanSarif(
      { findings: [known, leaked], errors: [], unscanned: [] },
      [leaked],
      "1.2.3",
    );
    const text = JSON.stringify(log);
    expect(text).not.toContain(token);
    expect(containsSecret(text)).toBe(false);
    expect(log.runs[0]!.results.map((result) => result.baselineState)).toEqual([
      "unchanged",
      "new",
    ]);
  });

  it("percent-encodes each path segment of a result's URI and keeps the separators", () => {
    const uri = (file: string) =>
      toSarif([finding({ path: file })], "1.2.3").runs[0]!.results[0]!
        .locations[0]!.physicalLocation.artifactLocation;
    expect(uri("dir/my file#1.ts")).toEqual({
      uri: "dir/my%20file%231.ts",
      uriBaseId: "%SRCROOT%",
    });
    expect(uri("100%/caf\u00e9.ts").uri).toBe("100%25/caf%C3%A9.ts");
    expect(uri("a\\b c/d.ts").uri).toBe("a/b%20c/d.ts");
  });

  it("marks an incomplete scan's invocation unsuccessful with its redacted errors and unscanned files", () => {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const complete = scanSarif(
      { findings: [finding()], errors: [], unscanned: [] },
      [],
      "1.2.3",
    ).runs[0]!.invocations;
    expect(complete).toEqual([{ executionSuccessful: true }]);
    const [invocation] = scanSarif(
      {
        findings: [finding()],
        errors: [`semgrep exited 2: token ${token}`],
        unscanned: [{ path: "assets/logo #2.bin", reason: "binary content" }],
      },
      [],
      "1.2.3",
    ).runs[0]!.invocations;
    expect(invocation!.executionSuccessful).toBe(false);
    const notifications = invocation!.toolExecutionNotifications!;
    expect(notifications).toHaveLength(2);
    expect(notifications[0]!.level).toBe("error");
    expect(notifications[0]!.message.text).toContain("semgrep exited 2");
    expect(JSON.stringify(notifications)).not.toContain(token);
    expect(notifications[1]).toEqual({
      level: "warning",
      message: { text: "Not scanned: assets/logo #2.bin (binary content)" },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: "assets/logo%20%232.bin",
              uriBaseId: "%SRCROOT%",
            },
          },
        },
      ],
    });
    // An unscanned file alone also makes the scan incomplete.
    expect(
      toSarif([], "1.2.3", {
        unscanned: [{ path: "big.bin", reason: "larger than 50 MB" }],
      }).runs[0]!.invocations[0]!.executionSuccessful,
    ).toBe(false);
  });
});
