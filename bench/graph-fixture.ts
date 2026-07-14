import type {
  GraphEdgeKind,
  GraphNodeKind,
  MemoryGraphIndex,
} from "../src/core/graph/sync.ts";
import {
  memoryGraphIndexerVersion,
  memoryGraphSchemaVersion,
} from "../src/core/graph/sync.ts";

const nodeKinds: GraphNodeKind[] = [
  "memory",
  "memory",
  "memory",
  "session",
  "skill",
  "source_document",
  "evidence",
];

const edgeKinds: GraphEdgeKind[] = [
  "DERIVED_FROM",
  "OBSERVED_IN_SESSION",
  "APPLIES_TO_PROJECT",
  "SUPPORTS",
  "CONTRADICTS",
  "SUPERSEDES",
  "DUPLICATES",
  "SAME_TOPIC_AS",
  "REQUIRES_SKILL",
];

function padded(value: number): string {
  return value.toString().padStart(8, "0");
}

export function createDeterministicGraphFixture(options: {
  nodes: number;
  edges: number;
  project?: string;
}): MemoryGraphIndex {
  const nodeCount = Math.max(1, Math.floor(options.nodes));
  const edgeCount = Math.max(0, Math.floor(options.edges));
  const project = options.project ?? "/benchmark/refinery";
  const nodes: MemoryGraphIndex["nodes"] = [];
  const revisions: MemoryGraphIndex["revisions"] = [];

  for (let index = 0; index < nodeCount; index += 1) {
    const suffix = padded(index);
    const nodeId = `graph-node:fixture-${suffix}`;
    const revisionId = `graph-revision:fixture-${suffix}`;
    const topic = index % 251;
    const kind = nodeKinds[index % nodeKinds.length]!;
    const content = [
      `Responsibility graph benchmark memory ${suffix}.`,
      `Topic-${topic} records deterministic retrieval, provenance, revision, and agent responsibility behavior.`,
      `This fixture text approximates durable project memory while keeping generation reproducible across machines.`,
      `Related concepts include gateway observability, indexed traversal, bounded context, and evidence lineage.`,
    ].join(" ");
    nodes.push({
      id: nodeId,
      sourceAdapter: "benchmark",
      sourceKey: `memory:${suffix}`,
      kind,
      scope: index % 50 === 0 ? "global" : "project",
      project: index % 50 === 0 ? null : project,
      label: `Benchmark ${kind} ${suffix} topic-${topic}`,
      uri: `benchmark://memory/${suffix}`,
      currentRevisionId: revisionId,
      metadata: {
        sourcePath: `fixtures/topic-${topic}.md`,
        line: index + 1,
        responsibilityGroup: `group-${index % 97}`,
      },
    });
    revisions.push({
      id: revisionId,
      nodeId,
      contentHash: `fixture-content-${suffix}`,
      indexerVersion: memoryGraphIndexerVersion,
      content,
      charCount: content.length,
      indexedAt: "2026-07-11T00:00:00.000Z",
      sourceModifiedAt: `2026-07-${String((index % 10) + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }

  const edges: MemoryGraphIndex["edges"] = [];
  const offsets = [1, 7, 31, 127, 509, 1021, 4093];
  for (let index = 0; index < edgeCount; index += 1) {
    const sourceIndex = index % nodeCount;
    const lane = Math.floor(index / nodeCount);
    const offset = offsets[lane % offsets.length]! + Math.floor(lane / offsets.length) * 2;
    let targetIndex = (sourceIndex + offset) % nodeCount;
    if (targetIndex === sourceIndex) targetIndex = (targetIndex + 1) % nodeCount;
    const source = nodes[sourceIndex]!;
    const target = nodes[targetIndex]!;
    const edgeKind = edgeKinds[index % edgeKinds.length]!;
    edges.push({
      id: `graph-edge:fixture-${padded(index)}`,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      kind: edgeKind,
      sourceRevisionId: source.currentRevisionId,
      confidence: 0.5 + (index % 51) / 100,
      provenance: {
        derivation: "deterministic-benchmark-fixture",
        evidenceRefs: [{ sourcePath: source.metadata.sourcePath, line: sourceIndex + 1 }],
        metadata: { lane },
      },
    });
  }

  return {
    schemaVersion: memoryGraphSchemaVersion,
    indexerVersion: memoryGraphIndexerVersion,
    project,
    sourceSpecs: ["benchmark:deterministic"],
    syncedAt: "2026-07-11T00:00:00.000Z",
    nodes,
    revisions,
    edges,
  };
}

export function createDeterministicGraphMutation(
  base: MemoryGraphIndex,
  options: { updatedNodes: number; createdEdges: number },
): MemoryGraphIndex {
  const updatedNodes = Math.max(0, Math.min(base.nodes.length, Math.floor(options.updatedNodes)));
  const createdEdges = Math.max(0, Math.floor(options.createdEdges));
  const expanded = createDeterministicGraphFixture({
    nodes: base.nodes.length,
    edges: base.edges.length + createdEdges,
    project: base.project,
  });
  return {
    ...base,
    syncedAt: "2026-07-12T00:00:00.000Z",
    nodes: base.nodes.map((node, index) => index < updatedNodes
      ? { ...node, label: `${node.label} · mutation`, metadata: { ...node.metadata, benchmarkMutation: true } }
      : node),
    edges: expanded.edges,
  };
}
