import { RefineryError } from "../errors.ts";
import type { ReviewGraphContextNode, ReviewPacket } from "../types.ts";
import type { ResponsibilityPlan } from "./plan.ts";
import type { MemoryGraphIndex } from "./sync.ts";

function compactResponsibilityPlan(plan: ResponsibilityPlan): Record<string, unknown> {
  const exclusionCounts = plan.exclusions.reduce<Record<string, number>>((counts, exclusion) => {
    counts[exclusion.reason] = (counts[exclusion.reason] ?? 0) + 1;
    return counts;
  }, {});
  return {
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    generatedAt: plan.generatedAt,
    index: plan.index,
    objective: {
      request: plan.objective.request,
      project: plan.objective.project,
      scope: plan.objective.scope,
      explicitNodeIds: plan.objective.explicitNodeIds,
      changedNodeCount: plan.objective.changedNodeIds.length,
    },
    limits: plan.limits,
    seeds: plan.seeds,
    selectedNodes: plan.selectedNodes.map(({ selectedText: _selectedText, ...selected }) => selected),
    traversedEdges: plan.traversedEdges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      kind: edge.kind,
      confidence: edge.confidence,
      provenance: edge.provenance,
    })),
    responsibilityUnits: plan.responsibilityUnits,
    awakeSeeds: plan.awakeSeeds,
    sleepingOneHop: plan.sleepingOneHop,
    exclusionSummary: {
      count: plan.exclusions.length,
      byReason: exclusionCounts,
    },
    budgetExhaustion: plan.budgetExhaustion,
    warnings: plan.warnings,
    runtimeProjection: plan.runtimeProjection,
  };
}

function graphContext(index: MemoryGraphIndex, plan: ResponsibilityPlan): ReviewGraphContextNode[] {
  const nodes = new Map(index.nodes.map((node) => [node.id, node]));
  const revisions = new Map(index.revisions.map((revision) => [revision.id, revision]));
  return plan.selectedNodes.map((selected) => {
    const node = nodes.get(selected.nodeId);
    const revision = revisions.get(selected.revisionId);
    if (!node || !revision || node.currentRevisionId !== revision.id) {
      throw new RefineryError(
        "GRAPH_CONTEXT_INVALID",
        `Responsibility plan references unavailable node or revision: ${selected.nodeId} / ${selected.revisionId}`,
        { phase: "graph-context", details: { nodeId: selected.nodeId, revisionId: selected.revisionId } },
      );
    }
    return {
      nodeId: node.id,
      revisionId: revision.id,
      kind: node.kind,
      label: node.label,
      scope: node.scope,
      project: node.project,
      uri: node.uri,
      depth: selected.depth,
      seed: selected.seed,
      responsibilityUnitId: selected.responsibilityUnitId,
      selectedText: selected.selectedText,
      metadata: node.metadata,
    };
  });
}

function sourceChunks(context: ReviewGraphContextNode[], charLimit: number): unknown[] {
  let remaining = charLimit;
  const chunks: unknown[] = [];
  for (const node of context) {
    if (node.kind === "project" || remaining <= 0) continue;
    const text = node.selectedText.slice(0, remaining);
    if (!text) continue;
    remaining -= text.length;
    chunks.push({
      id: node.nodeId,
      sourceSet: "memory-responsibility-graph",
      role: `graph-${node.kind.replaceAll("_", "-")}`,
      uri: node.uri,
      text,
      refs: [{
        graph_node_id: node.nodeId,
        graph_revision_id: node.revisionId,
        responsibility_unit_id: node.responsibilityUnitId,
      }],
      metadata: {
        ...node.metadata,
        graphNodeId: node.nodeId,
        graphRevisionId: node.revisionId,
        responsibilityUnitId: node.responsibilityUnitId,
        traversalDepth: node.depth,
        seed: node.seed,
      },
    });
  }
  return chunks;
}

function activeMemoryHints(context: ReviewGraphContextNode[], limit: number): unknown[] {
  return context
    .filter((node) => node.kind === "memory")
    .slice(0, limit)
    .map((node) => ({
      id: typeof node.metadata.memoryId === "string" ? node.metadata.memoryId : node.nodeId,
      graphNodeId: node.nodeId,
      graphRevisionId: node.revisionId,
      type: typeof node.metadata.memoryType === "string" ? node.metadata.memoryType : "semantic",
      scope: node.scope,
      body: node.selectedText.slice(0, 360),
      provenance: {
        ...node.metadata,
        responsibilityUnitId: node.responsibilityUnitId,
        traversalDepth: node.depth,
        seed: node.seed,
      },
    }));
}

export function attachResponsibilityContext(args: {
  packet: ReviewPacket;
  index: MemoryGraphIndex;
  plan: ResponsibilityPlan;
}): ReviewPacket {
  const context = graphContext(args.index, args.plan);
  const chunks = sourceChunks(context, args.packet.limits.sourceCharLimit);
  const memoryHints = activeMemoryHints(context, args.packet.limits.activeMemoryLimit);
  return {
    ...args.packet,
    graph: {
      schemaVersion: "refinery.review-graph-context.v1",
      plan: args.plan,
      context,
    },
    derivedViews: {
      source_chunks: chunks,
      active_memory_hints: memoryHints,
      responsibility_plan: compactResponsibilityPlan(args.plan),
      graph_context: context.map(({ selectedText: _selectedText, ...node }) => node),
    },
    counts: {
      ...args.packet.counts,
      activeMemoryHints: memoryHints.length,
      sourceChunks: chunks.length,
      graphNodes: context.length,
      responsibilityUnits: args.plan.responsibilityUnits.length,
    },
  };
}
