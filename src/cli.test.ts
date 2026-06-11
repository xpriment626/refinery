import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve(import.meta.dirname, "cli.ts");

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

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
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
  assert.equal(parsed.adapter.name, "fixture-memory");
  assert.equal(parsed.valid, true);
  assert.equal(parsed.capabilities.listSourceEvidence, true);
  assert.equal(parsed.capabilities.searchSourceEvidence, true);
  assert.equal(parsed.capabilities.getSourceEvidence, true);
  assert.equal(parsed.capabilities.applyProposal, false);
});

test("refinery review emits proposal JSON and deterministic dry-run artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-review-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const runHome = path.join(tmp, "runs");

  const result = runCli([
    "review",
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
  assert.equal(parsed.command, "review");
  assert.equal(parsed.adapter.name, "fixture-memory");
  assert.equal(parsed.scope, "project");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.counts.sources, 1);
  assert.equal(parsed.counts.activeMemories, 1);
  assert.equal(parsed.counts.proposals, 1);
  assert.equal(parsed.proposals[0].action, "create");
  assert.equal(parsed.proposals[0].targetMemoryId, null);
  assert.match(parsed.proposals[0].body, /agent-callable CLIs/);

  const runDir = path.join(runHome, "run-test");
  for (const rel of [
    "input.json",
    "metadata.json",
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
  const schema = JSON.parse(fs.readFileSync(path.join(runDir, "steps/schema/output.parsed.json"), "utf8"));
  assert.equal(schema.typed[0].action, "create");
  assert.equal("mutation_op" in schema.typed[0], false);
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
  assert.equal(parsed.sink.ok, true);
  assert.equal(fs.existsSync(path.join(tmp, "callback.json")), true);
  const callback = JSON.parse(fs.readFileSync(path.join(tmp, "callback.json"), "utf8"));
  assert.equal(callback.command, "review");
  assert.equal(callback.proposals.length, 1);
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
  assert.equal(parsed.mode, "live");
  assert.equal(parsed.model.modelName, "deepseek/deepseek-v4-pro");
  assert.equal(parsed.counts.proposals, 1);
  assert.equal(
    fs.existsSync(path.join(tmp, "runs", "live-cli-test", "steps", "relationship-review", "output.raw.md")),
    true,
  );
});

test("refinery review writes to REFINERY_HOME trials by default", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-cli-default-trials-"));
  const adapterPath = makeFixtureAdapter(tmp);
  const home = path.join(tmp, "instance");

  const result = runCli(
    [
      "review",
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
  assert.match(result.stderr, /Source Refinery home not found/);
  assert.equal(fs.readFileSync(path.join(home, "keep.txt"), "utf8"), "do not move");
  assert.equal(
    fs.readdirSync(tmp).some((entry) => entry.includes(".refinery.archive-")),
    false,
  );
});
