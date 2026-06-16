import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, ensureProject } from "../examples/reference-sqlite/db.ts";
import { refineryCoralAgentNames } from "./coral/definitions.ts";

const cliPath = path.resolve(import.meta.dirname, "cli.ts");
const packagePath = path.resolve(import.meta.dirname, "..", "package.json");

function parseJsonOutput(result: ReturnType<typeof runCli>): Record<string, unknown> {
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stderr || result.stdout);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function makeFixtureAdapter(tmp: string): string {
  const adapterPath = path.join(tmp, "fixture-adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    `
export const adapter = {
  name: "fixture-memory",
  async listSourceEvidence() {
    return [{
      id: "source:session-a:0",
      kind: "session",
      path: "/workspace/session-a.jsonl",
      text: "The team decided agent-callable CLIs are the default Refinery product surface.",
      refs: [{ source_id: "source:session-a", chunk_id: "0" }]
    }];
  },
  async searchSourceEvidence() {
    return this.listSourceEvidence();
  },
  async getSourceEvidence(input) {
    const sources = await this.listSourceEvidence({ scope: input.scope });
    return sources.find((source) => source.id === input.id) ?? null;
  },
  async listActiveMemories() {
    return [{
      id: "memory:1",
      type: "procedural",
      scope: "project",
      status: "active",
      body: "Refinery core must stay storage-agnostic.",
      confidence: 0.91,
      provenance: { kind: "fixture" }
    }];
  },
  async searchActiveMemories() {
    return this.listActiveMemories();
  },
  async getActiveMemory(input) {
    const memories = await this.listActiveMemories({ scope: input.scope });
    return memories.find((memory) => memory.id === input.id) ?? null;
  }
};
`,
  );
  return adapterPath;
}

function seedReferenceSqliteHome(tmp: string): { home: string; project: string } {
  const project = path.join(tmp, "project");
  const home = path.join(project, ".refinery");
  const rawDir = path.join(home, "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const sourceText =
    "The team decided Refinery review should be Coral-coordinated by default while emitting proposals only.";
  const rawPath = path.join(rawDir, "source-fixture");
  fs.writeFileSync(rawPath, sourceText);

  const db = openDb({
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir,
  });
  try {
    const projectId = ensureProject(db, project, "fixture-project");
    db.prepare(
      `INSERT INTO source
         (project_id, kind, source_path, session_id, sha256, byte_size, source_mtime, raw_blob, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      "claude-code-session",
      path.join(project, "fixture-session.jsonl"),
      "fixture-session",
      "source-fixture",
      Buffer.byteLength(sourceText),
      new Date().toISOString(),
      rawPath,
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO memory
         (project_id, type, scope, status, body, confidence, provenance_kind, source_id, source_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      "procedural",
      "project",
      "active",
      "Refinery emits proposals and host systems own durable memory mutation.",
      0.9,
      "claude-memory-legacy",
      1,
      path.join(project, "memory.md"),
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
  return { home, project };
}

function makeInvalidSourceAdapter(tmp: string): string {
  const adapterPath = path.join(tmp, "invalid-source-adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    `
export const adapter = {
  name: "invalid-source-memory",
  async listSourceEvidence() {
    return [{ id: 123, kind: "session", text: "bad id" }];
  },
  async searchSourceEvidence() {
    return [];
  },
  async getSourceEvidence() {
    return null;
  },
  async listActiveMemories() {
    return [{
      id: "memory:1",
      type: "semantic",
      scope: "project",
      status: "active",
      body: "Valid memory."
    }];
  },
  async searchActiveMemories() {
    return [];
  },
  async getActiveMemory() {
    return null;
  }
};
`,
  );
  return adapterPath;
}

function makeShapeInvalidAdapter(tmp: string): string {
  const adapterPath = path.join(tmp, "shape-invalid-adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    `
export const adapter = {
  name: "shape-invalid",
  async listSourceEvidence() {
    return [];
  }
};
`,
  );
  return adapterPath;
}

function makeInvalidMemoryAdapter(tmp: string): string {
  const adapterPath = path.join(tmp, "invalid-memory-adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    `
export const adapter = {
  name: "invalid-memory",
  async listSourceEvidence() {
    return [{
      id: "source:1",
      kind: "session",
      text: "Valid source."
    }];
  },
  async searchSourceEvidence() {
    return [];
  },
  async getSourceEvidence() {
    return null;
  },
  async listActiveMemories() {
    return [{ id: "memory:1", type: "semantic", scope: "project", body: "Missing status." }];
  },
  async searchActiveMemories() {
    return [];
  },
  async getActiveMemory() {
    return null;
  }
};
`,
  );
  return adapterPath;
}

function makeModuleDescriptor(tmp: string, overrides: Record<string, unknown> = {}): string {
  const descriptorPath = path.join(tmp, "module-descriptor.json");
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify(
      {
        schemaVersion: "refinery.module.v1",
        kind: "runtime",
        name: "refinery-fixture-runtime",
        version: "0.0.1",
        entrypoint: "./runtime.mjs",
        capabilities: ["review.live"],
        ...overrides,
      },
      null,
      2,
    ),
  );
  return descriptorPath;
}

function startFailingSink(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-failing-sink-"));
  const serverPath = path.join(tmp, "server.mjs");
  const portPath = path.join(tmp, "port.txt");
  fs.writeFileSync(
    serverPath,
    `
import fs from "node:fs";
import http from "node:http";

const portPath = process.argv[2];
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("sink unavailable");
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(portPath, String(address.port));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

setInterval(() => {}, 1000);
`,
  );
  const child = spawn(process.execPath, [serverPath, portPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let poll: NodeJS.Timeout;
    const failStartup = (error: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      child.kill("SIGTERM");
      reject(error);
    };
    child.once("exit", (code, signal) => {
      failStartup(new Error(`Failing sink fixture exited before startup: code=${code} signal=${signal}`));
    });
    poll = setInterval(() => {
      if (!fs.existsSync(portPath)) {
        if (Date.now() - startedAt > 5000) {
          failStartup(new Error("Timed out starting failing sink fixture."));
        }
        return;
      }
      settled = true;
      clearInterval(poll);
      const port = fs.readFileSync(portPath, "utf8");
      resolve({
        url: `http://127.0.0.1:${port}/refinery-callback`,
        close: () =>
          new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once("exit", () => done());
            child.kill("SIGTERM");
          }),
      });
    }, 10);
  });
}

