#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const secret = "coral-packed-acceptance-secret";
const receipts = [];
const capturedOutput = [];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = {
        command: `${command} ${args.join(" ")}`,
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      receipts.push({ command: result.command, code, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length });
      capturedOutput.push(result.stdout, result.stderr);
      if (code === 0) resolve(result);
      else reject(new Error(`${result.command} failed (${code ?? signal})\n${result.stderr}\n${result.stdout}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(file) : entry.isFile() ? [file] : [];
  });
}

async function startMockCoral() {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
    } else if (request.method === "GET" && request.url === "/api/v1/registry") {
      response.end("[]");
    } else if (request.method === "GET" && request.url === "/models") {
      response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.4-nano" }] }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-packed-acceptance-"));
const packDir = path.join(temp, "pack");
const consumer = path.join(temp, "consumer");
const userHome = path.join(temp, "user-home");
const codexHome = path.join(temp, "codex-home");
const refineryHome = path.join(temp, "refinery-home");
const project = path.join(temp, "project");
const memoryHome = path.join(codexHome, "memories");
for (const directory of [packDir, consumer, userHome, memoryHome, project]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(memoryHome, "MEMORY.md"), [
  "# Refinery packed acceptance memory",
  "",
  "scope: Use only for the packed acceptance project.",
  `applies_to: cwd=${project}`,
  "",
  "## User preferences",
  "",
  "- Keep canonical memory read-only while evaluating proposals.",
].join("\n"));
fs.writeFileSync(path.join(memoryHome, "memory_summary.md"), "v1\n\n## User preferences\n\n- Prefer bounded responsibility graphs.\n");
const canonicalBefore = new Map(walkFiles(memoryHome).map((file) => [file, fs.readFileSync(file)]));
const mock = await startMockCoral();

try {
  const packed = parseJson(await run(npm, ["pack", "--json", "--pack-destination", packDir], { cwd: root }));
  assert.equal(packed.length, 1);
  const tarball = path.join(packDir, packed[0].filename);
  assert.equal(fs.existsSync(tarball), true);
  await run(npm, ["init", "-y"], { cwd: consumer });
  await run(npm, ["install", tarball, "--no-audit", "--no-fund"], { cwd: consumer });

  const packageDir = path.join(consumer, "node_modules", "@itsshadowai", "refinery");
  const cli = path.join(packageDir, "dist", "cli.js");
  const postinstall = await run(process.execPath, [path.join(packageDir, "scripts", "postinstall.mjs")], { cwd: consumer });
  assert.match(`${postinstall.stdout}\n${postinstall.stderr}`, /Refinery installed/);
  assert.match(`${postinstall.stdout}\n${postinstall.stderr}`, /refinery setup start/);
  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    CODEX_HOME: codexHome,
    REFINERY_HOME: refineryHome,
    CORAL_CLOUD_API_URL: mock.baseUrl,
    REFINERY_MODEL_BASE_URL: mock.baseUrl,
    REFINERY_MODEL_NAME: "gpt-5.4-nano",
    REFINERY_NO_UPDATE_CHECK: "1",
    CI: "true",
  };
  const cliRun = (args, options = {}) => run(process.execPath, [cli, ...args], { cwd: project, env, ...options });

  const version = parseJson(await cliRun(["version", "--json"]));
  assert.equal(version.version, "0.3.0");
  const installedSkill = parseJson(await cliRun(["skill", "install", "--json"]));
  assert.equal(installedSkill.codexSkill.action, "installed");
  assert.equal(installedSkill.codexSkill.managed, true);
  assert.equal(fs.existsSync(path.join(codexHome, "skills", "refinery", "SKILL.md")), true);

  const inspected = parseJson(await cliRun(["setup", "inspect", "--project", project, "--json"]));
  assert.equal(inspected.schemaVersion, "refinery.setup-status.v1");
  assert.equal(inspected.readyFor.agent, true);
  assert.equal(inspected.readyFor.graph, true);

  const started = parseJson(await cliRun(["setup", "start", "--project", project, "--json"]));
  assert.equal(started.running, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/#cap=/);
  const setupUrl = new URL(started.url);
  const capability = new URLSearchParams(setupUrl.hash.slice(1)).get("cap");
  setupUrl.hash = "";
  const origin = setupUrl.origin;
  const setupScript = await (await fetch(new URL("/setup.js", origin))).text();
  assert.doesNotMatch(setupScript, /localStorage|sessionStorage/);

  const unauthenticated = await fetch(new URL("/api/v1/setup", origin));
  assert.equal(unauthenticated.status, 401);
  const hostile = await fetch(new URL("/api/v1/session", origin), {
    method: "POST",
    headers: { Origin: "https://attacker.example", Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(hostile.status, 403);
  const malformed = await fetch(new URL("/api/v1/session", origin), {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "SETUP_JSON_INVALID");
  const exchange = await fetch(new URL("/api/v1/session", origin), {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(exchange.status, 200);
  const sessionToken = (await exchange.json()).sessionToken;
  const replay = await fetch(new URL("/api/v1/session", origin), {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(replay.status, 401);
  const complete = await fetch(new URL("/api/v1/complete", origin), {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ coralApiKey: secret, storage: "private-file", provisionRuntime: false, browserOpenOnSync: false }),
  });
  const completionText = await complete.text();
  assert.equal(complete.status, 200, completionText);
  assert.doesNotMatch(completionText, new RegExp(secret));
  assert.deepEqual(mock.requests.map((request) => [request.method, request.url]), [["GET", "/api/v1/registry"], ["GET", "/models"]]);

  const credentialPath = path.join(refineryHome, "credentials", "coral-api-key");
  const credentialStat = fs.lstatSync(credentialPath);
  assert.equal(credentialStat.isFile(), true);
  assert.equal(credentialStat.isSymbolicLink(), false);
  assert.equal(fs.readFileSync(credentialPath, "utf8"), `${secret}\n`);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(credentialPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(credentialPath).mode & 0o777, 0o600);
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = parseJson(await cliRun(["setup", "status", "--project", project, "--json"]));
    if (!status.server.running) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const setupStatus = parseJson(await cliRun(["setup", "status", "--project", project, "--json"]));
  assert.equal(setupStatus.credential.verified, true);
  assert.equal(
    setupStatus.credential.protection,
    process.platform === "win32" ? "platform-managed user-profile ACL" : "owner-only POSIX mode 0600",
  );
  assert.equal(setupStatus.credential.modelName, "gpt-5.4-nano");
  assert.equal(setupStatus.server.running, false);

  const packedSetupServer = await import(pathToFileURL(path.join(packageDir, "dist", "setup", "server.js")).href);
  let expiredClosed = false;
  const expiring = await packedSetupServer.startSetupHttpServer({
    home: refineryHome,
    project,
    capabilityHash: packedSetupServer.setupCapabilityHash("packed-expiry-capability"),
    instanceId: "packed-expiry-instance",
    expiresAt: new Date(Date.now() + 100).toISOString(),
    onClosed: () => { expiredClosed = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(expiring.server.listening, false);
  assert.equal(expiredClosed, true);

  const sourceInspection = parseJson(await cliRun([
    "sources", "inspect", "--source", "codex:memories", "--project", project,
    "--memory-home", memoryHome, "--source-limit", "2", "--json",
  ]));
  assert.equal(sourceInspection.counts.documents <= 2, true);
  const graph = parseJson(await cliRun([
    "graph", "sync", "--source", "codex:memories", "--project", project,
    "--memory-home", memoryHome, "--json",
  ]));
  assert.equal(graph.canonicalSourcesMutated, false);
  assert.equal(fs.statSync(graph.graphPath).isFile(), true);
  for (const [file, before] of canonicalBefore) assert.deepEqual(fs.readFileSync(file), before);

  const ui = parseJson(await cliRun(["ui", "url", "--project", project, "--json"]));
  const uiUrl = new URL(ui.url);
  const graphCapability = new URLSearchParams(uiUrl.hash.slice(1)).get("cap");
  const page = await fetch(uiUrl.origin);
  assert.equal(page.status, 200);
  const health = await fetch(new URL("/api/v1/health", uiUrl.origin), { headers: { Authorization: `Bearer ${graphCapability}` } });
  assert.equal(health.status, 200);
  await cliRun(["gateway", "stop", "--project", project, "--json"]);

  const packageJsonPath = path.join(packageDir, "package.json");
  const bundledSkillPath = path.join(packageDir, "skills", "refinery", "SKILL.md");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  packageJson.version = "0.3.1-fixture";
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  fs.appendFileSync(bundledSkillPath, "\n<!-- packed managed upgrade fixture -->\n");
  const upgraded = parseJson(await cliRun(["skill", "install", "--json"]));
  assert.equal(upgraded.codexSkill.action, "upgraded");
  const installedSkillPath = path.join(codexHome, "skills", "refinery", "SKILL.md");
  fs.appendFileSync(installedSkillPath, "\n# local customization\n");
  fs.appendFileSync(bundledSkillPath, "\n<!-- second package fixture -->\n");
  const preserved = parseJson(await cliRun(["skill", "install", "--json"]));
  assert.equal(preserved.codexSkill.action, "preserved");
  assert.equal(preserved.codexSkill.conflict, true);
  assert.match(fs.readFileSync(installedSkillPath, "utf8"), /local customization/);

  const outputText = capturedOutput.join("\n") + completionText;
  assert.doesNotMatch(outputText, new RegExp(secret));
  for (const file of walkFiles(refineryHome)) {
    if (file === credentialPath || fs.statSync(file).size > 5_000_000) continue;
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(secret), file);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: "refinery.packed-acceptance.v1",
    packageVersion: version.version,
    tarball: path.basename(tarball),
    codexHome,
    setup: { oneTimeCapability: true, malformedRejected: true, expiredClosed: true, credentialVerified: true, model: "gpt-5.4-nano" },
    graph: { nodes: graph.summary.nodes, edges: graph.summary.edges, canonicalSourcesMutated: false },
    ui: { pageStatus: page.status, healthStatus: health.status },
    skill: { installed: true, managedUpgrade: true, customizationPreserved: true },
    commands: receipts.length,
  }, null, 2)}\n`);
} finally {
  try { await mock.close(); } catch { /* already closed */ }
}
