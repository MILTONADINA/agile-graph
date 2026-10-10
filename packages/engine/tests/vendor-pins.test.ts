import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUDFLARE_AUDIT_COMMIT,
  VENDORED_SHA256,
} from "../src/security/audit.js";

const vendor = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "vendor",
  "cloudflare-security-audit",
);
// Cloudflare's security-audit-skill files at commit
// c1c8a8c1471069fb0e188eeaff69b8e8db6564a8, unmodified. Change these only
// when vendoring a new upstream commit, unmodified.
const PINNED: Record<string, string> = {
  LICENSE: "e598e694aa506650c7192d5ea3be0e50aca0d356ea00551c53429f0b01eb6391",
  "report-schema.json":
    "6575c9de4a62255699ea052ebf9a49ebfb373a32891bcd89af6f55cc84b35519",
  "validate-coverage-ledger.cjs":
    "2eb280bd2e33c002916f86db9b29f9edfedb6454e5db973c766290465b868ac8",
  "validate-findings.cjs":
    "e85f232e36bfac0f866f244da50376692d6b45c690beadcb00608b0e6c8b5283",
};

describe("vendored Cloudflare security-audit files", () => {
  it("keeps the vendored Cloudflare files byte-identical to their pinned sha256", async () => {
    for (const [name, digest] of Object.entries(PINNED)) {
      const bytes = await readFile(path.join(vendor, name));
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        `${name} changed; vendor files must stay unmodified`,
      ).toBe(digest);
    }
    // The engine checks the same digests before it uses the files.
    expect(VENDORED_SHA256).toEqual(PINNED);
    // Nothing else is vendored unpinned, apart from the provenance README.
    expect((await readdir(vendor)).sort()).toEqual(
      [...Object.keys(PINNED), "README.md"].sort(),
    );
  });

  it("records the upstream commit and license in the vendor README and NOTICE", async () => {
    const readme = await readFile(path.join(vendor, "README.md"), "utf8");
    const notice = await readFile(
      path.join(vendor, "..", "..", "..", "..", "NOTICE"),
      "utf8",
    );
    expect(CLOUDFLARE_AUDIT_COMMIT).toBe(
      "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8",
    );
    for (const text of [readme, notice]) {
      expect(text).toContain(CLOUDFLARE_AUDIT_COMMIT);
      expect(text).toContain("cloudflare/security-audit-skill");
      expect(text).toContain("MIT");
    }
    expect(readme).toContain("unmodified");
  });
});