function startHangingSink(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, _res) => {
    // Intentionally left open so the CLI timeout path must abort the request.
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}/refinery-callback`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function startFakeCoralReviewServer(): Promise<{
  apiUrl: string;
  state: {
    sessionRequest: Record<string, unknown> | null;
    seedPacket: Record<string, unknown> | null;
    deleteCount: number;
    sessionCreateCount: number;
    threadCreateCount: number;
  };
  close: () => Promise<void>;
}> {
  const state: {
    sessionRequest: Record<string, unknown> | null;
    seedPacket: Record<string, unknown> | null;
    deleteCount: number;
  } = {
    sessionRequest: null,
    seedPacket: null,
    deleteCount: 0,
    sessionCreateCount: 0,
    threadCreateCount: 0,
  };
  const session = { namespace: "refinery-test-namespace", sessionId: "session-1" };
  const threadId = "thread-1";
  let messages: Array<Record<string, unknown>> = [];

  function sendJson(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) as Record<string, unknown> : {});
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function buildSpecialistMessages(seed: Record<string, unknown>) {
    const sourceChunks = Array.isArray(seed.source_chunks) ? seed.source_chunks as Array<Record<string, unknown>> : [];
    const refs = Array.isArray(sourceChunks[0]?.refs) ? sourceChunks[0].refs : [{ source_id: "source:1" }];
    const body =
      "Refinery review should run through Coral coordination by default while emitting proposals only.";
    messages = [
      {
        id: "seed-message",
        threadId,
        senderName: "refinery-capture",
        mentionNames: ["refinery-capture"],
        text: JSON.stringify(seed),
      },
      {
        id: "capture-message",
        threadId,
        senderName: "refinery-capture",
        mentionNames: ["refinery-distillation"],
        text: JSON.stringify({
          type: "refinery-review-output",
          runId: seed.runId,
          step: "capture",
          output: {
            candidates: [
              {
                claim: body,
                source_refs: refs,
                why_future_useful: "Captures the default product surface for coding-agent use.",
              },
            ],
          },
        }),
      },
      {
        id: "distillation-message",
        threadId,
        senderName: "refinery-distillation",
        mentionNames: ["refinery-schema"],
        text: JSON.stringify({
          type: "refinery-review-output",
          runId: seed.runId,
          step: "distillation",
          output: {
            distilled: [
              {
                body,
                source_refs: refs,
                rationale: "Keeps the memory atomic and action-oriented.",
              },
            ],
          },
        }),
      },
      {
        id: "schema-message",
        threadId,
        senderName: "refinery-schema",
        mentionNames: ["refinery-relevance"],
        text: JSON.stringify({
          type: "refinery-review-output",
          runId: seed.runId,
          step: "schema",
          output: {
            typed: [
              {
                body,
                memory_type: "procedural",
                primary_type: "procedural",
                secondary_type: null,
                type_confidence: 0.86,
                type_rationale: "It describes how to run the tool.",
                ambiguities: [],
                durability: "durable",
                ttl: null,
                proposed_scope: "project",
                action: "create",
                target_memory_id: null,
                source_refs: refs,
              },
            ],
          },
        }),
      },
      {
        id: "relevance-message",
        threadId,
        senderName: "refinery-relevance",
        mentionNames: ["refinery-relationship-review"],
        text: JSON.stringify({
          type: "refinery-review-output",
          runId: seed.runId,
          step: "relevance",
          output: {
            proposals: [
              {
                memory_type: "procedural",
                proposed_scope: "project",
                body,
                confidence: 0.82,
                rationale: "Useful for future coding-agent integrations.",
                source_refs: refs,
                action: "create",
                target_memory_id: null,
              },
            ],
            rejected: [],
          },
        }),
      },
      {
        id: "relationship-message",
        threadId,
        senderName: "refinery-relationship-review",
        mentionNames: [],
        text: JSON.stringify({
          type: "refinery-review-output",
          runId: seed.runId,
          step: "relationship-review",
          output: {
            findings: [
              {
                body,
                relation: "novel",
                target_memory_id: null,
                confidence: 0.78,
                rationale: "No duplicate active memory in the provided hints.",
                source_refs: refs,
                memory_refs: [],
              },
            ],
          },
        }),
      },
    ];
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/v1/registry") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.startsWith("/api/v1/registry/local/")) {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url === "/api/v1/local/session") {
        state.sessionCreateCount += 1;
        state.sessionRequest = await readBody(req);
        sendJson(res, 200, session);
        return;
      }
      if (req.method === "GET" && url.endsWith("/extended")) {
        sendJson(res, 200, {
          agents: refineryCoralAgentNames.map((name) => ({
            name,
            status: {
              type: "running",
              connectionStatus: {
                type: "connected",
                communicationStatus: { type: "waiting_message" },
              },
            },
          })),
          threads: [
            {
              id: threadId,
              name: "Refinery review fixture",
              participants: refineryCoralAgentNames,
              messages,
            },
          ],
        });
        return;
      }
      if (req.method === "POST" && url.endsWith("/thread")) {
        state.threadCreateCount += 1;
        await readBody(req);
        sendJson(res, 200, {
          thread: {
            id: threadId,
            name: "Refinery review fixture",
            participants: refineryCoralAgentNames,
          },
        });
        return;
      }
      if (req.method === "POST" && url.endsWith("/thread/message")) {
        const body = await readBody(req);
        state.seedPacket = JSON.parse(String(body.content)) as Record<string, unknown>;
        buildSpecialistMessages(state.seedPacket);
        sendJson(res, 200, {
          status: "ok",
          message: messages[0],
        });
        return;
      }
      if (req.method === "DELETE" && url.startsWith("/api/v1/local/session/")) {
        state.deleteCount += 1;
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: `unhandled ${req.method} ${url}` });
    } catch (error) {
      sendJson(res, 500, { error: (error as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        apiUrl: `http://127.0.0.1:${address.port}`,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function runCliAsync(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

