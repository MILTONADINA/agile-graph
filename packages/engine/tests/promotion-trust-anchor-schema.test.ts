import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectPromotionTrustAnchorFile,
  inspectPromotionTrustAnchorInstall,
  promotionTrustAnchorSchema,
} from "../src/promotion-trust-anchor.js";

// Every key here is freshly generated for the test; nothing is a real pin.
const unix = process.platform === "darwin" || process.platform === "linux";
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const spki = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]) =>
  key.export({ type: "spki", format: "der" });
const pem = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]) =>
  key.export({ type: "spki", format: "pem" }).toString();

const pin = (extra: Record<string, string>, digit = "a") => ({
  keyId: "key-1",
  publicKeySha256: digit.repeat(64),
  ...extra,
});
const controllers = { witness: "none", custody: "none", modelIdentity: "none" };
const common = () => ({
  kind: "graph-engineering-promotion-trust-anchor",
  enrolledProjects: [
    { projectId: "toy-project", repositoryIdentitySha256: "1".repeat(64) },
  ],
  approverKeys: [pin({ operatorId: "owner" }, "2")],
  issuerKeys: [pin({ issuerId: "issuer" }, "3")],
  witnessId: "toy-witness",
  controllers,
});
const v1_0 = () => ({ version: "1.0.0", ...common() });

function rekorAnchor() {
  const log = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = generateKeyPairSync("ed25519");
  const base = common();
  return {
    version: "1.1.0",
    ...base,
    issuerKeys: [
      {
        issuerId: "issuer",
        keyId: "issuer-key",
        publicKeySha256: sha256(spki(issuer.publicKey)),
      },
    ],
    labelerKeys: [pin({ labelerId: "labeler" }, "4")],
    rekor: {
      kind: "rekor-v1",
      apiVersion: "v1",
      baseUrl: "https://rekor.example.test",
      origin: "rekor.example.test",
      logId: sha256(spki(log.publicKey)),
      logPublicKeyPem: pem(log.publicKey),
      issuerKeyId: "issuer-key",
      issuerPublicKeyPem: pem(issuer.publicKey),
    },
  };
}
type Anchor = ReturnType<typeof rekorAnchor>;
const messages = (value: unknown) => {
  const result = promotionTrustAnchorSchema.safeParse(value);
  return result.success
    ? null
    : result.error.issues.map((issue) => issue.message).join(" | ");
};

describe("trust anchor schema: version 1.0.0", () => {
  it("accepts the minimal anchor", () => {
    expect(messages(v1_0())).toBeNull();
  });

  it.each([
    ["an unknown version", { version: "2.0.0" }],
    ["a missing version", { version: undefined }],
    ["another kind", { kind: "something-else" }],
    ["no enrolled projects", { enrolledProjects: [] }],
    ["no approver keys", { approverKeys: [] }],
    ["no issuer keys", { issuerKeys: [] }],
    ["a witness id with a space", { witnessId: "bad id" }],
    ["an empty witness id", { witnessId: "" }],
    ["a witness id over 200 characters", { witnessId: "w".repeat(201) }],
    ["labeler keys, which only 1.1.0 has", { labelerKeys: [] }],
    ["a rekor block, which only 1.1.0 has", { rekor: {} }],
  ])("refuses %s", (_name, override) => {
    expect(messages({ ...v1_0(), ...override })).not.toBeNull();
  });

  it("limits enrolled projects to 100 and each key list to 20", () => {
    const project = (n: number) => ({
      projectId: `project-${n}`,
      repositoryIdentitySha256: "1".repeat(64),
    });
    const projects = (n: number) =>
      Array.from({ length: n }, (_, i) => project(i));
    expect(messages({ ...v1_0(), enrolledProjects: projects(100) })).toBeNull();
    expect(
      messages({ ...v1_0(), enrolledProjects: projects(101) }),
    ).not.toBeNull();
    const keys = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        pin({ operatorId: "owner" }, i.toString(16)),
      );
    expect(messages({ ...v1_0(), approverKeys: keys(15) })).toBeNull();
    expect(
      messages({ ...v1_0(), approverKeys: Array(21).fill(keys(1)[0]) }),
    ).not.toBeNull();
    expect(
      messages({ ...v1_0(), approverKeys: Array(20).fill(keys(1)[0]) }),
    ).toBeNull();
  });

  it.each([
    ["uppercase hex", "A".repeat(64)],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["non-hex", "g".repeat(64)],
    ["empty", ""],
  ])("refuses a key fingerprint that is %s", (_name, digest) => {
    expect(
      messages({
        ...v1_0(),
        approverKeys: [
          { operatorId: "owner", keyId: "key-1", publicKeySha256: digest },
        ],
      }),
    ).not.toBeNull();
    expect(
      messages({
        ...v1_0(),
        enrolledProjects: [
          { projectId: "toy", repositoryIdentitySha256: digest },
        ],
      }),
    ).not.toBeNull();
  });

  it("refuses unknown fields on pins and projects", () => {
    expect(
      messages({
        ...v1_0(),
        approverKeys: [pin({ operatorId: "owner", extra: "x" })],
      }),
    ).not.toBeNull();
    expect(
      messages({
        ...v1_0(),
        enrolledProjects: [
          {
            projectId: "toy",
            repositoryIdentitySha256: "1".repeat(64),
            note: "x",
          },
        ],
      }),
    ).not.toBeNull();
    expect(
      messages({
        ...v1_0(),
        controllers: { ...controllers, extra: "none" },
      }),
    ).not.toBeNull();
  });

  it("refuses a pin that names the wrong actor field", () => {
    expect(
      messages({ ...v1_0(), approverKeys: [pin({ issuerId: "issuer" })] }),
    ).not.toBeNull();
  });

  it.each(["__proto__", "constructor", "hasOwnProperty", "NONE", ""])(
    "refuses the controller name %j that is not in a closed registry",
    (name) => {
      for (const field of ["witness", "custody", "modelIdentity"])
        expect(
          messages({
            ...v1_0(),
            controllers: { ...controllers, [field]: name },
          }),
        ).not.toBeNull();
    },
  );
});

