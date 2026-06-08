import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import {
  runSequentialWorkflowExperiment,
  type ExperimentPaths,
} from "./experiments/workflow.ts";

function makePaths(): ExperimentPaths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-workflow-"));
  return {
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
  };
}

function seedSessionAndMemory(paths: ExperimentPaths): void {
  fs.mkdirSync(paths.rawDir, { recursive: true });
  const rawBlob = path.join(paths.rawDir, "session-a");
  const jsonl = [
    {
      type: "user",
      timestamp: "2026-06-03T00:00:00.000Z",
      sessionId: "session-a",
      message: { role: "user", content: "We decided memory refinement should run over session history first, not only pre-existing memories." },
    },
    {
      type: "assistant",
      timestamp: "2026-06-03T00:01:00.000Z",
      sessionId: "session-a",
      message: { role: "assistant", content: "Existing memories are comparison baselines while raw sessions remain source evidence." },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
  fs.writeFileSync(rawBlob, jsonl);

  const db = openDb(paths);
  db.prepare(
    `INSERT INTO project (id, root_path, encoded_path, created_at)
     VALUES (1, '/tmp/fabrick', '-tmp-fabrick', '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO source
       (id, project_id, kind, source_path, session_id, sha256, byte_size, source_mtime, raw_blob, imported_at)
     VALUES
       (1, 1, 'claude-code-session', '/tmp/fabrick-session.jsonl', 'session-a', 'session-a', ?, '2026-06-03T00:01:00.000Z', ?, '2026-06-03T00:02:00.000Z')`,
  ).run(Buffer.byteLength(jsonl), rawBlob);
  db.prepare(
    `INSERT INTO memory
       (id, project_id, type, scope, status, body, confidence, provenance_kind, source_id, source_path, created_at)
     VALUES
       (7, 1, 'procedural', 'project', 'active', 'Memory refinement should run over source session history before curated memories.', 0.91, 'refinery-proposal', NULL, NULL, '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.close();
}

test("runSequentialWorkflowExperiment chains specialists and writes nested step artifacts", async () => {
  const paths = makePaths();
  seedSessionAndMemory(paths);
  const responses = [
    {
      candidates: [
        {
          claim: "Memory refinement should run over source session history first; existing memories are comparison baselines.",
          source_refs: [{ source_id: 1, session_id: "session-a", chunk_index: 0 }],
          why_future_useful: "Keeps future refinement tests grounded in source evidence.",
        },
      ],
    },
    {
      distilled: [
        {
          body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
          source_refs: [{ source_id: 1, session_id: "session-a", chunk_index: 0 }],
          rationale: "Makes the source-priority rule self-contained.",
        },
      ],
    },
    {
      typed: [
        {
          body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
          memory_type: "procedural",
          primary_type: "procedural",
          secondary_type: null,
          type_confidence: 0.9,
          type_rationale: "It describes how refinement should usually be performed.",
          ambiguities: [],
          durability: "durable",
          ttl: null,
          proposed_scope: "project",
          mutation_op: "create",
          target_memory_id: null,
          source_refs: [{ source_id: 1, session_id: "session-a", chunk_index: 0 }],
        },
      ],
    },
    {
      proposals: [
        {
          memory_type: "procedural",
          proposed_scope: "project",
          body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
          confidence: 0.84,
          rationale: "Useful for future refinement testing.",
          source_refs: [{ source_id: 1, session_id: "session-a", chunk_index: 0 }],
          mutation_op: "create",
          target_memory_id: null,
        },
      ],
      rejected: [],
    },
    {
      findings: [
        {
          body: "Memory refinement should run over source session history; existing memories are comparison baselines.",
          relation: "refinement",
          target_memory_id: 7,
          confidence: 0.82,
          rationale: "The proposal adds the comparison-baseline detail to an existing procedural memory.",
          source_refs: [{ source_id: 1, session_id: "session-a", chunk_index: 0 }],
          memory_refs: [{ memory_id: 7, provenance_kind: "refinery-proposal" }],
        },
      ],
    },
  ];
  let calls = 0;

  const result = await runSequentialWorkflowExperiment(paths, {
    runId: "workflow-test",
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "test-key",
    },
    callModel: async () => JSON.stringify(responses[calls++]),
  });

  assert.equal(result.parsed.relationship_review.findings[0].relation, "refinement");
  assert.equal(calls, 5);
  assert.equal(fs.existsSync(path.join(result.runDir, "input.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "workflow.output.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "eval.md")), true);
  for (const step of ["capture", "distillation", "schema", "relevance", "relationship-review"]) {
    assert.equal(fs.existsSync(path.join(result.runDir, "steps", step, "output.raw.md")), true);
    assert.equal(fs.existsSync(path.join(result.runDir, "steps", step, "output.parsed.json")), true);
  }
  const input = fs.readFileSync(path.join(result.runDir, "input.json"), "utf8");
  assert.match(input, /"framework": "mastra-workflow"/);
  assert.doesNotMatch(input, /test-key/);
});
