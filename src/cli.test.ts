import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve(import.meta.dirname, "cli.ts");
const packagePath = path.resolve(import.meta.dirname, "..", "package.json");
const repoRoot = path.resolve(import.meta.dirname, "..");
const bundledSkillPath = path.join(repoRoot, "skills/refinery/SKILL.md");
const bundledSkillOpenAiPath = path.join(repoRoot, "skills/refinery/agents/openai.yaml");

function runCli(args: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
  });
}

function parseJson(stdout: string): Record<string, unknown> {
  assert.doesNotThrow(() => JSON.parse(stdout), stdout);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function seedCodexMemoryHome(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-codex-memory-"));
  const home = path.join(tmp, "memories");
  fs.mkdirSync(path.join(home, "rollout_summaries"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "MEMORY.md"),
    [
      "# Task Group: Research-Desk / refinery Codex-first CLI",
      "",
      "## Reusable knowledge",
      "",
      "- Refinery should read Codex memories and emit dry-run proposals only.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, "memory_summary.md"),
    [
      "v1",
      "",
      "## User preferences",
      "",
      "- Keep Refinery focused on a Codex-memory-first CLI.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, "rollout_summaries/2026-06-28T00-00-00-refinery-codex-first.md"),
    [
      "thread_id: 019ef730-cd4b-76c0-a3cb-c57aabd53808",
      "updated_at: 2026-06-28T00:00:00+00:00",
      "rollout_path: /tmp/rollout.jsonl",
      "cwd: /Users/bambozlor/Lab/Research-Desk/refinery",
      "",
      "# Refinery is being focused on Codex memories.",
    ].join("\n"),
  );
  return home;
}

test("top-level help exposes only the Codex-first CLI surface", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /refinery init/);
  assert.match(result.stdout, /refinery doctor/);
  assert.match(result.stdout, /refinery version/);
  assert.match(result.stdout, /refinery review/);
  assert.match(result.stdout, /refinery console run/);
  assert.match(result.stdout, /refinery dev fixture memory-proposal/);
  assert.match(result.stdout, /refinery trial inspect/);
  assert.doesNotMatch(result.stdout, /--topology/);
  assert.doesNotMatch(result.stdout, /reference-sqlite/);
  assert.doesNotMatch(result.stdout, /adapter check/);
  assert.doesNotMatch(result.stdout, /instance init/);
  assert.doesNotMatch(result.stdout, /module check/);
  assert.doesNotMatch(result.stdout, /runtime sequential/);
});

test("package surface does not publish legacy SQLite or experiment commands", () => {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
    license?: string;
    files?: string[];
    publishConfig?: Record<string, string>;
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(pkg.name, "@itsshadowai/refinery");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.deepEqual(pkg.files, ["dist", "coral", "skills", "README.md", "LICENSE", "package.json"]);
  assert.deepEqual(Object.keys(pkg.bin ?? {}).sort(), ["refinery"]);
  assert.equal(pkg.bin?.refinery, "dist/cli.js");
  assert.match(pkg.scripts?.build ?? "", /tsc/);
  const serialized = JSON.stringify({
    scripts: pkg.scripts ?? {},
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
  });
  assert.doesNotMatch(serialized, /reference-sqlite/);
  assert.doesNotMatch(serialized, /experiment:/);
  assert.doesNotMatch(serialized, /@mastra\/core/);
});

test("npm pack allowlist contains runtime files only", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [pack] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = pack.files.map((file) => file.path).sort();

  for (const expected of [
    "LICENSE",
    "README.md",
    "coral/refinery-config.toml",
    "dist/cli.js",
    "package.json",
    "skills/refinery/SKILL.md",
    "skills/refinery/agents/openai.yaml",
  ]) {
    assert.equal(paths.includes(expected), true, expected);
  }
  assert.equal(paths.some((file) => file.startsWith("src/")), false);
  assert.equal(paths.some((file) => file.endsWith(".test.ts")), false);
  assert.equal(paths.includes(".env.example"), false);
  assert.equal(paths.includes(".nvmrc"), false);
  assert.equal(paths.includes("package-lock.json"), false);
});

test("version returns package metadata as structured JSON", () => {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name: string; version: string };
  const result = runCli(["version", "--json"]);
  const parsed = parseJson(result.stdout);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "version");
  assert.equal(parsed.name, pkg.name);
  assert.equal(parsed.version, pkg.version);
});

test("doctor validates the bounded Codex memory home without model credentials", () => {
  const memoryHome = seedCodexMemoryHome();
  const codexHome = path.dirname(memoryHome);
  const refineryHome = path.join(os.tmpdir(), `refinery-doctor-home-${Date.now()}`);
  const result = runCli(["doctor", "--memory-home", memoryHome, "--json"], {
    env: { CODEX_HOME: codexHome, REFINERY_HOME: refineryHome },
  });
  const parsed = parseJson(result.stdout);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.memoryHome, memoryHome);
  assert.equal(parsed.memoryHomeSafe, true);
  assert.equal(parsed.memoryHomeExists, true);
  assert.equal(parsed.authRequired, false);
  assert.equal(parsed.sourceCount, 3);
  assert.equal(Number(parsed.activeMemoryCount) > 0, true);
  assert.deepEqual(parsed.refineryHome, {
    home: refineryHome,
    exists: false,
  });
  assert.deepEqual(parsed.bundledCodexSkill, {
    path: bundledSkillPath,
    exists: true,
  });
  assert.deepEqual(parsed.installedCodexSkill, {
    path: path.join(codexHome, "skills/refinery/SKILL.md"),
    exists: false,
  });
});

