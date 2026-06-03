import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runDistillationExperiment,
  type DistillationOutput,
} from "./experiments/distillation.ts";
import { runSchemaExperiment, type SchemaOutput } from "./experiments/schema.ts";
import { runRelevanceExperiment } from "./experiments/relevance.ts";
import type { ExperimentPaths } from "./experiments/capture.ts";

function makePaths(): ExperimentPaths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-specialist-"));
  return {
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
  };
}

const model = {
  provider: "openrouter",
  baseUrl: "https://openrouter.invalid/api/v1",
  modelName: "deepseek/deepseek-v4-pro",
  apiKey: "test-key",
};

test("runDistillationExperiment writes artifacts and validates distilled output", async () => {
  const paths = makePaths();
  const result = await runDistillationExperiment(paths, {
    runId: "distillation-test",
    model,
    callModel: async () =>
      JSON.stringify({
        distilled: [
          {
            body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
            source_refs: [{ source_id: 1, chunk_index: 4 }],
            rationale: "Makes the testing target durable and self-contained.",
          },
        ],
      } satisfies DistillationOutput),
  });

  assert.equal(result.parsed.distilled.length, 1);
  assert.equal(fs.existsSync(path.join(result.runDir, "input.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "output.raw.md")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "output.parsed.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "eval.md")), true);
  assert.doesNotMatch(fs.readFileSync(path.join(result.runDir, "input.json"), "utf8"), /test-key/);
});

test("runSchemaExperiment writes artifacts and validates typed output", async () => {
  const paths = makePaths();
  const result = await runSchemaExperiment(paths, {
    runId: "schema-test",
    model,
    callModel: async () =>
      JSON.stringify({
        typed: [
          {
            body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
            memory_type: "procedural",
            proposed_scope: "project",
            mutation_op: "create",
            target_memory_id: null,
            source_refs: [{ source_id: 1, chunk_index: 4 }],
          },
        ],
      } satisfies SchemaOutput),
  });

  assert.equal(result.parsed.typed[0].memory_type, "procedural");
  assert.equal(result.parsed.typed[0].proposed_scope, "project");
  assert.equal(fs.existsSync(path.join(result.runDir, "output.parsed.json")), true);
});

test("runRelevanceExperiment writes artifacts and validates proposal-shaped output", async () => {
  const paths = makePaths();
  const result = await runRelevanceExperiment(paths, {
    runId: "relevance-test",
    model,
    callModel: async () =>
      JSON.stringify({
        proposals: [
          {
            memory_type: "procedural",
            proposed_scope: "project",
            body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
            confidence: 0.82,
            rationale: "Useful for future specialist testing and avoids refining only curated memories.",
            source_refs: [{ source_id: 1, chunk_index: 4 }],
            mutation_op: "create",
            target_memory_id: null,
          },
        ],
        rejected: [],
      }),
  });

  assert.equal(result.parsed.proposals.length, 1);
  assert.equal(result.parsed.proposals[0].mutation_op, "create");
  assert.equal(fs.existsSync(path.join(result.runDir, "eval.md")), true);
});
