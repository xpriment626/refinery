#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicMode = process.argv.includes("--public");
const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
const npmArgs = (args) => npmCli ? [npmCli, ...args] : args;
const fixtureSkill = path.join(root, "test", "fixtures", "public-v0.2-skill");
const secret = "upgrade-acceptance-coral-secret";
const captured = [];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: options.shell ?? false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      captured.push(result.stdout, result.stderr);
      if (code === 0) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${result.stderr}\n${result.stdout}`));
    });
  });
}

function runNpm(args, options) {
  return run(npm, npmArgs(args), {
    ...options,
    shell: !npmCli && process.platform === "win32",
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : entry.isFile() ? [target] : [];
  }).sort((left, right) => left.localeCompare(right));
}

function snapshot(paths) {
  const values = new Map();
  for (const target of paths) {
    if (fs.statSync(target).isDirectory()) {
      for (const file of filesUnder(target)) values.set(file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    } else values.set(target, crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"));
  }
  return values;
}

function assertSnapshotUnchanged(before) {
  for (const [file, hash] of before) {
    assert.equal(fs.existsSync(file), true, `missing after upgrade: ${file}`);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), hash, `changed after upgrade: ${file}`);
  }
}

async function startModelFixture() {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "GET" && request.url === "/models") {
      response.end(JSON.stringify({ object: "list", data: [
        { id: "gpt-5.4-nano", object: "model", owned_by: "fixture", created: 1 },
        { id: "o4-mini", object: "model", owned_by: "fixture", created: 2 },
      ] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), publicMode ? "refinery-public-upgrade-" : "refinery-fixture-upgrade-"));
const userHome = path.join(temp, "home");
const codexHome = path.join(temp, "codex");
const customizedCodexHome = path.join(temp, "codex-customized");
const refineryHome = path.join(temp, "refinery");
const prefix = path.join(temp, "npm-prefix");
const project = path.join(temp, "project");
const memoryHome = path.join(codexHome, "memories");
const sessionsHome = path.join(codexHome, "sessions", "2026", "07", "01");
const installedSkillDir = path.join(codexHome, "skills", "refinery");
const customizedSkillDir = path.join(customizedCodexHome, "skills", "refinery");
const credentialPath = path.join(refineryHome, "credentials", "coral-api-key");
const unrelatedConfig = path.join(refineryHome, "config", "existing-v0.2.json");
const unrelatedUserFile = path.join(userHome, "keep-me.txt");
for (const directory of [userHome, prefix, project, memoryHome, sessionsHome, path.dirname(credentialPath), path.dirname(unrelatedConfig)]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(memoryHome, "MEMORY.md"), `# Upgrade fixture\n\napplies_to: cwd=${project}\n\n- Canonical memory remains read-only.\n`);
fs.writeFileSync(path.join(memoryHome, "memory_summary.md"), "v1\n\n## User preferences\n\n- Preserve upgrade evidence.\n");
fs.writeFileSync(path.join(sessionsHome, "rollout-upgrade-fixture.jsonl"), `${JSON.stringify({ timestamp: "2026-07-01T00:00:00Z", type: "session_meta", payload: { id: "upgrade-fixture", cwd: project } })}\n`);
fs.writeFileSync(credentialPath, `${secret}\n`, { mode: 0o600 });
fs.writeFileSync(unrelatedConfig, '{"preserve":true}\n');
fs.writeFileSync(unrelatedUserFile, "unrelated user file\n");
if (process.platform !== "win32") {
  fs.chmodSync(path.dirname(credentialPath), 0o700);
  fs.chmodSync(credentialPath, 0o600);
}

const cleanEnv = { ...process.env };
for (const name of [
  "CORAL_API_KEY", "MODEL_NAME", "REFINERY_MODEL_NAME", "MODEL_BASE_URL",
  "REFINERY_MODEL_BASE_URL", "REFINERY_MODEL_PROXY_PROVIDER", "DEEPSEEK_API_KEY",
]) delete cleanEnv[name];
Object.assign(cleanEnv, {
  HOME: userHome,
  USERPROFILE: userHome,
  CODEX_HOME: codexHome,
  REFINERY_HOME: refineryHome,
  npm_config_prefix: prefix,
  REFINERY_NO_UPDATE_CHECK: "1",
});