describe("trust anchor schema: version 1.1.0 and the Rekor pins", () => {
  it("accepts a complete, internally consistent anchor", () => {
    expect(messages(rekorAnchor())).toBeNull();
  });

  it("refuses an unknown top-level field", () => {
    expect(messages({ ...rekorAnchor(), verified: true })).not.toBeNull();
  });

  it("requires the labeler and Rekor sections", () => {
    const { labelerKeys: _l, ...withoutLabelers } = rekorAnchor();
    expect(messages(withoutLabelers)).not.toBeNull();
    const { rekor: _r, ...withoutRekor } = rekorAnchor();
    expect(messages(withoutRekor)).not.toBeNull();
  });

  const mutate = (change: (anchor: Anchor) => void): string | null => {
    const anchor = structuredClone(rekorAnchor());
    change(anchor);
    return messages(anchor);
  };

  it.each([
    [
      "a plain-http base URL",
      (a: Anchor) => (a.rekor.baseUrl = "http://rekor.example.test"),
    ],
    [
      "a base URL with a path",
      (a: Anchor) => (a.rekor.baseUrl = "https://rekor.example.test/api"),
    ],
    [
      "a base URL with a port",
      (a: Anchor) => (a.rekor.baseUrl = "https://rekor.example.test:8443"),
    ],
    [
      "a base URL with credentials",
      (a: Anchor) => (a.rekor.baseUrl = "https://u:p@rekor.example.test"),
    ],
    [
      "an uppercase origin",
      (a: Anchor) => (a.rekor.origin = "REKOR.example.test"),
    ],
    [
      "another API version",
      (a: Anchor) => ((a.rekor as { apiVersion: string }).apiVersion = "v2"),
    ],
    [
      "another witness kind",
      (a: Anchor) => ((a.rekor as { kind: string }).kind = "rekor-v2"),
    ],
    [
      "an unknown Rekor field",
      (a: Anchor) => ((a.rekor as Record<string, unknown>).extra = 1),
    ],
    [
      "an oversized key PEM",
      (a: Anchor) => (a.rekor.logPublicKeyPem += "x".repeat(1100)),
    ],
  ])("refuses %s", (_name, change) => {
    expect(mutate(change)).not.toBeNull();
  });

  it("refuses a base URL whose host differs from the origin", () => {
    expect(mutate((a) => (a.rekor.origin = "other.example.test"))).toContain(
      "the Rekor base URL host differs from its origin",
    );
  });

  it("refuses a log key that is not a canonical ECDSA P-256 PEM", () => {
    const wrong = "the Rekor log key is not a canonical ECDSA P-256 PEM";
    expect(mutate((a) => (a.rekor.logPublicKeyPem = "not a key"))).toContain(
      wrong,
    );
    // An Ed25519 key is a valid public key but the wrong type.
    expect(
      mutate(
        (a) =>
          (a.rekor.logPublicKeyPem = pem(
            generateKeyPairSync("ed25519").publicKey,
          )),
      ),
    ).toContain(wrong);
    // An EC key on another curve is the wrong curve.
    expect(
      mutate(
        (a) =>
          (a.rekor.logPublicKeyPem = pem(
            generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey,
          )),
      ),
    ).toContain(wrong);
  });

  it("refuses a log key PEM that is not in canonical form", () => {
    const wrong = "the Rekor log key is not a canonical ECDSA P-256 PEM";
    expect(
      mutate((a) => (a.rekor.logPublicKeyPem = a.rekor.logPublicKeyPem.trim())),
    ).toContain(wrong);
    expect(
      mutate(
        (a) =>
          (a.rekor.logPublicKeyPem = a.rekor.logPublicKeyPem.replace(
            /\n/g,
            "\r\n",
          )),
      ),
    ).toContain(wrong);
  });

  it("refuses a log ID that is not the SHA-256 of the log key", () => {
    expect(mutate((a) => (a.rekor.logId = "0".repeat(64)))).toContain(
      "the Rekor log ID is not the SHA-256 of its key",
    );
  });

  it("refuses an issuer key that is not a canonical Ed25519 PEM", () => {
    const wrong = "the issuer key is not a canonical Ed25519 PEM";
    expect(mutate((a) => (a.rekor.issuerPublicKeyPem = "junk"))).toContain(
      wrong,
    );
    expect(
      mutate(
        (a) =>
          (a.rekor.issuerPublicKeyPem = pem(
            generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey,
          )),
      ),
    ).toContain(wrong);
  });

  const notPinned = "the issuer key is not the one issuer pin it names";
  it("refuses an issuer key that does not match the pin it names", () => {
    expect(
      mutate(
        (a) =>
          (a.rekor.issuerPublicKeyPem = pem(
            generateKeyPairSync("ed25519").publicKey,
          )),
      ),
    ).toContain(notPinned);
  });

  it("refuses an issuer key id that names no pin or more than one pin", () => {
    expect(mutate((a) => (a.rekor.issuerKeyId = "unknown-key"))).toContain(
      notPinned,
    );
    expect(
      mutate((a) =>
        a.issuerKeys.push({ ...a.issuerKeys[0]!, issuerId: "second" }),
      ),
    ).toContain(notPinned);
  });

  it("accepts extra issuer pins that the Rekor block does not name", () => {
    expect(
      mutate((a) =>
        a.issuerKeys.push({
          issuerId: "spare",
          keyId: "spare-key",
          publicKeySha256: "9".repeat(64),
        }),
      ),
    ).toBeNull();
  });
});

