import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReviewPacket } from "../types.ts";
import { createResponsibilityPlan } from "./plan.ts";
import { attachResponsibilityContext } from "./context.ts";
import { JsonGraphStore, syncMemoryGraph } from "./sync.ts";

test("graph-selected context is an additive canonical packet field and keeps prompt views bounded", () => {
  const project = "/tmp/refinery-context-project";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-context-"));
  const index = syncMemoryGraph({
    store: new JsonGraphStore(path.join(home, "graph.json")),
    project,
    sourceSpecs: ["test:memories"],
    items: [
      {
        sourceAdapter: "test",
        sourceKey: "memory:selected",
        kind: "memory",
        scope: "project",
        project,
        label: "Selected responsibility memory",
        content: "Selected responsibility memory with bounded evidence content.",
        uri: "memory://selected",
        metadata: { memoryId: "memory:selected", memoryType: "operational", sourcePath: "MEMORY.md", line: 2 },
      },
      {
        sourceAdapter: "test",
        sourceKey: "evidence:MEMORY.md:2",
        kind: "evidence",
        scope: "project",
        project,
        label: "MEMORY.md:2",
        content: "Supporting graph evidence that should be truncated by packet limits.",
        uri: "file:///tmp/memories/MEMORY.md#L2",
        metadata: { sourcePath: "MEMORY.md", line: 2 },
      },
    ],
    edges: [{
      sourceAdapter: "test",
      sourceKey: "memory:selected",
      targetAdapter: "test",
      targetKey: "evidence:MEMORY.md:2",
      kind: "DERIVED_FROM",
      confidence: 1,
      derivation: "line-reference",
    }],
    now: new Date("2026-07-11T00:00:00.000Z"),
  }).index;
  const memoryNode = index.nodes.find((node) => node.kind === "memory");
  assert.ok(memoryNode);
  const plan = createResponsibilityPlan({
    index,
    request: "selected responsibility memory",
    project,
    scope: "project",
    explicitNodeIds: [memoryNode.id],
    changedNodeIds: Array.from({ length: 200 }, (_, index) => `changed:${index}`),
    limits: { maxChars: 80, maxTokens: 20 },
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const packet: ReviewPacket = {
    schemaVersion: "refinery.review-packet.v1",
    type: "refinery-review-packet",
    sourceSets: [{
      id: "source-set:legacy",
      spec: { raw: "codex:memories", kind: "codex:memories", value: null, params: {} },
      label: "codex:memories",
      role: "codex-memories",
      metadata: {},
    }],
    documents: [{
      id: "legacy-document",
      sourceSet: "source-set:legacy",
      role: "codex-memory-index",
      uri: "file:///tmp/memories/MEMORY.md",
      text: "Legacy canonical packet document remains unchanged.",
      metadata: {},
    }],
    targets: ["codex:memories"],
    objective: { intent: "general-review", request: "selected responsibility memory", project, scope: "project" },
    limits: { sourceLimit: 3, sourceCharLimit: 40, documentCharLimit: 8_000, activeMemoryLimit: 50 },
    derivedViews: { source_chunks: [{ id: "legacy" }], active_memory_hints: [{ id: "legacy" }] },
    counts: { sourceSets: 1, documents: 1, activeMemoryHints: 1, sourceChunks: 1 },
    warnings: [],
  };

  const attached = attachResponsibilityContext({ packet, index, plan });

  assert.deepEqual(attached.documents, packet.documents);
  assert.equal(attached.graph?.plan.id, plan.id);
  assert.equal(attached.graph?.context.length, plan.selectedNodes.length);
  const chunks = attached.derivedViews.source_chunks as Array<{ text: string; metadata: Record<string, unknown> }>;
  assert.equal(chunks.reduce((total, chunk) => total + chunk.text.length, 0) <= packet.limits.sourceCharLimit, true);
  assert.equal(chunks.every((chunk) => typeof chunk.metadata.graphNodeId === "string"), true);
  const hints = attached.derivedViews.active_memory_hints as Array<{ id: string }>;
  assert.deepEqual(hints.map((hint) => hint.id), ["memory:selected"]);
  assert.equal(attached.derivedViews.responsibility_plan && typeof attached.derivedViews.responsibility_plan === "object", true);
  const compactPlan = attached.derivedViews.responsibility_plan as {
    objective: Record<string, unknown>;
    exclusionSummary: { count: number; byReason: Record<string, number> };
  };
  assert.equal(compactPlan.objective.changedNodeCount, 200);
  assert.equal("changedNodeIds" in compactPlan.objective, false);
  assert.equal("exclusions" in compactPlan, false);
  assert.equal(typeof compactPlan.exclusionSummary.count, "number");
  assert.equal(attached.counts.graphNodes, plan.selectedNodes.length);
});
