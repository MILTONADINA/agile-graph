// Synthetic fixtures and a fake exec only; the real keychain is never read.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadJevKey } from "./local-engine-jev.mjs";

const secret = "synthetic-token-0123456789abcdef";

async function pointer(t, content) {
  const dir = await mkdtemp(path.join(tmpdir(), "local-engine-jev-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "jev-key-source.json");
  await writeFile(file, JSON.stringify(content), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
const keychain = { format: "keychain", service: "svc-x", account: "acct-y" };
const fake = (stdout, calls = []) => ({
  platform: "darwin",
  home: "/Users/someone",
  exec: async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout };
  },
});

test("keychain success runs security without a shell and trims", async (t) => {
  const calls = [];
  const key = await loadJevKey(
    await pointer(t, keychain),
    fake(`${secret}\n`, calls),
  );
  assert.equal(key, secret);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/security");
  assert.deepEqual(calls[0].args, [
    "find-generic-password",
    "-a",
    "acct-y",
    "-s",
    "svc-x",
    "-w",
    "/Users/someone/Library/Keychains/login.keychain-db",
  ]);
  assert.equal(calls[0].options.shell, undefined);
});

test("missing pointer returns undefined", async () => {
  assert.equal(
    await loadJevKey("/nonexistent/jev-key-source.json", fake(secret)),
    undefined,
  );
});

test("keychain failure names the service and never the key", async (t) => {
  const file = await pointer(t, keychain);
  await assert.rejects(
    loadJevKey(file, {
      platform: "darwin",
      exec: async () => {
        throw new Error(`boom ${secret}`);
      },
    }),
    (error) => {
      assert.match(error.message, /svc-x/);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("keychain fails closed off macOS without running security", async (t) => {
  let ran = false;
  await assert.rejects(
    loadJevKey(await pointer(t, keychain), {
      platform: "linux",
      exec: async () => {
        ran = true;
        return { stdout: secret };
      },
    }),
    /needs macOS/,
  );
  assert.equal(ran, false);
});

for (const [name, out] of [
  ["empty", ""],
  ["short", "abc"],
  ["with spaces", "two words here 0123456789"],
  ["multi-line", `${secret}\n${secret}`],
]) {
  test(`keychain malformed output (${name}) is rejected without the key`, async (t) => {
    await assert.rejects(
      loadJevKey(await pointer(t, keychain), fake(out)),
      (error) => {
        assert.match(error.message, /one printable token/);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  });
}

for (const [name, content] of [
  ["extra key", { ...keychain, path: "/tmp/x" }],
  ["missing account", { format: "keychain", service: "svc-x" }],
  ["non-string service", { ...keychain, service: 5 }],
  ["option-like account", { ...keychain, account: "-w" }],
  ["plain with service", { format: "plain", path: "/tmp/x", service: "s" }],
  ["unknown format", { format: "vault", path: "/tmp/x" }],
  ["array", []],
]) {
  test(`pointer with ${name} is rejected`, async (t) => {
    let ran = false;
    await assert.rejects(
      loadJevKey(await pointer(t, content), {
        platform: "darwin",
        exec: async () => {
          ran = true;
          return { stdout: secret };
        },
      }),
      /Jev key source/,
    );
    assert.equal(ran, false);
  });
}

test("pointer file must stay private", async (t) => {
  const file = await pointer(t, keychain);
  await chmod(file, 0o644);
  await assert.rejects(
    loadJevKey(file, fake(secret)),
    /small private regular file/,
  );
});

test("plain format still reads a private key file", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "local-engine-jev-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "key");
  await writeFile(keyFile, `${secret}\n`, { mode: 0o600 });
  const file = await pointer(t, { format: "plain", path: keyFile });
  assert.equal(await loadJevKey(file), secret);
});