describe.runIf(unix)("trust anchor file inspection refusals", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });
  const code = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    throw new Error("expected a refusal");
  };

  it("refuses a directory, a device and a path below a file as unprotected", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "graph-anchor-kind-"));
    directories.push(directory);
    const detail = async (file: string) => {
      try {
        await inspectPromotionTrustAnchorFile(file);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected a refusal");
    };
    expect(await detail(directory)).toBe(
      "trust-anchor-unprotected: anchor is not a regular file",
    );
    expect(await detail("/dev/null")).toBe(
      "trust-anchor-unprotected: anchor is not a regular file",
    );
    expect(await detail("/dev/null/anchor.json")).toBe(
      "trust-anchor-unprotected: trust anchor is unreadable",
    );
  });

  it("applies the same refusals to the install inspection, and normalises nothing", async () => {
    expect(
      await code(() => inspectPromotionTrustAnchorInstall("/etc//anchor.json")),
    ).toBe("trust-anchor-invalid");
    expect(
      await code(() =>
        inspectPromotionTrustAnchorInstall("/etc/./anchor.json"),
      ),
    ).toBe("trust-anchor-invalid");
    expect(await code(() => inspectPromotionTrustAnchorInstall(""))).toBe(
      "trust-anchor-invalid",
    );
    expect(
      await code(() =>
        inspectPromotionTrustAnchorInstall("/no/such/anchor.json"),
      ),
    ).toBe("trust-anchor-absent");
    expect(
      await code(() =>
        inspectPromotionTrustAnchorInstall("/etc/anchor.json", "win32"),
      ),
    ).toBe("trust-anchor-platform-unsupported");
  });
});
