// Loads the Jev key from a private pointer file. Never prints or throws the key.
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaults = {
  exec: execFileAsync,
  lstat,
  readFile,
  platform: process.platform,
  home: homedir(),
};
const keychainName = /^[\x21-\x7e]{1,256}$/;

export async function privateFile(filename, label, deps = defaults) {
  const info = await deps.lstat(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 8192 ||
    (deps.platform !== "win32" && info.mode & 0o077)
  )
    throw new Error(`${label} must be a small private regular file`);
  return info;
}

function validKey(value) {
  const key = String(value).trim();
  if (!/^[\x21-\x7e]{16,512}$/.test(key))
    throw new Error("Jev key must be one printable token");
  return key;
}

export async function loadJevKey(sourcePath, overrides = {}) {
  const deps = { ...defaults, ...overrides };
  try {
    await privateFile(sourcePath, "Jev key source", deps);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  let source;
  try {
    source = JSON.parse(await deps.readFile(sourcePath, "utf8"));
  } catch {
    throw new Error("Jev key source must be valid private JSON");
  }
  const keys =
    source && typeof source === "object" && !Array.isArray(source)
      ? Object.keys(source).sort().join(",")
      : "";
  if (source?.format === "keychain") {
    if (
      keys !== "account,format,service" ||
      typeof source.service !== "string" ||
      typeof source.account !== "string" ||
      !keychainName.test(source.service) ||
      !keychainName.test(source.account) ||
      source.service.startsWith("-") ||
      source.account.startsWith("-")
    )
      throw new Error(
        "Jev key source for the keychain must specify only a service and an account",
      );
    if (deps.platform !== "darwin")
      throw new Error("The keychain Jev key source needs macOS");
    let value;
    try {
      value = (
        await deps.exec(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            source.account,
            "-s",
            source.service,
            "-w",
            // Name the login keychain: without it, security returns the first
            // match anywhere in the user's keychain search list.
            path.join(deps.home, "Library/Keychains/login.keychain-db"),
          ],
          { encoding: "utf8", maxBuffer: 8192, timeout: 30000 },
        )
      ).stdout;
    } catch {
      throw new Error(
        `Could not read the Jev key from the keychain item "${source.service}"`,
      );
    }
    return validKey(value ?? "");
  }
  if (
    keys !== "format,path" ||
    typeof source.path !== "string" ||
    !path.isAbsolute(source.path) ||
    !["plain", "rtf"].includes(source.format)
  )
    throw new Error(
      "Jev key source must specify an absolute path and format, or a keychain service and account",
    );
  await privateFile(source.path, "Jev key", deps);
  let value;
  try {
    value =
      source.format === "rtf"
        ? (
            await deps.exec(
              "/usr/bin/textutil",
              ["-convert", "txt", "-stdout", source.path],
              { encoding: "utf8", maxBuffer: 8192 },
            )
          ).stdout
        : await deps.readFile(source.path, "utf8");
  } catch {
    throw new Error("Could not load private Jev key");
  }
  return validKey(value);
}