function runBin(args: string[], env: NodeJS.ProcessEnv = {}) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    bin: { refinery: string };
  };
  const binPath = path.resolve(path.dirname(packagePath), packageJson.bin.refinery);
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: path.dirname(packagePath),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("refinery adapter check emits stable JSON for a valid adapter module", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-adapter-"));
  const adapterPath = makeFixtureAdapter(tmp);

  const result = runCli(["adapter", "check", "--adapter", adapterPath, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.command, "adapter check");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.adapter.name, "fixture-memory");
  assert.equal(parsed.valid, true);
  assert.equal(parsed.capabilities.listSourceEvidence, true);
  assert.equal(parsed.capabilities.searchSourceEvidence, true);
  assert.equal(parsed.capabilities.getSourceEvidence, true);
  assert.equal(parsed.capabilities.applyProposal, false);
});

test("refinery adapter check probe validates adapter record shapes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-adapter-probe-"));
  const adapterPath = makeFixtureAdapter(tmp);

  const result = runCli(["adapter", "check", "--adapter", adapterPath, "--probe", "--scope", "project", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.probed, true);
  assert.deepEqual(parsed.probeErrors, []);
});

test("refinery adapter check probe emits structured errors for invalid source records", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-adapter-invalid-source-"));
  const adapterPath = makeInvalidSourceAdapter(tmp);

  const result = runCli(["adapter", "check", "--adapter", adapterPath, "--probe", "--scope", "project", "--json"]);

  assert.equal(result.status, 1);
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.equal((parsed.error as { code: string }).code, "ADAPTER_PROBE_FAILED");
  assert.match(JSON.stringify(parsed), /sources\[0\]\.id/);
});

test("refinery adapter check probe emits structured errors for invalid memory records", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-adapter-invalid-memory-"));
  const adapterPath = makeInvalidMemoryAdapter(tmp);

  const result = runCli(["adapter", "check", "--adapter", adapterPath, "--probe", "--scope", "project", "--json"]);

  assert.equal(result.status, 1);
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.equal((parsed.error as { code: string }).code, "ADAPTER_PROBE_FAILED");
  assert.match(JSON.stringify(parsed), /activeMemories\[0\]\.status/);
});

test("refinery review with --json emits structured errors for invalid mode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-json-mode-"));
  const adapterPath = makeFixtureAdapter(tmp);

  const result = runCli(["review", "--runtime", "sequential", "--adapter", adapterPath, "--mode", "sideways", "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "review");
  assert.equal((parsed.error as { code: string }).code, "INVALID_OPTION");
});

test("refinery review defaults to Coral-managed coordination for Claude Code session sources", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-coral-review-"));
  const fixture = seedReferenceSqliteHome(tmp);
  const coral = await startFakeCoralReviewServer();
  const outputDir = path.join(tmp, "runs");
  try {
    const result = await runCliAsync([
      "review",
      "--project",
      fixture.project,
      "--source",
      "claude-code-sessions",
      "--target",
      "codex-memory",
      "--home",
      fixture.home,
      "--run-id",
      "coral-review-test",
      "--output-dir",
      outputDir,
      "--coral-url",
      coral.apiUrl,
      "--coral-no-start",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJsonOutput(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "review");
    assert.equal(parsed.mode, "coral");
    assert.equal((parsed.adapter as { name: string }).name, "reference-sqlite");
    assert.equal(parsed.scope, "project");
    assert.equal((parsed.counts as { sources: number }).sources, 1);
    assert.equal((parsed.counts as { activeMemories: number }).activeMemories, 1);
    assert.equal((parsed.counts as { proposals: number }).proposals, 1);
    assert.equal((parsed.proposals as Array<{ action: string; lifecycle: string; sourceRefs: unknown[] }>)[0].action, "create");
    assert.equal((parsed.proposals as Array<{ lifecycle: string }>)[0].lifecycle, "proposed");
    assert.equal((parsed.proposals as Array<{ sourceRefs: unknown[] }>)[0].sourceRefs.length > 0, true);
    assert.equal((parsed.metadata as Record<string, unknown>).writesAttempted, false);

    const runtime = (parsed.metadata as { runtime: Record<string, unknown> }).runtime;
    assert.equal(runtime.kind, "coral");
    assert.equal(runtime.serverMode, "attached");
    assert.equal(runtime.namespace, "refinery-test-namespace");
    assert.equal(runtime.sessionId, "session-1");
    assert.equal(runtime.threadId, "thread-1");
    assert.deepEqual(runtime.agents, refineryCoralAgentNames);
    assert.equal(coral.state.deleteCount, 1);
    const sessionRequest = coral.state.sessionRequest as {
      agentGraphRequest: { agents: unknown[]; groups: string[][] };
    };
    assert.deepEqual(sessionRequest.agentGraphRequest.groups, [refineryCoralAgentNames]);
    assert.equal(sessionRequest.agentGraphRequest.agents.length, 5);

    const runDir = path.join(outputDir, "coral-review-test");
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.mode, "coral");
    assert.equal(manifest.runtime.threadId, "thread-1");
    assert.equal(manifest.artifacts.coral, "coral.json");
    assert.equal(manifest.artifacts.transcript, "transcript.json");

    const intake = JSON.parse(fs.readFileSync(path.join(runDir, "input.json"), "utf8"));
    assert.equal(intake.source, "claude-code-sessions");
    assert.equal(intake.target, "codex-memory");
    assert.equal(intake.noApply, true);
    assert.equal(intake.source_chunks.length, 1);
    assert.match(intake.source_chunks[0].text, /Coral-coordinated by default/);
    assert.equal(coral.state.seedPacket?.type, "refinery-review-intake");
    assert.equal(coral.state.seedPacket?.target, "codex-memory");

    const coralArtifact = JSON.parse(fs.readFileSync(path.join(runDir, "coral.json"), "utf8"));
    assert.equal(coralArtifact.session.sessionId, "session-1");
    assert.equal(coralArtifact.threadId, "thread-1");
    assert.equal(coralArtifact.specialistMessages.length, 5);
  } finally {
    await coral.close();
  }
});

