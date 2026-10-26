#!/usr/bin/env node
// Packs each published package twice from one build and fails with a
// file-by-file diff when the two tarballs differ, so a nondeterministic build
// cannot ship. Nothing is published. Run from a built checkout (npm run build).
//
//   node scripts/pack-twice.mjs [package directory ...]
//
// Defaults to packages/contracts and packages/engine.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function files(root, directory = "") {
  const found = new Map();
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of await files(root, relative)) {
        found.set(name, hash);
      }
    } else {
      found.set(relative, sha256(await readFile(path.join(root, relative))));
    }
  }
  return found;
}

/** Packs `directory` into `destination`; returns the tarball path. */
async function pack(directory, destination, runScripts) {
  const args = ["pack", "--json", "--pack-destination", destination];
  if (!runScripts) args.push("--ignore-scripts");
  const [packed] = JSON.parse(
    execFileSync("npm", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  return path.join(destination, packed.filename);
}

async function unpack(tarball, destination) {
  await mkdir(destination);
  execFileSync("tar", ["-xzf", tarball, "-C", destination]);
  return files(destination);
}

/**
 * Packs every directory twice into separate temporary directories. Returns
 * `{ packed, differences }`; `differences` holds one message per package whose
 * tarballs differ, listing the files that were added, removed or changed.
 */
export async function packTwice(directories, { runScripts = false } = {}) {
  const work = await mkdtemp(path.join(os.tmpdir(), "graph-pack-twice-"));
  const packed = [];
  const differences = [];
  try {
    for (const directory of directories) {
      const first = await pack(
        directory,
        await mkdir(path.join(work, "first"), { recursive: true }).then(() =>
          path.join(work, "first"),
        ),
        runScripts,
      );
      const second = await pack(
        directory,
        await mkdir(path.join(work, "second"), { recursive: true }).then(() =>
          path.join(work, "second"),
        ),
        runScripts,
      );
      const hashes = [
        sha256(await readFile(first)),
        sha256(await readFile(second)),
      ];
      const name = path.basename(first);
      packed.push({ directory, name, sha256: hashes[0] });
      if (hashes[0] !== hashes[1]) {
        const before = await unpack(first, path.join(work, `${name}.1`));
        const after = await unpack(second, path.join(work, `${name}.2`));
        const lines = [];
        for (const file of [
          ...new Set([...before.keys(), ...after.keys()]),
        ].sort()) {
          if (!after.has(file)) lines.push(`  only in first pack: ${file}`);
          else if (!before.has(file))
            lines.push(`  only in second pack: ${file}`);
          else if (before.get(file) !== after.get(file))
            lines.push(`  differs: ${file}`);
        }
        if (lines.length === 0) {
          lines.push("  file contents match; the archive metadata differs");
        }
        differences.push(
          `${name} is not reproducible (sha256 ${hashes[0]} vs ${hashes[1]}):\n${lines.join("\n")}`,
        );
      }
      await rm(path.join(work, "first"), { recursive: true, force: true });
      await rm(path.join(work, "second"), { recursive: true, force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { packed, differences };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const directories = (
    requested.length ? requested : ["packages/contracts", "packages/engine"]
  ).map((directory) => path.resolve(repository, directory));
  // The engine's prepack would rebuild dist; copy only its packed assets, as
  // scripts/npm-packages.test.mjs does.
  execFileSync(
    "node",
    ["packages/engine/scripts/prepack.mjs", "--assets-only"],
    { cwd: repository, stdio: "inherit" },
  );
  const { packed, differences } = await packTwice(directories);
  for (const { name, sha256: hash } of packed) console.log(`${hash}  ${name}`);
  if (differences.length) {
    console.error(differences.join("\n"));
    process.exit(1);
  }
  console.log(`${packed.length} tarballs are identical across two packs`);
}
