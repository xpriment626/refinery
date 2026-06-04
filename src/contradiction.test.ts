import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import {
  runContradictionExperiment,
  type ContradictionOutput,
  type ExperimentPaths,
} from "./experiments/contradiction.ts";

function makePaths(): ExperimentPaths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-contradiction-"));
  return {
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
  };
}

function seedActiveMemory(paths: ExperimentPaths): void {
  const db = openDb(paths);
  db.prepare(
    `INSERT INTO project (id, root_path, encoded_path, created_at)
     VALUES (1, '/tmp/fabrick', '-tmp-fabrick', '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO memory
       (id, project_id, type, scope, status, body, confidence, provenance_kind, source_id, source_path, created_at)
     VALUES
       (7, 1, 'procedural', 'project', 'active', 'Memory refinement should run over source session history before curated memories.', 0.91, 'refinery-proposal', NULL, NULL, '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.close();
}

test("runContradictionExperiment compares proposals to active memory and writes artifacts", async () => {
  const paths = makePaths();
  seedActiveMemory(paths);

  const result = await runContradictionExperiment(paths, {
    runId: "contradiction-test",
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "test-key",
    },
    callModel: async () =>
      JSON.stringify({
        findings: [
          {
            body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
            relation: "refinement",
            target_memory_id: 7,
            confidence: 0.84,
            rationale: "The proposal narrows an existing procedural memory by adding the comparison-baseline detail.",
            source_refs: [{ source_id: 1, chunk_index: 4 }],
            memory_refs: [{ memory_id: 7, provenance_kind: "refinery-proposal" }],
          },
        ],
      } satisfies ContradictionOutput),
  });

  assert.equal(result.parsed.findings.length, 1);
  assert.equal(result.parsed.findings[0].relation, "refinement");
  assert.equal(result.parsed.findings[0].target_memory_id, 7);
  assert.equal(fs.existsSync(path.join(result.runDir, "input.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "output.raw.md")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "output.parsed.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "eval.md")), true);
  const input = fs.readFileSync(path.join(result.runDir, "input.json"), "utf8");
  assert.match(input, /"framework": "mastra"/);
  assert.match(input, /active_memory_candidates/);
  assert.doesNotMatch(input, /test-key/);
});
