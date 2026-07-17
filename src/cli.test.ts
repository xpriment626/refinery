import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LibsqlGraphStore } from "./core/graph/libsql-store.ts";
import { hashSkillTree } from "./core/skill-installer.ts";

const cliPath = path.resolve(import.meta.dirname, "cli.ts");
const packagePath = path.resolve(import.meta.dirname, "..", "package.json");
const repoRoot = path.resolve(import.meta.dirname, "..");
const bundledSkillPath = path.join(repoRoot, "skills/refinery/SKILL.md");
const bundledSkillOpenAiPath = path.join(repoRoot, "skills/refinery/agents/openai.yaml");

function runCli(args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; input?: string; updateCheck?: boolean } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      REFINERY_NO_UPDATE_CHECK: options.updateCheck ? undefined : "1",
      ...options.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
  });
}

function parseJson(stdout: string): Record<string, unknown> {
  assert.doesNotThrow(() => JSON.parse(stdout), stdout);
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function startModelFixtureServer(): Promise<{ child: ChildProcessWithoutNullStreams; baseUrl: string }> {
  const script = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      if (request.url !== "/openai/v1/models") { response.statusCode = 404; return response.end(); }
      if (request.headers.authorization !== "Bearer fixture-key") { response.statusCode = 401; return response.end("denied"); }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [
        { id: "gpt-5.5", object: "model", owned_by: "fixture", created: 55 },
        { id: "o4-mini", object: "model", owned_by: "fixture", created: 44 },
        { id: "future-model", object: "model", owned_by: "fixture", created: 99 }
      ] }));
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  const port = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("model fixture server did not start")), 5_000);
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, newline));
      }
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}/openai/v1` };
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
      `applies_to: cwd=${repoRoot}`,
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
      "cwd: /Users/example/Lab/Research-Desk/refinery",
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
  assert.match(result.stdout, /refinery skill install/);
  assert.match(result.stdout, /refinery skill status/);
  assert.match(result.stdout, /refinery models list/);
  assert.match(result.stdout, /refinery models set <model-id>/);
  assert.match(result.stdout, /refinery set auth coral/);
  assert.match(result.stdout, /refinery unset auth coral/);
  assert.match(result.stdout, /refinery setup inspect/);
  assert.match(result.stdout, /refinery setup start/);
  assert.match(result.stdout, /refinery setup status/);
  assert.match(result.stdout, /refinery setup provision coral --confirm/);
  assert.match(result.stdout, /refinery doctor/);
  assert.match(result.stdout, /refinery version/);
  assert.match(result.stdout, /refinery sources inspect/);
  assert.match(result.stdout, /refinery graph sync/);
  assert.match(result.stdout, /refinery graph status/);
  assert.match(result.stdout, /refinery graph inspect/);
  assert.match(result.stdout, /refinery graph neighbors/);
  assert.match(result.stdout, /refinery graph plan/);
  assert.match(result.stdout, /refinery gateway start/);
  assert.match(result.stdout, /refinery gateway status/);
  assert.match(result.stdout, /refinery gateway stop/);
  assert.match(result.stdout, /refinery ui url/);
  assert.match(result.stdout, /refinery ui open/);
  assert.match(result.stdout, /refinery ui config/);
  assert.match(result.stdout, /refinery review/);
  assert.match(result.stdout, /refinery console run/);
  assert.match(result.stdout, /refinery dev fixture memory-proposal/);
  assert.match(result.stdout, /refinery trial inspect/);
  assert.match(result.stdout, /--no-update-check/);
  assert.match(result.stdout, /--topology pipeline\|debate-critique\|sparse-blackboard/);
  assert.match(result.stdout, /--model <id>/);
  assert.match(result.stdout, /--coral-llm-proxy/);
  assert.match(result.stdout, /--model-provider <name>/);
  assert.match(result.stdout, /--coral-jar <path>/);
  assert.doesNotMatch(result.stdout, /instance init/);
  assert.doesNotMatch(result.stdout, /module check/);
  assert.doesNotMatch(result.stdout, /runtime sequential/);
});

test("package surface does not publish experiment commands", () => {
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
  assert.equal(pkg.version, "0.3.1");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.deepEqual(pkg.files, ["dist", "coral", "skills", "scripts/postinstall.mjs", "README.md", "LICENSE", "package.json"]);
  assert.deepEqual(Object.keys(pkg.bin ?? {}).sort(), ["refinery"]);
  assert.equal(pkg.bin?.refinery, "dist/cli.js");
  assert.match(pkg.scripts?.build ?? "", /tsc/);
  assert.match(pkg.scripts?.build ?? "", /vite/);
  assert.equal(pkg.scripts?.postinstall, "node scripts/postinstall.mjs");
  assert.equal(pkg.devDependencies?.svelte, "5.56.4");
  assert.equal(pkg.devDependencies?.vite, "8.1.4");
  assert.equal(pkg.devDependencies?.sigma, "3.0.3");
  assert.equal(pkg.devDependencies?.graphology, "0.26.0");
  const postinstall = fs.readFileSync(path.join(repoRoot, "scripts/postinstall.mjs"), "utf8");
  assert.match(postinstall, /refinery setup inspect/);
  assert.match(postinstall, /refinery setup start/);
  assert.match(postinstall, /refinery skill status --json/);
  assert.match(postinstall, /refinery models list --json/);
  assert.match(postinstall, /refinery models set <model-id> --json/);
  assert.match(postinstall, /Customized skills are preserved/);
  assert.match(postinstall, /without placing it in chat, shell arguments, or logs/i);
  assert.doesNotMatch(postinstall, /spawn|exec|openExternal|writeFile/);
  assert.match(postinstall, /refinery ui url --json/);
  assert.match(postinstall, /refinery ui config --browser-open on --json/);
  assert.match(postinstall, /disabled by default/i);
  const serialized = JSON.stringify({
    scripts: pkg.scripts ?? {},
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
  });
  assert.doesNotMatch(serialized, /experiment:/);
  assert.doesNotMatch(serialized, /@mastra\/core/);
});

test("npm pack allowlist contains runtime files only", () => {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = npmCli ? [npmCli, "pack", "--dry-run", "--json"] : ["pack", "--dry-run", "--json"];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    shell: !npmCli && process.platform === "win32",
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
    "scripts/postinstall.mjs",
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
  assert.equal(paths.some((file) => file === "AGENTS.md" || file.startsWith(".agents/") || file.startsWith(".codex/")), false);
  assert.equal(paths.some((file) =>
    file.startsWith("docs/")
    || file.includes("/plans/")
    || file.endsWith(".plan.md")
    || file.endsWith("-implementation-plan.md")
    || file.endsWith("-design-plan.md")
  ), false);
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

test("models CLI lists exact live IDs and persists only advertised compatible selections", async () => {
  const fixture = await startModelFixtureServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-models-cli-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project);
  const env = {
    CORAL_API_KEY: "fixture-key",
    REFINERY_MODEL_BASE_URL: fixture.baseUrl,
    MODEL_NAME: undefined,
    REFINERY_MODEL_NAME: undefined,
    REFINERY_HOME: undefined,
    CODEX_HOME: path.join(tmp, "codex-home"),
  };
  const common = ["--home", home, "--project", project, "--json"];
  try {
    const listed = runCli(["models", "list", ...common], { cwd: project, env });
    const listJson = parseJson(listed.stdout);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.deepEqual((listJson.models as Array<Record<string, unknown>>).map((model) => model.id), ["gpt-5.5", "o4-mini", "future-model"]);
    assert.equal((((listJson.models as Array<Record<string, unknown>>)[2].compatibility as Record<string, unknown>).supported), false);
    assert.equal(JSON.stringify(listJson).includes("fixture-key"), false);
    assert.equal(listJson.builtInFallback, "gpt-5.4-nano");
    assert.equal(listed.stderr, "");

    const selected = runCli(["models", "set", "o4-mini", ...common], { cwd: project, env });
    assert.equal(selected.status, 0, selected.stderr || selected.stdout);
    assert.equal((parseJson(selected.stdout).selection as Record<string, unknown>).modelName, "o4-mini");
    const modelPath = path.join(home, "config", "model.json");
    assert.equal(fs.statSync(modelPath).isFile(), true);
    const beforeFailure = fs.readFileSync(modelPath, "utf8");

    const absent = runCli(["models", "set", "missing-model", ...common], { cwd: project, env });
    assert.notEqual(absent.status, 0);
    assert.equal((parseJson(absent.stdout).error as Record<string, unknown>).code, "MODEL_NOT_ADVERTISED");
    assert.equal(fs.readFileSync(modelPath, "utf8"), beforeFailure);

    const unsupported = runCli(["models", "set", "future-model", ...common], { cwd: project, env });
    assert.notEqual(unsupported.status, 0);
    assert.equal((parseJson(unsupported.stdout).error as Record<string, unknown>).code, "MODEL_UNSUPPORTED");
    assert.equal(fs.readFileSync(modelPath, "utf8"), beforeFailure);

    const got = runCli(["models", "get", ...common], { cwd: project, env });
    assert.equal((parseJson(got.stdout).selected as Record<string, unknown>).modelName, "o4-mini");
    const reset = runCli(["models", "reset", ...common], { cwd: project, env });
    assert.equal((parseJson(reset.stdout).reset as Record<string, unknown>).removed, true);
    assert.equal(fs.existsSync(modelPath), false);
  } finally {
    fixture.child.kill("SIGTERM");
  }
});

test("CLI reports a cached update before running and supports the global opt-out", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-update-cli-"));
  const cachePath = path.join(home, "cache", "update-check.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    checkedAt: Date.now(),
    currentVersion: "0.3.1",
    latestVersion: "0.4.0",
  }));

  const env = {
    REFINERY_HOME: home,
    CODEX_HOME: path.join(home, "codex-home"),
    CI: undefined,
    REFINERY_NO_UPDATE_CHECK: undefined,
  };
  const noticed = runCli(["version", "--json"], { env, updateCheck: true });
  const noticedJson = parseJson(noticed.stdout);
  assert.equal(noticed.status, 0, noticed.stderr || noticed.stdout);
  assert.equal(noticedJson.version, "0.3.1");
  assert.match(noticed.stderr, /A newer Refinery version is available: 0\.3\.1 -> 0\.4\.0/);
  assert.match(noticed.stderr, /No update was installed automatically/);
  assert.match(noticed.stderr, /refinery skill status --json/);

  const suppressed = runCli(["version", "--no-update-check", "--json"], { env, updateCheck: true });
  assert.equal(suppressed.status, 0, suppressed.stderr || suppressed.stdout);
  assert.equal(suppressed.stderr, "");
});

test("doctor validates the bounded Codex memory home without model credentials", () => {
  const memoryHome = seedCodexMemoryHome();
  const codexHome = path.dirname(memoryHome);
  const refineryHome = path.join(os.tmpdir(), `refinery-doctor-home-${Date.now()}`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-doctor-cwd-"));
  const result = runCli(["doctor", "--memory-home", memoryHome, "--json"], {
    cwd,
    env: {
      CODEX_HOME: codexHome,
      REFINERY_HOME: refineryHome,
      CORAL_API_KEY: undefined,
    },
  });
  const parsed = parseJson(result.stdout);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.memoryHome, memoryHome);
  assert.equal(parsed.memoryHomeSafe, true);
  assert.equal(parsed.memoryHomeExists, true);
  assert.equal(parsed.authRequired, false);
  assert.deepEqual(parsed.modelAuth, {
    requiredForLiveReview: true,
    present: false,
    source: "missing",
    provider: null,
    credentialPath: path.join(refineryHome, "credentials", "coral-api-key"),
  });
  assert.deepEqual(parsed.storedAuth, {
    coral: {
      present: false,
      path: path.join(refineryHome, "credentials", "coral-api-key"),
    },
  });
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

test("sources inspect reports bounded source sets as structured JSON", () => {
  const memoryHome = seedCodexMemoryHome();
  const result = runCli([
    "sources",
    "inspect",
    "--source",
    "codex:memories",
    "--memory-home",
    memoryHome,
    "--json",
  ]);
  const parsed = parseJson(result.stdout);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "sources inspect");
  assert.equal((parsed.counts as { sourceSets?: number }).sourceSets, 1);
  assert.equal((parsed.counts as { documents?: number }).documents, 3);
  const sources = parsed.sources as Array<Record<string, unknown>>;
  assert.equal(sources[0]?.role, "codex-memories");
  assert.equal(((sources[0]?.spec as Record<string, unknown>)?.kind), "codex:memories");
});

test("graph CLI syncs, reports status, inspects nodes and neighbours, and emits a bounded retrieval plan", () => {
  const memoryHome = seedCodexMemoryHome();
  const refineryHome = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-graph-home-"));
  const common = ["--project", repoRoot, "--home", refineryHome, "--json"];
  const synced = runCli([
    "graph",
    "sync",
    "--source",
    "codex:memories",
    "--memory-home",
    memoryHome,
    ...common,
  ]);
  const syncJson = parseJson(synced.stdout);
  assert.equal(synced.status, 0, synced.stderr || synced.stdout);
  assert.equal(syncJson.ok, true);
  assert.equal(syncJson.command, "graph sync");
  assert.equal(syncJson.canonicalSourcesMutated, false);
  const graphPath = String(syncJson.graphPath);
  assert.equal(fs.statSync(graphPath).isFile(), true);
  const index = new LibsqlGraphStore(graphPath).read();
  assert.ok(index);
  const memoryNode = index.nodes.find((node) => node.kind === "memory");
  assert.ok(memoryNode);

  const status = runCli(["graph", "status", ...common]);
  const statusJson = parseJson(status.stdout);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(statusJson.command, "graph status");
  assert.equal(statusJson.exists, true);
  assert.equal(Number((statusJson.counts as Record<string, unknown>).nodes) > 0, true);

  const inspected = runCli(["graph", "inspect", memoryNode.id, ...common]);
  const inspectJson = parseJson(inspected.stdout);
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  assert.equal(inspectJson.command, "graph inspect");
  assert.equal((inspectJson.node as Record<string, unknown>).id, memoryNode.id);

  const neighbors = runCli(["graph", "neighbors", memoryNode.id, "--depth", "1", ...common]);
  const neighborsJson = parseJson(neighbors.stdout);
  assert.equal(neighbors.status, 0, neighbors.stderr || neighbors.stdout);
  assert.equal(neighborsJson.command, "graph neighbors");
  assert.equal(Array.isArray(neighborsJson.nodes), true);
  assert.equal(Array.isArray(neighborsJson.edges), true);

  const planned = runCli([
    "graph",
    "plan",
    "--request",
    "Refinery dry-run proposals",
    "--seed",
    memoryNode.id,
    "--max-nodes",
    "4",
    "--max-edges",
    "4",
    "--max-hops",
    "1",
    "--max-chars",
    "500",
    "--max-tokens",
    "125",
    ...common,
  ]);
  const planJson = parseJson(planned.stdout);
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  assert.equal(planJson.command, "graph plan");
  const plan = planJson.plan as Record<string, unknown>;
  assert.equal(Array.isArray(plan.selectedNodes), true);
  assert.equal((plan.limits as Record<string, unknown>).maxNodes, 4);
  assert.equal((plan.runtimeProjection as Record<string, unknown>).nextSeam, "sleeping-unit-first-wake-expansion");
});

test("graph CLI failures are structured, actionable, and nonzero", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-missing-graph-"));
  const result = runCli(["graph", "inspect", "graph-node:missing", "--home", home, "--project", repoRoot, "--json"]);
  const parsed = parseJson(result.stdout);

  assert.notEqual(result.status, 0);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "graph inspect");
  const error = parsed.error as Record<string, unknown>;
  assert.equal(error.code, "GRAPH_INDEX_NOT_FOUND");
  assert.match(String(error.message), /graph sync first/i);
  assert.equal((error.details as Record<string, unknown>).next, "refinery graph sync --json");
});

test("gateway and UI CLI expose redacted lifecycle state plus an explicit capability URL", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-gateway-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  const common = ["--home", home, "--project", project, "--json"];
  const configured = runCli(["ui", "config", "--browser-open", "on", ...common]);
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  assert.equal((parseJson(configured.stdout).config as Record<string, unknown>).browserOpenOnSync, true);

  const started = runCli(["gateway", "start", ...common]);
  try {
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const startJson = parseJson(started.stdout);
    assert.equal(startJson.running, true);
    assert.match(String(startJson.uiUrl), /^http:\/\/127\.0\.0\.1:\d+\/#cap=/);
    assert.doesNotMatch(JSON.stringify(startJson.publicState), /capability|token/i);

    const status = runCli(["gateway", "status", ...common]);
    const statusJson = parseJson(status.stdout);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(statusJson.running, true);
    assert.equal(statusJson.uiUrl, undefined);

    const url = runCli(["ui", "url", ...common]);
    assert.equal(url.status, 0, url.stderr || url.stdout);
    assert.match(String(parseJson(url.stdout).url), /#cap=/);
  } finally {
    const stopped = runCli(["gateway", "stop", ...common]);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.equal(parseJson(stopped.stdout).running, false);
  }
});

test("review aborts on graph preparation failure instead of falling back to broad legacy context", () => {
  const memoryHome = seedCodexMemoryHome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-review-graph-failure-"));
  const blockedHome = path.join(tmp, "home-is-a-file");
  fs.writeFileSync(blockedHome, "not a directory");
  const memoryPath = path.join(memoryHome, "MEMORY.md");
  const original = fs.readFileSync(memoryPath);
  const result = runCli([
    "review",
    "--source",
    "codex:memories",
    "--target",
    "codex:memories",
    "--project",
    repoRoot,
    "--memory-home",
    memoryHome,
    "--home",
    blockedHome,
    "--request",
    "graph preparation must succeed",
    "--json",
  ]);
  const parsed = parseJson(result.stdout);

  assert.notEqual(result.status, 0);
  assert.equal((parsed.error as Record<string, unknown>).code, "GRAPH_STORE_WRITE_FAILED");
  assert.equal((parsed.error as Record<string, unknown>).phase, "graph-store");
  assert.doesNotMatch(JSON.stringify(parsed), /CORAL_/);
  assert.deepEqual(fs.readFileSync(memoryPath), original);
});

test("set auth coral stores a redacted Coral credential under Refinery home", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-set-auth-"));
  const home = path.join(tmp, "refinery-home");
  const result = runCli(["set", "auth", "coral", "--home", home, "--value-stdin", "--json"], {
    input: "coral-test-secret\n",
  });
  const parsed = parseJson(result.stdout);
  const credentialPath = path.join(home, "credentials", "coral-api-key");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "set auth");
  assert.equal(parsed.provider, "coral");
  assert.deepEqual(parsed.credential, {
    present: true,
    path: credentialPath,
    source: "credentials",
    mode: process.platform === "win32" ? "platform-managed" : "0600",
  });
  assert.equal(fs.readFileSync(credentialPath, "utf8"), "coral-test-secret\n");
  assert.doesNotMatch(result.stdout, /coral-test-secret/);
  if (process.platform !== "win32") {
    assert.equal((fs.statSync(credentialPath).mode & 0o777).toString(8), "600");
  }
});

test("removed commands return structured JSON failures", () => {
  for (const args of [
    ["instance", "init", "--json"],
    ["module", "check", "--descriptor", "refinery-module.json", "--json"],
    ["review", "--runtime", "sequential", "--json"],
    ["review", "--source", "claude-code-sessions", "--json"],
  ]) {
    const result = runCli(args);
    const parsed = parseJson(result.stdout);

    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(parsed.ok, false);
    assert.equal(
      (parsed.error as { code?: string }).code,
      args.includes("claude-code-sessions") ? "INVALID_SOURCE_SPEC" : "INVALID_OPTION",
    );
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

  assert.match(skill, /^---\r?\nname: refinery/m);
  assert.match(skill, /Use whenever Codex is asked to inspect, audit, summarize, or propose edits from Codex memories, sessions, skills, files, or mixed source sets using Refinery/);
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
  assert.equal(fs.statSync(path.join(home, "graphs/by-project")).isDirectory(), true);
  assert.equal(fs.statSync(installedSkill).isFile(), true);
  assert.match(fs.readFileSync(installedSkill, "utf8"), /^---\r?\nname: refinery/m);
  const codexSkill = parsed.codexSkill as Record<string, unknown>;
  assert.equal(codexSkill.requested, true);
  assert.equal(codexSkill.action, "installed");
  assert.equal(codexSkill.path, installedSkill);
  assert.equal(codexSkill.managed, true);
  assert.equal(codexSkill.conflict, false);
  assert.equal(codexSkill.packageVersion, "0.3.1");
  assert.match(String(codexSkill.installedTreeHash), /^[a-f0-9]{64}$/);
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
  assert.match(fs.readFileSync(installedSkill, "utf8"), /^---\r?\nname: refinery/m);
  assert.equal((forcedJson.codexSkill as { action?: string }).action, "overwritten");
});

test("skill install installs bundled Codex skill without initializing Refinery state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-skill-install-"));
  const codexHome = path.join(tmp, "codex-home");
  const installedSkill = path.join(codexHome, "skills/refinery/SKILL.md");
  const result = runCli(["skill", "install", "--codex-home", codexHome, "--json"]);
  const parsed = parseJson(result.stdout);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "skill install");
  assert.equal(fs.statSync(installedSkill).isFile(), true);
  assert.match(fs.readFileSync(installedSkill, "utf8"), /^---\r?\nname: refinery/m);
  const codexSkill = parsed.codexSkill as Record<string, unknown>;
  assert.equal(codexSkill.requested, true);
  assert.equal(codexSkill.action, "installed");
  assert.equal(codexSkill.path, installedSkill);
  assert.equal(codexSkill.managed, true);
  assert.equal(codexSkill.conflict, false);
  assert.equal(fs.existsSync(path.join(tmp, "refinery-home")), false);
});

test("skill status reports missing then current state with package and tree hashes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-skill-state-"));
  const codexHome = path.join(tmp, "codex-home");
  const missing = parseJson(runCli(["skill", "status", "--codex-home", codexHome, "--json"]).stdout);
  assert.equal((missing.codexSkill as Record<string, unknown>).state, "missing");
  assert.equal(missing.packageVersion, "0.3.1");
  assert.match(String((missing.codexSkill as Record<string, unknown>).bundledTreeHash), /^[a-f0-9]{64}$/);
  assert.equal((missing.repair as Record<string, unknown>).command, "refinery skill install --json");

  assert.equal(runCli(["skill", "install", "--codex-home", codexHome, "--json"]).status, 0);
  const current = parseJson(runCli(["skill", "status", "--codex-home", codexHome, "--json"]).stdout);
  const currentSkill = current.codexSkill as Record<string, unknown>;
  assert.equal(currentSkill.state, "current");
  assert.equal(currentSkill.installedTreeHash, currentSkill.bundledTreeHash);
  assert.equal(currentSkill.installedPackageVersion, "0.3.1");
  assert.equal(current.repair, null);
  assert.match(String(current.reloadAfterInstall), /new Codex task/i);
});

test("skill status and ordinary CLI use report stale managed skills without mutating them", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-skill-status-"));
  const codexHome = path.join(tmp, "codex-home");
  const skillDir = path.join(codexHome, "skills/refinery");
  const installedSkill = path.join(skillDir, "SKILL.md");
  const installed = runCli(["skill", "install", "--codex-home", codexHome, "--json"]);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  fs.appendFileSync(installedSkill, "\n# older package-managed fixture\n");
  const installedTreeHash = hashSkillTree(skillDir);
  fs.writeFileSync(path.join(skillDir, ".refinery-managed.json"), `${JSON.stringify({
    schemaVersion: "refinery.managed-skill.v1",
    packageName: "@itsshadowai/refinery",
    packageVersion: "0.2.0",
    installedTreeHash,
  }, null, 2)}\n`);
  const before = fs.readFileSync(installedSkill, "utf8");

  const status = runCli(["skill", "status", "--codex-home", codexHome, "--json"]);
  const statusJson = parseJson(status.stdout);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal((statusJson.codexSkill as Record<string, unknown>).state, "stale-managed");
  assert.equal((statusJson.repair as Record<string, unknown>).command, "refinery skill install --json");

  const ordinary = runCli(["version", "--json"], { env: { CODEX_HOME: codexHome } });
  assert.equal(ordinary.status, 0, ordinary.stderr || ordinary.stdout);
  assert.equal(parseJson(ordinary.stdout).version, "0.3.1");
  assert.match(ordinary.stderr, /package-managed Refinery Codex skill is stale/);
  assert.match(ordinary.stderr, /refinery skill install --json/);
  assert.match(ordinary.stderr, /No skill files were changed automatically/);
  assert.equal(fs.readFileSync(installedSkill, "utf8"), before);
});

test("customized skill notice requires explicit human confirmation before force replacement", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-skill-customized-"));
  const codexHome = path.join(tmp, "codex-home");
  const installedSkill = path.join(codexHome, "skills/refinery/SKILL.md");
  assert.equal(runCli(["skill", "install", "--codex-home", codexHome, "--json"]).status, 0);
  fs.appendFileSync(installedSkill, "\n# user customization\n");

  const ordinary = runCli(["version", "--json"], { env: { CODEX_HOME: codexHome } });
  assert.equal(ordinary.status, 0, ordinary.stderr || ordinary.stdout);
  assert.match(ordinary.stderr, /differs from the package bundle/);
  assert.match(ordinary.stderr, /Only after the human confirms/);
  assert.match(ordinary.stderr, /refinery skill install --force --json/);
  assert.match(fs.readFileSync(installedSkill, "utf8"), /user customization/);
});

test("repo does not publish duplicate local Codex skill names", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, ".agents/skills/refinery-memory-review")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, ".codex-test/skills/refinery-memory-proposal")), false);
});
