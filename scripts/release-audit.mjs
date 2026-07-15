#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
const npmArgs = (args) => npmCli ? [npmCli, ...args] : args;
const git = (args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
};
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const packedResult = spawnSync(npm, npmArgs(["pack", "--dry-run", "--json"]), {
  cwd: root,
  encoding: "utf8",
  shell: !npmCli && process.platform === "win32",
});
if (packedResult.status !== 0) throw new Error(packedResult.stderr || "npm pack --dry-run failed");
const packed = JSON.parse(packedResult.stdout);
const packedFiles = packed.flatMap((entry) => entry.files.map((file) => file.path));
const forbiddenPath = /(^|\/)(AGENTS\.md|CLAUDE\.md|\.agents|\.codex|\.env(?:\..*)?|\.npmrc|checkpoint|checkpoints|internal|internal-docs|design|designs|plans|transcripts|runs|tmp)(\/|$)|(?:^|\/)(?:plan|PLAN|.*(?:implementation-plan|design-plan|checkpoint.*))\.md$/;
const pathFailures = [...new Set([...tracked, ...packedFiles]
  .filter((file) => file !== ".env.example" && forbiddenPath.test(file)))];
const contentFailures = [];
const localRoots = [`${path.resolve(os.homedir())}${path.sep}`];
let localKey = "";
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  const match = fs.readFileSync(envPath, "utf8").match(/^CORAL_API_KEY=(.*)$/m);
  localKey = match?.[1]?.trim().replace(/^['\"]|['\"]$/g, "") ?? "";
}
for (const relative of [...new Set([...tracked, ...packedFiles])]) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 10_000_000) continue;
  const content = fs.readFileSync(absolute);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  if (localRoots.some((prefix) => text.includes(prefix))) contentFailures.push(`${relative}: developer-specific absolute path`);
  if (localKey.length >= 16 && text.includes(localKey)) contentFailures.push(`${relative}: local Coral credential value`);
}
const failures = [...pathFailures.map((file) => `${file}: forbidden public path`), ...contentFailures];
if (failures.length > 0) {
  process.stderr.write(`Public release boundary audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: "refinery.release-boundary-audit.v1",
    version: packed[0]?.version ?? null,
    trackedFiles: tracked.length,
    packedFiles: packedFiles.length,
    packedBytes: packed[0]?.size ?? null,
    unpackedBytes: packed[0]?.unpackedSize ?? null,
    localCredentialCompared: localKey.length >= 16,
    forbiddenPaths: 0,
    developerPaths: 0,
    detectedLocalCredentials: 0,
  }, null, 2)}\n`);
}