test("refinery review can attach to an existing Coral session and thread without tearing them down", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-coral-existing-session-"));
  const fixture = seedReferenceSqliteHome(tmp);
  const coral = await startFakeCoralReviewServer();
  const outputDir = path.join(tmp, "runs");
  try {
    const result = await runCliAsync([
      "review",
      "--project",
      fixture.project,
      "--source",
      "claude-code-sessions",
      "--target",
      "codex-memory",
      "--home",
      fixture.home,
      "--run-id",
      "coral-existing-test",
      "--output-dir",
      outputDir,
      "--coral-url",
      coral.apiUrl,
      "--coral-no-start",
      "--coral-namespace",
      "existing-namespace",
      "--coral-session-id",
      "existing-session",
      "--coral-thread-id",
      "thread-1",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJsonOutput(result);
    const runtime = (parsed.metadata as { runtime: Record<string, unknown> }).runtime;
    assert.equal(runtime.namespace, "existing-namespace");
    assert.equal(runtime.sessionId, "existing-session");
    assert.equal(runtime.threadId, "thread-1");
    assert.equal(runtime.sessionCreated, false);
    assert.equal(runtime.threadCreated, false);
    assert.equal(coral.state.sessionCreateCount, 0);
    assert.equal(coral.state.threadCreateCount, 0);
    assert.equal(coral.state.deleteCount, 0);
  } finally {
    await coral.close();
  }
});

test("refinery trial inspect summarizes Coral review artifacts without rerunning", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-coral-inspect-"));
  const fixture = seedReferenceSqliteHome(tmp);
  const coral = await startFakeCoralReviewServer();
  const outputDir = path.join(tmp, "runs");
  try {
    const review = await runCliAsync([
      "review",
      "--project",
      fixture.project,
      "--source",
      "claude-code-sessions",
      "--target",
      "codex-memory",
      "--home",
      fixture.home,
      "--run-id",
      "coral-inspect-test",
      "--output-dir",
      outputDir,
      "--coral-url",
      coral.apiUrl,
      "--coral-no-start",
      "--json",
    ]);
    assert.equal(review.status, 0, review.stderr || review.stdout);

    const inspect = runCli([
      "trial",
      "inspect",
      "--run-dir",
      path.join(outputDir, "coral-inspect-test"),
      "--json",
    ]);

    assert.equal(inspect.status, 0, inspect.stderr);
    const parsed = parseJsonOutput(inspect);
    assert.equal(parsed.command, "trial inspect");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "coral");
    assert.deepEqual(parsed.lifecycleDistribution, { proposed: 1 });
    assert.equal((parsed.artifacts as Record<string, string>).coral, "coral.json");
    assert.equal((parsed.manifest as { runtime: { sessionId: string; threadId: string } }).runtime.sessionId, "session-1");
    assert.equal((parsed.manifest as { runtime: { threadId: string } }).runtime.threadId, "thread-1");
  } finally {
    await coral.close();
  }
});

test("refinery adapter check with --json emits structured errors for adapter load failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-adapter-load-fail-"));

  const result = runCli(["adapter", "check", "--adapter", path.join(tmp, "missing.mjs"), "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "adapter check");
  assert.equal((parsed.error as { code: string }).code, "ADAPTER_LOAD_FAILED");
});

test("refinery review with --json emits structured errors for adapter validation failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-adapter-validation-fail-"));
  const adapterPath = makeShapeInvalidAdapter(tmp);

  const result = runCli(["review", "--runtime", "sequential", "--adapter", adapterPath, "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "review");
  assert.equal((parsed.error as { code: string }).code, "ADAPTER_INVALID");
  assert.match(JSON.stringify(parsed.error), /searchSourceEvidence/);
});

