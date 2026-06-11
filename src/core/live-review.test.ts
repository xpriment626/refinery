import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLiveReview } from "./live-review.ts";
import type { MemoryStoreAdapter } from "./adapter.ts";

function fixtureAdapter(): MemoryStoreAdapter {
  return {
    name: "fixture-memory",
    async listSourceEvidence() {
      return [
        {
          id: "source:1",
          kind: "session",
          path: "/tmp/session.jsonl",
          text: "The team decided Refinery proposals should go to a callback sink; host systems own mutation.",
          refs: [{ source_id: "source:1", chunk_index: 0 }],
        },
      ];
    },
    async searchSourceEvidence() {
      return this.listSourceEvidence({ scope: "project" });
    },
    async getSourceEvidence() {
      return null;
    },
    async listActiveMemories() {
      return [
        {
          id: "memory:1",
          type: "procedural",
          scope: "project",
          status: "active",
          body: "Host systems own final memory writes.",
          provenance: { kind: "fixture" },
        },
      ];
    },
    async searchActiveMemories() {
      return this.listActiveMemories({ scope: "project" });
    },
    async getActiveMemory() {
      return null;
    },
  };
}

test("runLiveReview calls each specialist once in order and writes trial artifacts", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-live-review-"));
  const calls: string[] = [];
  const responses = [
    {
      candidates: [
        {
          claim: "Refinery proposals should go to callback sinks while host systems own mutation.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          why_future_useful: "Keeps Refinery stateless and integration-owned.",
        },
      ],
    },
    {
      distilled: [
        {
          body: "Refinery emits memory-maintenance proposals to callback sinks; host systems own durable mutation.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          rationale: "Captures the product boundary.",
        },
      ],
    },
    {
      typed: [
        {
          body: "Refinery emits memory-maintenance proposals to callback sinks; host systems own durable mutation.",
          memory_type: "procedural",
          primary_type: "procedural",
          secondary_type: null,
          type_confidence: 0.87,
          type_rationale: "It describes the normal integration workflow.",
          ambiguities: [],
          durability: "durable",
          ttl: null,
          proposed_scope: "project",
          action: "create",
          target_memory_id: null,
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
        },
      ],
    },
    {
      proposals: [
        {
          memory_type: "procedural",
          proposed_scope: "project",
          body: "Refinery emits memory-maintenance proposals to callback sinks; host systems own durable mutation.",
          confidence: 0.84,
          rationale: "Useful for future integration work.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          action: "create",
          target_memory_id: null,
        },
      ],
      rejected: [],
    },
    {
      findings: [
        {
          body: "Refinery emits memory-maintenance proposals to callback sinks; host systems own durable mutation.",
          relation: "refinement",
          target_memory_id: 1,
          confidence: 0.71,
          rationale: "The proposal narrows the active memory boundary.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          memory_refs: ["memory:1"],
        },
      ],
    },
  ];

  const result = await runLiveReview({
    adapter: fixtureAdapter(),
    scope: "project",
    runId: "live-test",
    outputDir,
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "test-key",
    },
    callModel: async ({ specialist }) => {
      calls.push(specialist.name);
      return JSON.stringify(responses[calls.length - 1]);
    },
  });

  assert.deepEqual(calls, ["capture", "distillation", "schema", "relevance", "relationship-review"]);
  assert.equal(result.mode, "live");
  assert.equal(result.dryRun, true);
  assert.equal(result.model.modelName, "deepseek/deepseek-v4-pro");
  assert.equal(result.counts.proposals, 1);
  assert.equal(result.proposals[0].action, "create");
  assert.equal(result.proposals[0].memoryType, "procedural");
  assert.equal(result.relationshipReview.findings[0].relation, "refinement");
  assert.deepEqual(result.relationshipReview.findings[0].memory_refs, [
    { memory_id: "memory:1", provenance_kind: null },
  ]);
  assert.equal(result.model.apiKeyPresent, true);
  assert.equal("apiKey" in result.model, false);

  const runDir = path.join(outputDir, "live-test");
  for (const step of ["capture", "distillation", "schema", "relevance", "relationship-review"]) {
    assert.equal(fs.existsSync(path.join(runDir, "steps", step, "input.json")), true, step);
    assert.equal(fs.existsSync(path.join(runDir, "steps", step, "output.raw.md")), true, step);
    assert.equal(fs.existsSync(path.join(runDir, "steps", step, "output.parsed.json")), true, step);
  }
  assert.equal(fs.existsSync(path.join(runDir, "review.json")), true);
  assert.equal(fs.existsSync(path.join(runDir, "metadata.json")), true);
  const schema = JSON.parse(
    fs.readFileSync(path.join(runDir, "steps", "schema", "output.parsed.json"), "utf8"),
  );
  assert.equal(schema.typed[0].action, "create");
  assert.equal("mutation_op" in schema.typed[0], false);
  const relevance = JSON.parse(
    fs.readFileSync(path.join(runDir, "steps", "relevance", "output.parsed.json"), "utf8"),
  );
  assert.equal(relevance.proposals[0].action, "create");
  assert.equal("mutation_op" in relevance.proposals[0], false);
});

