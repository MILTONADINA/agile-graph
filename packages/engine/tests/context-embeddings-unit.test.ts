import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@agile-graph/contracts";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_KEY,
  EMBEDDING_REVISION,
  LocalEmbeddings,
} from "../src/context/embeddings.js";

const pipelineMock = vi.hoisted(() => vi.fn());
vi.mock("@huggingface/transformers", () => ({ pipeline: pipelineMock }));

const ASSETS = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model.onnx",
];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const content = (asset: string) => `synthetic ${asset}`;

let dataDir: string;
let engine: LocalEmbeddings;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "graph-embeddings-unit-"));
  engine = new LocalEmbeddings(dataDir);
  pipelineMock.mockReset();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true });
});

async function writeAssets(
  options: {
    key?: string;
    digests?: Record<string, string | undefined>;
    skip?: string[];
  } = {},
) {
  await mkdir(join(engine.directory, "onnx"), { recursive: true });
  const assets: Record<string, string | undefined> = {};
  for (const asset of ASSETS) {
    if (!options.skip?.includes(asset))
      await writeFile(join(engine.directory, asset), content(asset));
    assets[asset] = sha(content(asset));
  }
  await writeFile(
    join(engine.directory, "manifest.json"),
    JSON.stringify({
      key: options.key ?? EMBEDDING_KEY,
      assets: { ...assets, ...options.digests },
    }),
  );
}
const extractorReturning = (data: ArrayLike<number>) =>
  vi.fn(async () => ({ data }));
const goodVector = () => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.5);