test("refinery review live with --json emits structured errors for model caller load failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-model-caller-load-fail-"));
  const adapterPath = makeFixtureAdapter(tmp);

  const result = runCli(
    [
      "review",
      "--runtime",
      "sequential",
      "--mode",
      "live",
      "--adapter",
      adapterPath,
      "--model-caller",
      path.join(tmp, "missing-model.mjs"),
      "--json",
    ],
    {
      OPENROUTER_API_KEY: "test-key",
      REFINERY_MODEL_NAME: "deepseek/deepseek-v4-pro",
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "review");
  assert.equal((parsed.error as { code: string }).code, "MODEL_CALLER_LOAD_FAILED");
});

test("refinery review validates source limits and run ids before writing artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-validation-"));
  const adapterPath = makeFixtureAdapter(tmp);

  for (const args of [
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--source-limit", "not-a-number", "--json"],
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--source-limit", "-1", "--json"],
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--source-limit", "0", "--json"],
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--source-limit", "1.5", "--json"],
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--source-char-limit", "0", "--json"],
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--source-char-limit", "1.5", "--json"],
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--run-id", "../escape", "--json"],
    ["review", "--runtime", "sequential", "--adapter", adapterPath, "--run-id", "bad:name", "--json"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, args.join(" "));
    const parsed = parseJsonOutput(result);
    assert.equal(parsed.ok, false);
    assert.equal((parsed.error as { code: string }).code, "INVALID_OPTION");
  }
});

test("refinery review emits proposal JSON and deterministic dry-run artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-review-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const runHome = path.join(tmp, "runs");

  const result = runCli([
    "review",
    "--runtime",
    "sequential",
    "--adapter",
    adapterPath,
    "--scope",
    "project",
    "--run-id",
    "run-test",
    "--output-dir",
    runHome,
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.schemaVersion, "refinery.review.v1");
  assert.equal(parsed.command, "review");
  assert.equal(parsed.adapter.name, "fixture-memory");
  assert.equal(parsed.scope, "project");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.counts.sources, 1);
  assert.equal(parsed.counts.activeMemories, 1);
  assert.equal(parsed.counts.proposals, 1);
  assert.equal(parsed.proposals[0].action, "create");
  assert.equal(parsed.proposals[0].lifecycle, "proposed");
  assert.equal(parsed.proposals[0].schemaVersion, "refinery.review.v1");
  assert.equal(parsed.proposals[0].targetMemoryId, null);
  assert.match(parsed.proposals[0].body, /agent-callable CLIs/);

  const runDir = path.join(runHome, "run-test");
  for (const rel of [
    "input.json",
    "metadata.json",
    "manifest.json",
    "proposals.json",
    "rejected.json",
    "review.json",
    "steps/capture/output.parsed.json",
    "steps/distillation/output.parsed.json",
    "steps/schema/output.parsed.json",
    "steps/relevance/output.parsed.json",
    "steps/relationship-review/output.parsed.json",
  ]) {
    assert.equal(fs.existsSync(path.join(runDir, rel)), true, rel);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "refinery.review.v1");
  assert.equal(manifest.runId, "run-test");
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.mode, "deterministic");
  assert.equal(manifest.artifacts.review, "review.json");
  assert.equal(manifest.artifacts.proposals, "proposals.json");
  assert.equal(manifest.artifacts.steps.capture.outputParsed, "steps/capture/output.parsed.json");
  for (const artifact of [
    manifest.artifacts.input,
    manifest.artifacts.metadata,
    manifest.artifacts.review,
    manifest.artifacts.proposals,
    manifest.artifacts.rejected,
    manifest.artifacts.steps.capture.outputParsed,
  ]) {
    assert.equal(fs.existsSync(path.join(runDir, artifact)), true, artifact);
  }
  const schema = JSON.parse(fs.readFileSync(path.join(runDir, "steps/schema/output.parsed.json"), "utf8"));
  assert.equal(schema.typed[0].action, "create");
  assert.equal("mutation_op" in schema.typed[0], false);
});

test("refinery trial inspect summarizes deterministic run artifacts without rerunning", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-inspect-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const runHome = path.join(tmp, "runs");

  const review = runCli([
    "review",
    "--runtime",
    "sequential",
    "--adapter",
    adapterPath,
    "--scope",
    "project",
    "--run-id",
    "inspect-test",
    "--output-dir",
    runHome,
    "--json",
  ]);
  assert.equal(review.status, 0, review.stderr);

  const result = runCli([
    "trial",
    "inspect",
    "--run-dir",
    path.join(runHome, "inspect-test"),
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.command, "trial inspect");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "succeeded");
  assert.equal(parsed.schemaVersion, "refinery.review.v1");
  assert.equal(parsed.runId, "inspect-test");
  assert.equal(parsed.mode, "deterministic");
  assert.deepEqual(parsed.actionDistribution, { create: 1 });
  assert.deepEqual(parsed.lifecycleDistribution, { proposed: 1 });
  assert.equal((parsed.steps as Record<string, { outputParsed: boolean }>).capture.outputParsed, true);
  assert.equal((parsed.artifacts as Record<string, string>).manifest, "manifest.json");
});