test("runLiveReview accepts legacy mutation_op but emits canonical action", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-live-review-legacy-op-"));
  const responses = [
    {
      candidates: [
        {
          claim: "Legacy mutation_op should normalize to canonical action.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          why_future_useful: "Protects existing experimental callers while stabilizing callbacks.",
        },
      ],
    },
    {
      distilled: [
        {
          body: "Legacy mutation_op should normalize to canonical action in Refinery callback payloads.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          rationale: "Captures compatibility boundary.",
        },
      ],
    },
    {
      typed: [
        {
          body: "Legacy mutation_op should normalize to canonical action in Refinery callback payloads.",
          memory_type: "procedural",
          primary_type: "procedural",
          secondary_type: null,
          type_confidence: 0.81,
          type_rationale: "It describes schema compatibility behavior.",
          ambiguities: [],
          durability: "durable",
          ttl: null,
          proposed_scope: "project",
          mutation_op: "supersede",
          target_memory_id: "memory:1",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
        },
      ],
    },
    {
      proposals: [
        {
          memory_type: "procedural",
          proposed_scope: "project",
          body: "Legacy mutation_op should normalize to canonical action in Refinery callback payloads.",
          confidence: 0.8,
          rationale: "Useful for stable integrator callbacks.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          mutation_op: "supersede",
          target_memory_id: "memory:1",
        },
      ],
      rejected: [],
    },
    {
      findings: [
        {
          body: "Legacy mutation_op should normalize to canonical action in Refinery callback payloads.",
          relation: "supersession",
          target_memory_id: "memory:1",
          confidence: 0.76,
          rationale: "Targets the existing memory.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          memory_refs: [{ memory_id: "memory:1", provenance_kind: "fixture" }],
        },
      ],
    },
  ];
  let calls = 0;

  const result = await runLiveReview({
    adapter: fixtureAdapter(),
    scope: "project",
    runId: "legacy-op-test",
    outputDir,
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "test-key",
    },
    callModel: async () => JSON.stringify(responses[calls++]),
  });

  assert.equal(result.proposals[0].action, "supersede");
  const runDir = path.join(outputDir, "legacy-op-test");
  const schema = JSON.parse(
    fs.readFileSync(path.join(runDir, "steps", "schema", "output.parsed.json"), "utf8"),
  );
  assert.equal(schema.typed[0].action, "supersede");
  assert.equal("mutation_op" in schema.typed[0], false);
  const relevance = JSON.parse(
    fs.readFileSync(path.join(runDir, "steps", "relevance", "output.parsed.json"), "utf8"),
  );
  assert.equal(relevance.proposals[0].action, "supersede");
  assert.equal("mutation_op" in relevance.proposals[0], false);
});

test("runLiveReview accepts the full memory maintenance action taxonomy", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-live-review-extended-action-"));
  const responses = [
    {
      candidates: [
        {
          claim: "A durable memory should be retagged when its type is wrong but content remains useful.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          why_future_useful: "Retagging is a maintenance operation distinct from rewriting body text.",
        },
      ],
    },
    {
      distilled: [
        {
          body: "Retag useful memories when their type is wrong but their content remains valid.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          rationale: "Captures an extended maintenance action.",
        },
      ],
    },
    {
      typed: [
        {
          body: "Retag useful memories when their type is wrong but their content remains valid.",
          memory_type: "procedural",
          primary_type: "procedural",
          secondary_type: null,
          type_confidence: 0.82,
          type_rationale: "It describes a memory maintenance procedure.",
          ambiguities: [],
          durability: "durable",
          ttl: null,
          proposed_scope: "project",
          action: "retag",
          target_memory_id: "memory:1",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
        },
      ],
    },
    {
      proposals: [
        {
          memory_type: "procedural",
          proposed_scope: "project",
          body: "Retag useful memories when their type is wrong but their content remains valid.",
          confidence: 0.8,
          rationale: "Useful for maintenance workflows.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          action: "retag",
          target_memory_id: "memory:1",
        },
      ],
      rejected: [],
    },
    {
      findings: [
        {
          body: "Retag useful memories when their type is wrong but their content remains valid.",
          relation: "refinement",
          target_memory_id: "memory:1",
          confidence: 0.74,
          rationale: "Targets an existing memory for metadata correction.",
          source_refs: [{ source_id: "source:1", chunk_index: 0 }],
          memory_refs: [{ memory_id: "memory:1", provenance_kind: "fixture" }],
        },
      ],
    },
  ];
  let calls = 0;

  const result = await runLiveReview({
    adapter: fixtureAdapter(),
    scope: "project",
    runId: "extended-action-test",
    outputDir,
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "test-key",
    },
    callModel: async () => JSON.stringify(responses[calls++]),
  });

  assert.equal(result.schemaVersion, "refinery.review.v1");
  assert.equal(result.proposals[0].action, "retag");
  assert.equal(result.proposals[0].schemaVersion, "refinery.review.v1");
  const relevance = JSON.parse(
    fs.readFileSync(path.join(outputDir, "extended-action-test", "steps", "relevance", "output.parsed.json"), "utf8"),
  );
  assert.equal(relevance.proposals[0].action, "retag");
  assert.equal("mutation_op" in relevance.proposals[0], false);
});
