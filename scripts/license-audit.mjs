#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const allowed = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]);
const licenses = new Map();
const failures = [];
const absentOptional = [];

for (const [entry, metadata] of Object.entries(lock.packages ?? {})) {
  if (!entry.startsWith("node_modules/") || metadata.dev === true || metadata.link === true) continue;
  const packagePath = path.join(root, entry, "package.json");
  if (!fs.existsSync(packagePath)) {
    const name = entry.slice("node_modules/".length);
    const identity = `${name}@${metadata.version ?? "unknown"}`;
    const reviewedLicense = typeof metadata.license === "string" ? metadata.license : null;
    if (metadata.optional === true && reviewedLicense && allowed.has(reviewedLicense)) {
      absentOptional.push(identity);
      licenses.set(identity, reviewedLicense);
      continue;
    }
    failures.push(`${name}@${metadata.version ?? "unknown"}: package metadata is unavailable`);
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const license = typeof pkg.license === "string" ? pkg.license : "UNKNOWN";
  licenses.set(`${pkg.name}@${pkg.version}`, license);
  if (!allowed.has(license)) failures.push(`${pkg.name}@${pkg.version}: ${license}`);
}

if (failures.length > 0) {
  process.stderr.write(`Production license audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: "refinery.production-license-audit.v1",
    reviewedPackages: licenses.size,
    licenses: Object.fromEntries([...licenses.entries()].sort()),
    absentOptionalPlatformPackages: absentOptional.sort(),
    allowedLicenses: [...allowed].sort(),
  }, null, 2)}\n`);
}