test("refinery review live malformed model output emits JSON failure and failed-run artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-live-failure-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const modelPath = path.join(tmp, "bad-model.mjs");
  fs.writeFileSync(
    modelPath,
    `
const responses = {
  "capture": {"candidates":[{"claim":"Capture succeeds.","source_refs":[{"source_id":"source:session-a"}],"why_future_useful":"Sets up later parse failure."}]},
  "distillation": {"not_distilled":[]}
};
export async function callModel({ specialist }) {
  return JSON.stringify(responses[specialist.name] ?? {});
}
`,
  );

  const result = runCli(
    [
      "review",
      "--runtime",
      "sequential",
      "--mode",
      "live",
      "--adapter",
      adapterPath,
      "--scope",
      "project",
      "--run-id",
      "live-failure-test",
      "--output-dir",
      path.join(tmp, "runs"),
      "--model-caller",
      modelPath,
      "--json",
    ],
    {
      OPENROUTER_API_KEY: "test-key",
      REFINERY_MODEL_NAME: "deepseek/deepseek-v4-pro",
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.runId, "live-failure-test");
  assert.equal(parsed.runDir, path.join(tmp, "runs", "live-failure-test"));
  assert.equal((parsed.error as { phase: string; code: string }).phase, "live");
  assert.equal((parsed.error as { failedStep: string }).failedStep, "distillation");
  const statusPath = path.join(tmp, "runs", "live-failure-test", "status.json");
  assert.equal(fs.existsSync(statusPath), true);
  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.failedStep, "distillation");
  assert.equal(
    fs.existsSync(path.join(tmp, "runs", "live-failure-test", "steps", "distillation", "input.json")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(tmp, "runs", "live-failure-test", "steps", "distillation", "output.raw.md")),
    true,
  );
  assert.match(status.rawOutputPath, /steps\/distillation\/output\.raw\.md$/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(tmp, "runs", "live-failure-test", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.failedStep, "distillation");
  assert.equal(manifest.artifacts.status, "status.json");
  assert.equal(manifest.artifacts.review, "review.json");
  assert.equal(manifest.artifacts.steps.distillation.input, "steps/distillation/input.json");
  assert.equal(manifest.artifacts.steps.distillation.outputRaw, "steps/distillation/output.raw.md");
});

test("refinery trial inspect summarizes failed runs without treating inspection as failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-inspect-failed-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const modelPath = path.join(tmp, "bad-model.mjs");
  fs.writeFileSync(
    modelPath,
    `
export async function callModel() {
  return JSON.stringify({not_candidates: []});
}
`,
  );
  const runDir = path.join(tmp, "runs", "failed-inspect-test");
  const review = runCli(
    [
      "review",
      "--runtime",
      "sequential",
      "--mode",
      "live",
      "--adapter",
      adapterPath,
      "--scope",
      "project",
      "--run-id",
      "failed-inspect-test",
      "--output-dir",
      path.join(tmp, "runs"),
      "--model-caller",
      modelPath,
      "--json",
    ],
    {
      OPENROUTER_API_KEY: "test-key",
      REFINERY_MODEL_NAME: "deepseek/deepseek-v4-pro",
    },
  );
  assert.equal(review.status, 1);

  const result = runCli(["trial", "inspect", "--run-dir", runDir, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.command, "trial inspect");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.runId, "failed-inspect-test");
  assert.equal((parsed.error as { code: string }).code, "MODEL_OUTPUT_INVALID");
  assert.equal((parsed.steps as Record<string, { input: boolean; outputRaw: boolean }>).capture.input, true);
  assert.equal((parsed.steps as Record<string, { input: boolean; outputRaw: boolean }>).capture.outputRaw, true);
});

test("refinery trial inspect emits structured JSON failure for missing run dirs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-inspect-missing-"));

  const result = runCli([
    "trial",
    "inspect",
    "--run-dir",
    path.join(tmp, "missing-run"),
    "--json",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.command, "trial inspect");
  assert.equal(parsed.ok, false);
  assert.equal((parsed.error as { code: string }).code, "TRIAL_NOT_FOUND");
});

test("refinery review sink non-2xx emits JSON failure and failed-run artifacts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-sink-failure-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const sink = await startFailingSink();
  try {
    const result = runCli([
      "review",
      "--runtime",
      "sequential",
      "--adapter",
      adapterPath,
      "--scope",
      "project",
      "--run-id",
      "sink-failure-test",
      "--output-dir",
      path.join(tmp, "runs"),
      "--sink-url",
      sink.url,
      "--json",
    ]);

    assert.equal(result.status, 1);
    const parsed = parseJsonOutput(result);
    assert.equal(parsed.ok, false);
    assert.equal((parsed.error as { code: string }).code, "SINK_CALLBACK_FAILED");
    const status = JSON.parse(
      fs.readFileSync(path.join(tmp, "runs", "sink-failure-test", "status.json"), "utf8"),
    );
    assert.equal(status.status, "failed");
    assert.equal(status.error.code, "SINK_CALLBACK_FAILED");
  } finally {
    await sink.close();
  }
});

test("refinery review sink timeout emits JSON failure without hanging", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-sink-timeout-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const sink = await startHangingSink();
  try {
    const result = runCli([
      "review",
      "--runtime",
      "sequential",
      "--adapter",
      adapterPath,
      "--scope",
      "project",
      "--run-id",
      "sink-timeout-test",
      "--output-dir",
      path.join(tmp, "runs"),
      "--sink-url",
      sink.url,
      "--sink-timeout-ms",
      "20",
      "--json",
    ]);

    assert.equal(result.status, 1);
    const parsed = parseJsonOutput(result);
    assert.equal(parsed.ok, false);
    assert.equal((parsed.error as { code: string }).code, "SINK_CALLBACK_TIMEOUT");
    const status = JSON.parse(
      fs.readFileSync(path.join(tmp, "runs", "sink-timeout-test", "status.json"), "utf8"),
    );
    assert.equal(status.status, "failed");
    assert.equal(status.error.code, "SINK_CALLBACK_TIMEOUT");
  } finally {
    await sink.close();
  }
});