test("legacy commands return structured JSON failures", () => {
  for (const args of [
    ["adapter", "check", "--adapter", "codex-memory", "--json"],
    ["instance", "init", "--json"],
    ["module", "check", "--descriptor", "refinery-module.json", "--json"],
    ["review", "--runtime", "sequential", "--json"],
    ["review", "--source", "claude-code-sessions", "--json"],
  ]) {
    const result = runCli(args);
    const parsed = parseJson(result.stdout);

    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(parsed.ok, false);
    assert.equal((parsed.error as { code?: string }).code, "INVALID_OPTION");
  }
});

test("console run validates topology before starting Coral", () => {
  const memoryHome = seedCodexMemoryHome();
  const result = runCli([
    "console",
    "run",
    "--memory-home",
    memoryHome,
    "--topology",
    "not-a-topology",
    "--json",
  ]);
  const parsed = parseJson(result.stdout);

  assert.notEqual(result.status, 0);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "console run");
  assert.equal((parsed.error as { code?: string }).code, "INVALID_OPTION");
  assert.match((parsed.error as { message?: string }).message ?? "", /topology/);
});

test("dev fixture emits a review-shaped memory proposal without Coral", () => {
  const result = runCli(["dev", "fixture", "memory-proposal", "--json"]);
  const parsed = parseJson(result.stdout);
  const proposals = parsed.proposals as Array<Record<string, unknown>>;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "review");
  assert.equal(parsed.mode, "fixture");
  assert.equal(parsed.fixture, "memory-proposal");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.writesAttempted, false);
  assert.equal(parsed.runDir, null);
  assert.equal(Array.isArray(proposals), true);
  assert.equal(proposals.length >= 1, true);
  assert.equal(proposals[0]?.lifecycle, "proposed");
  assert.equal(typeof proposals[0]?.body, "string");
  assert.equal(((proposals[0]?.sourceRefs as Array<Record<string, unknown>>)[0])?.source_path, "$refinery");
});

test("bundled Codex skill is the single $refinery instruction surface", () => {
  const skill = fs.readFileSync(bundledSkillPath, "utf8");
  const openai = fs.readFileSync(bundledSkillOpenAiPath, "utf8");

  assert.match(skill, /^---\nname: refinery/m);
  assert.match(skill, /Use whenever Codex is asked to inspect, audit, summarize, or propose edits for memory using Refinery/);
  assert.match(skill, /debate-critique is the default/i);
  assert.doesNotMatch(skill, /--topology\s+debate-critique/);
  assert.match(openai, /display_name: "Refinery"/);
  assert.match(openai, /default_prompt: "Use \$refinery/);
});

test("init creates global state directories and installs bundled Codex skill", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-init-"));
  const home = path.join(tmp, "refinery-home");
  const codexHome = path.join(tmp, "codex-home");
  const result = runCli(["init", "--home", home, "--codex-home", codexHome, "--json"]);
  const parsed = parseJson(result.stdout);
  const installedSkill = path.join(codexHome, "skills/refinery/SKILL.md");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "init");
  assert.equal(parsed.home, home);
  assert.equal(fs.statSync(path.join(home, "config")).isDirectory(), true);
  assert.equal(fs.statSync(path.join(home, "credentials")).isDirectory(), true);
  assert.equal(fs.statSync(path.join(home, "runs/by-project")).isDirectory(), true);
  assert.equal(fs.statSync(installedSkill).isFile(), true);
  assert.match(fs.readFileSync(installedSkill, "utf8"), /^---\nname: refinery/m);
  assert.deepEqual(parsed.codexSkill, {
    requested: true,
    action: "installed",
    path: installedSkill,
  });
});

test("init preserves existing Codex skill unless force is set", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-init-preserve-"));
  const home = path.join(tmp, "refinery-home");
  const codexHome = path.join(tmp, "codex-home");
  const installedSkill = path.join(codexHome, "skills/refinery/SKILL.md");
  fs.mkdirSync(path.dirname(installedSkill), { recursive: true });
  fs.writeFileSync(installedSkill, "custom local skill\n");

  const preserved = runCli(["init", "--home", home, "--codex-home", codexHome, "--json"]);
  const preservedJson = parseJson(preserved.stdout);
  assert.equal(preserved.status, 0, preserved.stderr || preserved.stdout);
  assert.equal(fs.readFileSync(installedSkill, "utf8"), "custom local skill\n");
  assert.equal((preservedJson.codexSkill as { action?: string }).action, "preserved");

  const forced = runCli(["init", "--home", home, "--codex-home", codexHome, "--force", "--json"]);
  const forcedJson = parseJson(forced.stdout);
  assert.equal(forced.status, 0, forced.stderr || forced.stdout);
  assert.match(fs.readFileSync(installedSkill, "utf8"), /^---\nname: refinery/m);
  assert.equal((forcedJson.codexSkill as { action?: string }).action, "overwritten");
});

test("repo does not publish duplicate local Codex skill names", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, ".agents/skills/refinery-memory-review")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, ".codex-test/skills/refinery-memory-proposal")), false);
});
