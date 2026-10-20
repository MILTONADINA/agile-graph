// Fails when a production dependency in package-lock.json has a licence that
// is missing or outside scripts/license-allowlist.json. Offline: reads files only.
// An SPDX "A OR B" expression passes when any alternative is allowed; "AND"
// needs every part allowed. Usage: node scripts/license-allowlist.mjs [lock] [allowlist]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (file) => fileURLToPath(new URL(file, import.meta.url));

export function isAllowed(expression, allowed) {
  if (typeof expression !== "string") return false;
  const text = expression.trim();
  if (text === "") return false;
  return text
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/)
    .some((alternative) =>
      alternative
        .split(/\s+AND\s+/)
        .every((id) => allowed.has(id.trim().replace(/\+$/, ""))),
    );
}

// Licence of a lock entry: a string, or a legacy { type } / [{ type }] form.
function licenseOf(entry) {
  const value = entry.license;
  if (Array.isArray(value)) {
    const types = value.map((item) => item?.type ?? item);
    return types.length > 0 ? types.join(" OR ") : undefined;
  }
  return typeof value === "object" && value !== null ? value.type : value;
}

export function findViolations(lock, allowlist) {
  const allowed = new Set(Object.keys(allowlist));
  const violations = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // Skip the root, workspace sources and links: first-party, not installed
    // from the registry. Dev-only entries do not ship.
    if (!path.includes("node_modules/") || entry.dev || entry.link) continue;
    const license = licenseOf(entry);
    if (!isAllowed(license, allowed)) {
      violations.push({
        path,
        version: entry.version,
        license: license ?? null,
      });
    }
  }
  return violations;
}

function main() {
  const lockFile = process.argv[2] ?? here("../package-lock.json");
  const allowFile = process.argv[3] ?? here("./license-allowlist.json");
  let lock;
  let allowlist;
  try {
    lock = JSON.parse(readFileSync(lockFile, "utf8"));
    allowlist = JSON.parse(readFileSync(allowFile, "utf8"));
  } catch (error) {
    console.error(`license-allowlist: cannot read input: ${error.message}`);
    process.exit(1);
  }
  const violations = findViolations(lock, allowlist);
  for (const v of violations) {
    console.error(
      `license-allowlist: ${v.path}@${v.version} has ${v.license === null ? "no licence" : `licence "${v.license}"`}, not in the allowlist`,
    );
  }
  if (violations.length > 0) process.exit(1);
  console.log("license-allowlist: all production dependency licences allowed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