test("refinery review accepts a sink callback URL", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-sink-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const sinkPath = path.join(tmp, "sink.mjs");
  fs.writeFileSync(
    sinkPath,
    `
export const sink = {
  url: "file://${path.join(tmp, "callback.json")}"
};
`,
  );

  const result = runCli([
    "review",
    "--runtime",
    "sequential",
    "--adapter",
    adapterPath,
    "--scope",
    "project",
    "--run-id",
    "sink-cli-test",
    "--output-dir",
    path.join(tmp, "runs"),
    "--sink",
    sinkPath,
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.schemaVersion, "refinery.review.v1");
  assert.equal(parsed.sink.ok, true);
  assert.equal(fs.existsSync(path.join(tmp, "callback.json")), true);
  const callback = JSON.parse(fs.readFileSync(path.join(tmp, "callback.json"), "utf8"));
  assert.equal(callback.schemaVersion, "refinery.review.v1");
  assert.equal(callback.command, "review");
  assert.equal(callback.proposals.length, 1);
  assert.equal(callback.proposals[0].lifecycle, "proposed");
});

test("refinery review live mode accepts an injected model caller and writes live artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-live-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const modelPath = path.join(tmp, "model.mjs");
  fs.writeFileSync(
    modelPath,
    `
const responses = {
  "capture": {"candidates":[{"claim":"Agents should call Refinery through a CLI-first surface.","source_refs":[{"source_id":"source:session-a"}],"why_future_useful":"Keeps integrations agent-callable."}]},
  "distillation": {"distilled":[{"body":"Agents should call Refinery through a CLI-first surface.","source_refs":[{"source_id":"source:session-a"}],"rationale":"Captures the product surface."}]},
  "schema": {"typed":[{"body":"Agents should call Refinery through a CLI-first surface.","memory_type":"procedural","primary_type":"procedural","secondary_type":null,"type_confidence":0.86,"type_rationale":"It describes an integration workflow.","ambiguities":[],"durability":"durable","ttl":null,"proposed_scope":"project","action":"create","target_memory_id":null,"source_refs":[{"source_id":"source:session-a"}]}]},
  "relevance": {"proposals":[{"memory_type":"procedural","proposed_scope":"project","body":"Agents should call Refinery through a CLI-first surface.","confidence":0.82,"rationale":"Useful for future integrators.","source_refs":[{"source_id":"source:session-a"}],"action":"create","target_memory_id":null}],"rejected":[]},
  "relationship-review": {"findings":[{"body":"Agents should call Refinery through a CLI-first surface.","relation":"novel","target_memory_id":null,"confidence":0.77,"rationale":"No overlapping active memory.","source_refs":[{"source_id":"source:session-a"}],"memory_refs":[]}]}
};
export async function callModel({ specialist }) {
  return JSON.stringify(responses[specialist.name]);
}
`,
  );

  const result = runCli(
    [
      "review",
      "--runtime",
      "sequential",
      "--mode",
      "live",
      "--adapter",
      adapterPath,
      "--scope",
      "project",
      "--run-id",
      "live-cli-test",
      "--output-dir",
      path.join(tmp, "runs"),
      "--model-caller",
      modelPath,
      "--json",
    ],
    {
      OPENROUTER_API_KEY: "test-key",
      REFINERY_MODEL_NAME: "deepseek/deepseek-v4-pro",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.schemaVersion, "refinery.review.v1");
  assert.equal(parsed.mode, "live");
  assert.equal(parsed.model.modelName, "deepseek/deepseek-v4-pro");
  assert.equal("apiKey" in parsed.model, false);
  assert.equal(parsed.proposals[0].lifecycle, "proposed");
  assert.equal(parsed.metadata.sourceLimit, 3);
  assert.deepEqual(parsed.metadata.specialistOrder, [
    "capture",
    "distillation",
    "schema",
    "relevance",
    "relationship-review",
  ]);
  assert.equal(parsed.counts.proposals, 1);
  assert.equal(
    fs.existsSync(path.join(tmp, "runs", "live-cli-test", "steps", "relationship-review", "output.raw.md")),
    true,
  );
});

test("refinery module check validates a descriptor without loading module code", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-module-check-"));
  const descriptorPath = makeModuleDescriptor(tmp);

  const result = runCli(["module", "check", "--descriptor", descriptorPath, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.command, "module check");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.valid, true);
  assert.equal((parsed.descriptor as { kind: string }).kind, "runtime");
});

test("refinery module check emits structured errors for invalid descriptors", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-module-invalid-"));
  const descriptorPath = makeModuleDescriptor(tmp, { kind: "coral", capabilities: ["review.live", 1] });

  const result = runCli(["module", "check", "--descriptor", descriptorPath, "--json"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.command, "module check");
  assert.equal(parsed.ok, false);
  assert.equal((parsed.error as { code: string }).code, "MODULE_DESCRIPTOR_INVALID");
  assert.match(JSON.stringify(parsed.error), /capabilities\[1\]/);
});