describe("LocalEmbeddings loading", () => {
  it("reports an unprovisioned model when no manifest exists", async () => {
    expect(engine.warning).toBe(
      "Local embedding model has not been provisioned",
    );
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toBe(
      "Local embedding model has not been provisioned",
    );
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(await engine.embed("anything")).toBeNull();
  });

  it("loads verified assets offline, on CPU, with fp32 and local files only", async () => {
    await writeAssets();
    pipelineMock.mockResolvedValue(extractorReturning(goodVector()));
    expect(await engine.available()).toBe(true);
    expect(pipelineMock).toHaveBeenCalledWith(
      "feature-extraction",
      engine.directory,
      { local_files_only: true, device: "cpu", dtype: "fp32" },
    );
    // A second call reuses the extractor instead of loading again.
    expect(await engine.available()).toBe(true);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it("shares one load between concurrent callers", async () => {
    await writeAssets();
    pipelineMock.mockResolvedValue(extractorReturning(goodVector()));
    const results = await Promise.all([
      engine.available(),
      engine.available(),
      engine.available(),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a manifest for a different model or revision", async () => {
    await writeAssets({ key: EMBEDDING_KEY.replace("fp32", "int8") });
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toBe(
      "Local embeddings unavailable: Embedding manifest does not match the pinned model",
    );
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("refuses an asset whose checksum does not match the manifest", async () => {
    await writeAssets({ digests: { "tokenizer.json": sha("tampered") } });
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toContain(
      "Embedding asset checksum mismatch: tokenizer.json",
    );
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["too short", "abc123"],
    ["uppercase", "A".repeat(64)],
    ["not hex", "z".repeat(64)],
  ])("refuses a manifest whose checksum is %s", async (_name, digest) => {
    await writeAssets({ digests: { "config.json": digest } });
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toContain("Invalid embedding asset: config.json");
  });

  it("refuses an asset that is a symbolic link, even to matching content", async () => {
    await writeAssets();
    const outside = join(dataDir, "outside.json");
    await writeFile(outside, content("config.json"));
    await rm(join(engine.directory, "config.json"));
    await symlink(outside, join(engine.directory, "config.json"));
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toContain("Invalid embedding asset: config.json");
  });

  it("refuses an asset that is a directory", async () => {
    await writeAssets({ skip: ["tokenizer_config.json"] });
    await mkdir(join(engine.directory, "tokenizer_config.json"));
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toContain(
      "Invalid embedding asset: tokenizer_config.json",
    );
  });

  it("reports a missing asset as unprovisioned", async () => {
    await writeAssets({ skip: ["onnx/model.onnx"] });
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toBe(
      "Local embedding model has not been provisioned",
    );
  });

  it("reports a corrupt manifest and remembers the failure", async () => {
    await mkdir(engine.directory, { recursive: true });
    await writeFile(join(engine.directory, "manifest.json"), "{not json");
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toContain("Local embeddings unavailable:");
    // The failure is cached: fixing the files does not retry on its own.
    await writeAssets();
    pipelineMock.mockResolvedValue(extractorReturning(goodVector()));
    expect(await engine.available()).toBe(false);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("reports a runtime that fails to start the model", async () => {
    await writeAssets();
    pipelineMock.mockRejectedValue(new Error("onnx runtime exploded"));
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toBe(
      "Local embeddings unavailable: onnx runtime exploded",
    );
  });

  it("stringifies a non-Error failure", async () => {
    await writeAssets();
    pipelineMock.mockRejectedValue("plain string failure");
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toBe(
      "Local embeddings unavailable: plain string failure",
    );
  });
});

describe("LocalEmbeddings embed and close", () => {
  async function ready(extractor: ReturnType<typeof extractorReturning>) {
    await writeAssets();
    pipelineMock.mockResolvedValue(extractor);
    await engine.available();
  }

  it("returns a float vector using normalized mean pooling truncated to 512 tokens", async () => {
    const extractor = extractorReturning(goodVector());
    await ready(extractor);
    const vector = await engine.embed("function a() {}");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(extractor).toHaveBeenCalledWith("function a() {}", {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 512,
    });
  });

  it("rejects a vector of the wrong dimension", async () => {
    await ready(extractorReturning(new Float32Array(10).fill(1)));
    await expect(engine.embed("x")).rejects.toThrow("Invalid embedding result");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("rejects a vector containing %s", async (_name, bad) => {
    const data = goodVector();
    data[100] = bad;
    await ready(extractorReturning(data));
    await expect(engine.embed("x")).rejects.toThrow("Invalid embedding result");
  });

  it("disposes the extractor on close and stays closed", async () => {
    const dispose = vi.fn(async () => {});
    const extractor = Object.assign(extractorReturning(goodVector()), {
      dispose,
    });
    await ready(extractor);
    await engine.close();
    expect(dispose).toHaveBeenCalledOnce();
    expect(await engine.available()).toBe(false);
    expect(engine.warning).toBe("Embedding engine is closed");
    expect(await engine.embed("x")).toBeNull();
    await expect(engine.close()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes cleanly when the extractor has no dispose method or never loaded", async () => {
    await ready(extractorReturning(goodVector()));
    await expect(engine.close()).resolves.toBeUndefined();
    const fresh = new LocalEmbeddings(dataDir);
    await expect(fresh.close()).resolves.toBeUndefined();
    expect(fresh.warning).toBe("Embedding engine is closed");
  });
});

describe("LocalEmbeddings provisioning policy", () => {
  const allowing = (...hosts: string[]) => ({
    ...DEFAULT_POLICY,
    network: "allowlisted" as const,
    allowedHosts: hosts,
  });
  const bytes = (text: string, status = 200) => new Response(text, { status });
  const redirect = (location: string | null, status = 302) =>
    new Response(null, {
      status,
      headers: location ? { location } : {},
    });
  const stubFetch = (handler: (url: URL) => Response | Promise<Response>) => {
    const fetchMock = vi.fn(async (input: URL | string) =>
      handler(new URL(input)),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("refuses to download unless the policy allowlists hosts, before any request", async () => {
    const fetchMock = stubFetch(() => bytes("x"));
    await expect(engine.provision(DEFAULT_POLICY)).rejects.toThrow(
      "explicitly allowed download hosts",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the first host is not on the allowlist, before any request", async () => {
    const fetchMock = stubFetch(() => bytes("x"));
    await expect(engine.provision(allowing("example.invalid"))).rejects.toThrow(
      "Model download host is not allowed: huggingface.co",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow a redirect to a host outside the allowlist", async () => {
    const fetchMock = stubFetch((url) =>
      url.hostname === "huggingface.co"
        ? redirect("https://evil.invalid/model.onnx")
        : bytes("secret"),
    );
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Model download host is not allowed: evil.invalid",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses a redirect to plain http even on an allowed host", async () => {
    stubFetch(() => redirect("http://huggingface.co/config.json"));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Model download host is not allowed",
    );
  });

  it.each([
    ["a username", "https://user@huggingface.co/config.json"],
    ["a password", "https://:pw@huggingface.co/config.json"],
    ["both", "https://user:pw@huggingface.co/config.json"],
  ])("refuses a redirect that carries %s in the URL", async (_n, target) => {
    const fetchMock = stubFetch(() => redirect(target));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Model download host is not allowed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect with no location", async () => {
    stubFetch(() => redirect(null));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Download redirect has no location",
    );
  });

  it("gives up after eight redirects", async () => {
    const fetchMock = stubFetch(() => redirect("/again"));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Too many model download redirects",
    );
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("reports a failed status and an empty body", async () => {
    stubFetch(() => bytes("nope", 404));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Model download failed (404)",
    );
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Model download returned no body",
    );
  });

  it("downloads each pinned asset through allowed redirects, records checksums and loads the model", async () => {
    const requested: string[] = [];
    stubFetch((url) => {
      requested.push(url.href);
      const asset = ASSETS.find((a) => url.pathname.endsWith(`/${a}`));
      if (url.hostname === "huggingface.co")
        return redirect(`https://cdn.example/${asset}`);
      return bytes(content(url.pathname.slice(1)));
    });
    pipelineMock.mockResolvedValue(extractorReturning(goodVector()));

    const result = await engine.provision(
      allowing("huggingface.co", "cdn.example"),
    );
    expect(result).toEqual({
      model: "jinaai/jina-embeddings-v2-base-code",
      revision: EMBEDDING_REVISION,
      directory: engine.directory,
    });
    expect(requested[0]).toBe(
      `https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/${EMBEDDING_REVISION}/config.json`,
    );
    const manifest = JSON.parse(
      await readFile(join(engine.directory, "manifest.json"), "utf8"),
    );
    expect(manifest.key).toBe(EMBEDDING_KEY);
    for (const asset of ASSETS)
      expect(manifest.assets[asset]).toBe(sha(content(asset)));
    expect(await readdir(engine.directory)).not.toContain(
      expect.stringMatching(/\.tmp$/),
    );
    expect(await engine.available()).toBe(true);
  });

  it("skips the network entirely when the model is already provisioned", async () => {
    await writeAssets();
    pipelineMock.mockResolvedValue(extractorReturning(goodVector()));
    const fetchMock = stubFetch(() => bytes("x"));
    await expect(engine.provision(DEFAULT_POLICY)).resolves.toMatchObject({
      revision: EMBEDDING_REVISION,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the load error when downloaded assets cannot be loaded", async () => {
    stubFetch((url) => bytes(content(url.pathname)));
    pipelineMock.mockRejectedValue(new Error("model cannot start"));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "Local embeddings unavailable: model cannot start",
    );
  });

  it("recovers from an earlier unavailable state once provisioning succeeds", async () => {
    expect(await engine.available()).toBe(false);
    stubFetch((url) => bytes(content(url.pathname)));
    pipelineMock.mockResolvedValue(extractorReturning(goodVector()));
    await engine.provision(allowing("huggingface.co"));
    expect(await engine.available()).toBe(true);
  });

  it("leaves no temporary file behind when a download fails midway", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection dropped"));
      },
    });
    stubFetch(() => new Response(failing, { status: 200 }));
    await expect(engine.provision(allowing("huggingface.co"))).rejects.toThrow(
      "connection dropped",
    );
    const entries = await readdir(engine.directory);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).not.toContain("manifest.json");
  });
});