const mock = await startModelFixture();
try {
  let publicPackageVerified = false;
  if (publicMode) {
    await runNpm(["install", "--global", "--prefix", prefix, "@itsshadowai/refinery@0.2.0", "--no-audit", "--no-fund"], {
      cwd: project,
      env: cleanEnv,
    });
    const rootResult = await runNpm(["root", "--global", "--prefix", prefix], { cwd: project, env: cleanEnv });
    const publicPackageDir = path.join(rootResult.stdout.trim(), "@itsshadowai", "refinery");
    const publicCli = path.join(publicPackageDir, "dist", "cli.js");
    assert.equal(parseJson(await run(process.execPath, [publicCli, "version", "--json"], { cwd: project, env: cleanEnv })).version, "0.2.0");
    fs.cpSync(path.join(publicPackageDir, "skills", "refinery"), installedSkillDir, { recursive: true });
    fs.cpSync(path.join(publicPackageDir, "skills", "refinery"), customizedSkillDir, { recursive: true });
    publicPackageVerified = true;
  } else {
    fs.cpSync(fixtureSkill, installedSkillDir, { recursive: true });
    fs.cpSync(fixtureSkill, customizedSkillDir, { recursive: true });
  }
  fs.appendFileSync(path.join(customizedSkillDir, "SKILL.md"), "\n# retained user customization\n");

  const protectedBefore = snapshot([memoryHome, path.join(codexHome, "sessions"), credentialPath, unrelatedConfig, unrelatedUserFile]);
  const packDir = path.join(temp, "pack");
  fs.mkdirSync(packDir);
  const pack = parseJson(await runNpm(["pack", "--json", "--pack-destination", packDir], { cwd: root, env: cleanEnv }));
  const tarball = path.join(packDir, pack[0].filename);
  await runNpm(["install", "--global", "--prefix", prefix, tarball, "--no-audit", "--no-fund"], { cwd: project, env: cleanEnv });
  const rootResult = await runNpm(["root", "--global", "--prefix", prefix], { cwd: project, env: cleanEnv });
  const packageDir = path.join(rootResult.stdout.trim(), "@itsshadowai", "refinery");
  const cli = path.join(packageDir, "dist", "cli.js");
  const env = { ...cleanEnv, REFINERY_MODEL_BASE_URL: mock.baseUrl };
  const cliRun = (args, overrides = {}) => run(process.execPath, [cli, ...args], {
    cwd: project,
    env: { ...env, ...overrides },
  });

  const versionResult = await cliRun(["version", "--json"]);
  assert.equal(parseJson(versionResult).version, "0.3.1");
  assert.match(versionResult.stderr, /package-managed Refinery Codex skill is stale/);
  const stale = parseJson(await cliRun(["skill", "status", "--json"]));
  assert.equal(stale.codexSkill.state, "stale-managed");
  assert.equal(stale.codexSkill.installedTreeHash, "c8c8cf803697f2889e56d1bb387177c68210326ac041acf34e4f46b3c003bfbf");
  const upgraded = parseJson(await cliRun(["skill", "install", "--json"]));
  assert.equal(upgraded.codexSkill.action, "upgraded");
  assert.equal(parseJson(await cliRun(["skill", "status", "--json"])).codexSkill.state, "current");

  const customStatus = parseJson(await cliRun(["skill", "status", "--json"], { CODEX_HOME: customizedCodexHome }));
  assert.equal(customStatus.codexSkill.state, "customized");
  assert.equal(customStatus.repair.requiresHumanConfirmation, true);
  const customBefore = fs.readFileSync(path.join(customizedSkillDir, "SKILL.md"), "utf8");
  const customInstall = parseJson(await cliRun(["skill", "install", "--json"], { CODEX_HOME: customizedCodexHome }));
  assert.equal(customInstall.codexSkill.action, "preserved");
  assert.equal(fs.readFileSync(path.join(customizedSkillDir, "SKILL.md"), "utf8"), customBefore);

  assert.equal(parseJson(await cliRun(["doctor", "--memory-home", memoryHome, "--json"])).command, "doctor");
  const modelList = parseJson(await cliRun(["models", "list", "--project", project, "--json"]));
  assert.deepEqual(modelList.models.map((model) => model.id), ["gpt-5.4-nano", "o4-mini"]);
  assert.equal(parseJson(await cliRun(["models", "get", "--project", project, "--json"])).selected.source, "default");
  assert.equal(parseJson(await cliRun(["models", "set", "o4-mini", "--project", project, "--json"])).selection.modelName, "o4-mini");
  assert.equal(parseJson(await cliRun(["models", "get", "--project", project, "--json"])).selected.source, "persisted");
  assert.equal(parseJson(await cliRun(["models", "reset", "--project", project, "--json"])).selected.source, "default");
  assert.equal(parseJson(await cliRun(["setup", "inspect", "--project", project, "--json"])).schemaVersion, "refinery.setup-status.v1");
  const inspected = parseJson(await cliRun([
    "sources", "inspect", "--source", "codex:memories", "--project", project,
    "--memory-home", memoryHome, "--source-limit", "2", "--json",
  ]));
  assert.equal(inspected.counts.documents <= 2, true);
  const graph = parseJson(await cliRun([
    "graph", "sync", "--source", "codex:memories", "--project", project,
    "--memory-home", memoryHome, "--json",
  ]));
  assert.equal(graph.canonicalSourcesMutated, false);
  const gateway = parseJson(await cliRun(["gateway", "start", "--project", project, "--json"]));
  assert.equal(gateway.running, true);
  assert.equal(parseJson(await cliRun(["gateway", "status", "--project", project, "--json"])).running, true);
  const ui = parseJson(await cliRun(["ui", "url", "--project", project, "--json"]));
  assert.equal((await fetch(new URL(ui.url).origin)).status, 200);
  assert.equal(parseJson(await cliRun(["gateway", "stop", "--project", project, "--json"])).running, false);

  assertSnapshotUnchanged(protectedBefore);
  assert.equal(mock.requests.every((request) => request.authorization === `Bearer ${secret}`), true);
  const allOutput = captured.join("\n");
  assert.equal(allOutput.includes(secret), false);
  assert.equal(allOutput.includes(root), false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: "refinery.upgrade-acceptance.v1",
    source: publicMode ? "public-npm-0.2.0" : "exact-public-v0.2-skill-fixture",
    publicPackageVerified,
    fromVersion: "0.2.0",
    toVersion: "0.3.1",
    tarball: path.basename(tarball),
    legacySkillHash: stale.codexSkill.installedTreeHash,
    managedSkillUpgraded: true,
    customizationPreserved: true,
    canonicalSourcesUnchanged: true,
    credentialsUnchanged: true,
    exercised: ["version", "doctor", "models", "setup inspect", "sources inspect", "graph sync", "gateway", "ui assets"],
    rollbackGuidance: "After human confirmation: npm i -g @itsshadowai/refinery@0.2.0; do not force-replace customized skills.",
  }, null, 2)}\n`);
} finally {
  try { await mock.close(); } catch { /* already closed */ }
}