test("downstream module compatibility fixture parses CLI contracts without prose scraping", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-compat-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const sinkPath = path.join(tmp, "compat-sink.mjs");
  const callbackPath = path.join(tmp, "compat-callback.json");
  fs.writeFileSync(sinkPath, `export default { url: "file://${callbackPath}" };`);
  const runDir = path.join(tmp, "runs", "compat-success");

  const review = runBin([
    "review",
    "--runtime",
    "sequential",
    "--adapter",
    adapterPath,
    "--scope",
    "project",
    "--run-id",
    "compat-success",
    "--output-dir",
    path.join(tmp, "runs"),
    "--sink",
    sinkPath,
    "--json",
  ]);

  assert.equal(review.status, 0, review.stderr);
  const reviewJson = parseJsonOutput(review);
  assert.equal(reviewJson.ok, true);
  assert.equal((reviewJson.proposals as Array<{ lifecycle: string }>)[0].lifecycle, "proposed");
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.artifacts.proposals, "proposals.json");
  assert.equal(manifest.artifacts.sink, "sink.json");
  const callback = JSON.parse(fs.readFileSync(callbackPath, "utf8"));
  assert.equal(callback.proposals[0].lifecycle, "proposed");

  const inspect = runBin(["trial", "inspect", "--run-dir", runDir, "--json"]);
  assert.equal(inspect.status, 0, inspect.stderr);
  const inspected = parseJsonOutput(inspect);
  assert.equal(inspected.status, "succeeded");
  assert.deepEqual(inspected.lifecycleDistribution, { proposed: 1 });

  const failedModelPath = path.join(tmp, "bad-model.mjs");
  fs.writeFileSync(failedModelPath, `export async function callModel() { return "{}"; }`);
  const failed = runBin(
    [
      "review",
      "--runtime",
      "sequential",
      "--mode",
      "live",
      "--adapter",
      adapterPath,
      "--scope",
      "project",
      "--run-id",
      "compat-failed",
      "--output-dir",
      path.join(tmp, "runs"),
      "--model-caller",
      failedModelPath,
      "--json",
    ],
    {
      OPENROUTER_API_KEY: "test-key",
      REFINERY_MODEL_NAME: "deepseek/deepseek-v4-pro",
    },
  );
  assert.equal(failed.status, 1);
  const failedJson = parseJsonOutput(failed);
  assert.equal((failedJson.error as { code: string }).code, "MODEL_OUTPUT_INVALID");
  const failedManifest = JSON.parse(fs.readFileSync(path.join(tmp, "runs", "compat-failed", "manifest.json"), "utf8"));
  assert.equal(failedManifest.status, "failed");
  assert.equal(failedManifest.artifacts.status, "status.json");
});

test("package bin target is executable and supports help output", () => {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    bin: { refinery: string };
  };
  assert.equal(packageJson.bin.refinery, "src/cli.ts");
  const binPath = path.resolve(path.dirname(packagePath), packageJson.bin.refinery);
  assert.notEqual(fs.statSync(binPath).mode & 0o111, 0);

  const result = runBin(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent-callable memory review CLI/);
});

test("package bin supports adapter check", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-bin-adapter-check-"));
  const adapterPath = makeFixtureAdapter(tmp);

  const result = runBin(["adapter", "check", "--adapter", adapterPath, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "adapter check");
  assert.equal(parsed.adapter.name, "fixture-memory");
});

test("refinery review writes to REFINERY_HOME trials by default", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-default-trials-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const home = path.join(tmp, "instance");

  const result = runCli(
    [
      "review",
      "--runtime",
      "sequential",
      "--adapter",
      adapterPath,
      "--scope",
      "project",
      "--run-id",
      "trial-test",
      "--json",
    ],
    { REFINERY_HOME: home },
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.runDir, path.join(home, "trials", "trial-test"));
  assert.equal(fs.existsSync(path.join(home, "trials", "trial-test", "review.json")), true);
});

test("refinery instance init imports db and raw evidence into a fresh trials workspace", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-instance-"));
  const source = path.join(tmp, "source.refinery");
  const home = path.join(tmp, ".refinery");
  fs.mkdirSync(path.join(source, "raw"), { recursive: true });
  fs.mkdirSync(path.join(source, "experiments", "old-run"), { recursive: true });
  fs.mkdirSync(path.join(source, "trials", "old-trial"), { recursive: true });
  fs.writeFileSync(path.join(source, "refinery.db"), "db");
  fs.writeFileSync(path.join(source, "raw", "abc123"), "raw evidence");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "dirty.txt"), "previous throwaway data");

  const result = runCli([
    "instance",
    "init",
    "--home",
    home,
    "--from",
    source,
    "--reset",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.command, "instance init");
  assert.equal(parsed.home, home);
  assert.equal(parsed.importedFrom, source);
  assert.equal(parsed.copied.db, true);
  assert.equal(parsed.copied.rawFiles, 1);
  assert.equal(parsed.trialsFresh, true);
  assert.match(parsed.archivedExistingHome, /\.refinery\.archive-/);
  assert.equal(fs.readFileSync(path.join(home, "refinery.db"), "utf8"), "db");
  assert.equal(fs.readFileSync(path.join(home, "raw", "abc123"), "utf8"), "raw evidence");
  assert.equal(fs.existsSync(path.join(home, "trials")), true);
  assert.equal(fs.readdirSync(path.join(home, "trials")).length, 0);
  assert.equal(fs.existsSync(path.join(home, "experiments")), false);
});

test("refinery instance init refuses a missing source before archiving existing data", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-instance-missing-source-"));
  const home = path.join(tmp, ".refinery");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "keep.txt"), "do not move");

  const result = runCli([
    "instance",
    "init",
    "--home",
    home,
    "--from",
    path.join(tmp, "missing.refinery"),
    "--reset",
    "--json",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result);
  assert.equal(parsed.ok, false);
  assert.match((parsed.error as { message: string }).message, /Source Refinery home not found/);
  assert.equal(fs.readFileSync(path.join(home, "keep.txt"), "utf8"), "do not move");
  assert.equal(
    fs.readdirSync(tmp).some((entry) => entry.includes(".refinery.archive-")),
    false,
  );
});
