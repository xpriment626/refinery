import crypto from "node:crypto";
import path from "node:path";
import {
  memoryGraphEdgeKinds,
  type GraphEdgeKind,
  type MemoryGraphEdge,
  type MemoryGraphIndex,
  type MemoryGraphNode,
  type MemoryGraphRevision,
} from "./sync.ts";

export const responsibilityPlanSchemaVersion = "refinery.responsibility-plan.v1" as const;

export interface ResponsibilityPlanLimits {
  maxNodes: number;
  maxEdges: number;
  maxHops: number;
  maxChars: number;
  maxTokens: number;
  edgeKinds: GraphEdgeKind[];
  minConfidence: number;
  maxAgeDays: number | null;
}

export interface ResponsibilitySeed {
  nodeId: string;
  score: number;
  reasons: string[];
}

export interface ResponsibilitySelectedNode {
  nodeId: string;
  revisionId: string;
  kind: MemoryGraphNode["kind"];
  depth: number;
  seed: boolean;
  viaEdgeId: string | null;
  selectedText: string;
  selectedChars: number;
  estimatedTokens: number;
  responsibilityUnitId: string;
}

export type ResponsibilityExclusionReason =
  | "scope-mismatch"
  | "freshness-limit"
  | "node-budget"
  | "edge-budget"
  | "hop-limit"
  | "character-budget"
  | "token-budget"
  | "edge-kind-filter"
  | "confidence-filter"
  | "missing-revision";

export interface ResponsibilityExclusion {
  nodeId: string | null;
  edgeId: string | null;
  reason: ResponsibilityExclusionReason;
  details: Record<string, unknown>;
}

export interface ResponsibilityUnit {
  id: string;
  kind: "memory" | "source-cluster" | "session" | "skill" | "resource";
  label: string;
  nodeIds: string[];
  state: "awake" | "sleeping" | "deferred";
  minimumDepth: number;
  expansionNodeIds: string[];
}

export interface ResponsibilityRuntimeProjection {
  adapter: "refinery-static-specialists-v1";
  dynamicAgents: false;
  awakeUnitIds: string[];
  sleepingUnitIds: string[];
  deferredUnitIds: string[];
  nextSeam: "sleeping-unit-first-wake-expansion";
}

export interface ResponsibilityPlan {
  schemaVersion: typeof responsibilityPlanSchemaVersion;
  id: string;
  generatedAt: string;
  index: {
    schemaVersion: MemoryGraphIndex["schemaVersion"];
    indexerVersion: MemoryGraphIndex["indexerVersion"];
    syncedAt: string;
    project: string;
  };
  objective: {
    request: string | null;
    project: string;
    scope: string;
    explicitNodeIds: string[];
    changedNodeIds: string[];
  };
  limits: ResponsibilityPlanLimits;
  seeds: ResponsibilitySeed[];
  selectedNodes: ResponsibilitySelectedNode[];
  traversedEdges: MemoryGraphEdge[];
  responsibilityUnits: ResponsibilityUnit[];
  awakeSeeds: string[];
  sleepingOneHop: string[];
  exclusions: ResponsibilityExclusion[];
  budgetExhaustion: {
    nodes: boolean;
    edges: boolean;
    hops: boolean;
    chars: boolean;
    tokens: boolean;
  };
  warnings: string[];
  runtimeProjection: ResponsibilityRuntimeProjection;
}

const DEFAULT_LIMITS: ResponsibilityPlanLimits = {
  maxNodes: 24,
  maxEdges: 48,
  maxHops: 2,
  maxChars: 12_000,
  maxTokens: 3_000,
  edgeKinds: [...memoryGraphEdgeKinds],
  minConfidence: 0,
  maxAgeDays: null,
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "was", "were", "with",
]);

function stableHash(parts: string[]): string {
  const hash = crypto.createHash("sha256");
  parts.forEach((part) => hash.update(part).update("\0"));
  return hash.digest("hex");
}

function normalizedLimits(input: Partial<ResponsibilityPlanLimits> | undefined): ResponsibilityPlanLimits {
  const edgeKinds = input?.edgeKinds
    ? [...new Set(input.edgeKinds.filter((kind): kind is GraphEdgeKind => memoryGraphEdgeKinds.includes(kind)))]
    : [...DEFAULT_LIMITS.edgeKinds];
  return {
    maxNodes: Math.max(1, Math.floor(input?.maxNodes ?? DEFAULT_LIMITS.maxNodes)),
    maxEdges: Math.max(0, Math.floor(input?.maxEdges ?? DEFAULT_LIMITS.maxEdges)),
    maxHops: Math.max(0, Math.floor(input?.maxHops ?? DEFAULT_LIMITS.maxHops)),
    maxChars: Math.max(1, Math.floor(input?.maxChars ?? DEFAULT_LIMITS.maxChars)),
    maxTokens: Math.max(1, Math.floor(input?.maxTokens ?? DEFAULT_LIMITS.maxTokens)),
    edgeKinds: edgeKinds.sort(),
    minConfidence: Math.max(0, Math.min(1, input?.minConfidence ?? DEFAULT_LIMITS.minConfidence)),
    maxAgeDays: input?.maxAgeDays === null || input?.maxAgeDays === undefined
      ? DEFAULT_LIMITS.maxAgeDays
      : Math.max(0, input.maxAgeDays),
  };
}

function requestTokens(request: string | null): string[] {
  if (!request) return [];
  return [...new Set(
    request.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.filter((token) => token.length >= 2 && !STOP_WORDS.has(token)) ?? [],
  )].sort();
}

function eligibleForScope(node: MemoryGraphNode, project: string, scope: string): boolean {
  if (scope === "global") return node.scope === "global";
  if (node.scope === "global") return true;
  return node.project === project;
}

function revisionMap(index: MemoryGraphIndex): Map<string, MemoryGraphRevision> {
  return new Map(index.revisions.map((revision) => [revision.id, revision]));
}

function isFresh(revision: MemoryGraphRevision, limits: ResponsibilityPlanLimits, now: Date): boolean {
  if (limits.maxAgeDays === null) return true;
  const timestamp = revision.sourceModifiedAt ?? revision.indexedAt;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return true;
  return time >= now.getTime() - limits.maxAgeDays * 24 * 60 * 60 * 1000;
}

function lexicalScore(node: MemoryGraphNode, revision: MemoryGraphRevision, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const label = node.label.toLowerCase();
  const content = revision.content.toLowerCase();
  const metadata = JSON.stringify(node.metadata).toLowerCase();
  return tokens.reduce((score, token) => {
    const labelMatch = label.includes(token) ? 6 : 0;
    const contentMatch = content.includes(token) ? 2 : 0;
    const metadataMatch = metadata.includes(token) ? 1 : 0;
    return score + labelMatch + contentMatch + metadataMatch;
  }, 0);
}

function sourceClusterKey(node: MemoryGraphNode): string | null {
  const sourcePath = typeof node.metadata.sourcePath === "string" ? node.metadata.sourcePath : null;
  return sourcePath ? `source:${sourcePath}` : null;
}

function unitIdentity(node: MemoryGraphNode, isSeed: boolean): {
  key: string;
  kind: ResponsibilityUnit["kind"];
  label: string;
} | null {
  if (node.kind === "project") return null;
  if (node.kind === "memory" && isSeed) return { key: node.id, kind: "memory", label: node.label };
  const cluster = sourceClusterKey(node);
  if (cluster && (node.kind === "memory" || node.kind === "evidence" || node.kind === "source_document")) {
    return { key: cluster, kind: "source-cluster", label: cluster.slice("source:".length) };
  }
  if (node.kind === "memory") return { key: node.id, kind: "memory", label: node.label };
  if (node.kind === "session") return { key: node.id, kind: "session", label: node.label };
  if (node.kind === "skill") return { key: node.id, kind: "skill", label: node.label };
  return { key: node.id, kind: "resource", label: node.label };
}

function buildUnits(
  selected: Array<Omit<ResponsibilitySelectedNode, "responsibilityUnitId">>,
  nodes: Map<string, MemoryGraphNode>,
): { selectedNodes: ResponsibilitySelectedNode[]; units: ResponsibilityUnit[] } {
  const unitEntries = new Map<string, {
    id: string;
    kind: ResponsibilityUnit["kind"];
    label: string;
    selected: Array<Omit<ResponsibilitySelectedNode, "responsibilityUnitId">>;
  }>();
  const unitByNode = new Map<string, string>();
  for (const candidate of selected) {
    const node = nodes.get(candidate.nodeId);
    if (!node) continue;
    const identity = unitIdentity(node, candidate.seed);
    if (!identity) continue;
    const id = `responsibility-unit:${stableHash([identity.kind, identity.key]).slice(0, 20)}`;
    const entry = unitEntries.get(id) ?? { id, kind: identity.kind, label: identity.label, selected: [] };
    entry.selected.push(candidate);
    unitEntries.set(id, entry);
    unitByNode.set(candidate.nodeId, id);
  }
  const units = [...unitEntries.values()].map((entry): ResponsibilityUnit => {
    const minimumDepth = Math.min(...entry.selected.map((candidate) => candidate.depth));
    const state = entry.selected.some((candidate) => candidate.seed)
      ? "awake"
      : minimumDepth === 1
        ? "sleeping"
        : "deferred";
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      nodeIds: entry.selected.map((candidate) => candidate.nodeId).sort(),
      state,
      minimumDepth,
      expansionNodeIds: entry.selected.filter((candidate) => candidate.depth === minimumDepth).map((candidate) => candidate.nodeId).sort(),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return {
    selectedNodes: selected.map((candidate) => ({
      ...candidate,
      responsibilityUnitId: unitByNode.get(candidate.nodeId) ?? "",
    })),
    units,
  };
}

function addExclusion(
  exclusions: ResponsibilityExclusion[],
  exclusion: ResponsibilityExclusion,
): void {
  const key = `${exclusion.nodeId ?? ""}\0${exclusion.edgeId ?? ""}\0${exclusion.reason}`;
  if (!exclusions.some((candidate) => `${candidate.nodeId ?? ""}\0${candidate.edgeId ?? ""}\0${candidate.reason}` === key)) {
    exclusions.push(exclusion);
  }
}

export function createResponsibilityPlan(args: {
  index: MemoryGraphIndex;
  request?: string | null;
  project: string;
  scope: string;
  explicitNodeIds?: string[];
  changedNodeIds?: string[];
  limits?: Partial<ResponsibilityPlanLimits>;
  now?: Date;
}): ResponsibilityPlan {
  const project = path.resolve(args.project);
  const request = args.request?.trim() || null;
  const explicitNodeIds = [...new Set(args.explicitNodeIds ?? [])].sort();
  const changedNodeIds = [...new Set(args.changedNodeIds ?? [])].sort();
  const limits = normalizedLimits(args.limits);
  const now = args.now ?? new Date();
  const generatedAt = now.toISOString();
  const nodes = new Map(args.index.nodes.map((node) => [node.id, node]));
  const revisions = revisionMap(args.index);
  const nodeByIdentifier = new Map<string, MemoryGraphNode>();
  args.index.nodes.forEach((node) => {
    nodeByIdentifier.set(node.id, node);
    nodeByIdentifier.set(node.sourceKey, node);
  });
  const exclusions: ResponsibilityExclusion[] = [];
  const warnings: string[] = [];
  const tokens = requestTokens(request);
  const explicitNodes = explicitNodeIds.map((identifier) => nodeByIdentifier.get(identifier)).filter((node): node is MemoryGraphNode => Boolean(node));
  for (const identifier of explicitNodeIds) {
    const node = nodeByIdentifier.get(identifier);
    if (!node) {
      warnings.push(`Explicit graph node was not found: ${identifier}`);
    } else if (!eligibleForScope(node, project, args.scope)) {
      addExclusion(exclusions, {
        nodeId: node.id,
        edgeId: null,
        reason: "scope-mismatch",
        details: { nodeProject: node.project, nodeScope: node.scope, requestedProject: project, requestedScope: args.scope },
      });
    } else if (node) {
      const revision = revisions.get(node.currentRevisionId);
      if (!revision) {
        addExclusion(exclusions, {
          nodeId: node.id,
          edgeId: null,
          reason: "missing-revision",
          details: { revisionId: node.currentRevisionId },
        });
      } else if (!isFresh(revision, limits, now)) {
        addExclusion(exclusions, {
          nodeId: node.id,
          edgeId: null,
          reason: "freshness-limit",
          details: { maxAgeDays: limits.maxAgeDays, sourceModifiedAt: revision.sourceModifiedAt },
        });
      }
    }
  }

  const seedCandidates = args.index.nodes
    .filter((node) => node.kind !== "project" && (
      node.kind === "memory"
      || node.kind === "session"
      || node.kind === "skill"
      || explicitNodes.some((candidate) => candidate.id === node.id)
    ))
    .filter((node) => eligibleForScope(node, project, args.scope))
    .map((node) => {
      const revision = revisions.get(node.currentRevisionId);
      if (!revision || !isFresh(revision, limits, now)) return null;
      const explicit = explicitNodes.some((candidate) => candidate.id === node.id);
      const changed = changedNodeIds.includes(node.id);
      const lexical = lexicalScore(node, revision, tokens);
      const changedSeed = changed && (tokens.length === 0 || lexical > 0);
      const score = lexical * 100 + (explicit ? 10_000 : 0) + (changedSeed ? 20 : 0);
      const reasons = [
        ...(explicit ? ["explicit-id"] : []),
        ...(changedSeed ? ["changed-source"] : []),
        ...(lexical > 0 ? ["lexical-match"] : []),
      ];
      return score > 0 ? { node, revision, score, reasons } : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));

  if (seedCandidates.length === 0) {
    const fallback = args.index.nodes
      .filter((node) => node.kind === "memory" || node.kind === "session" || node.kind === "skill" || node.kind === "source_document")
      .filter((node) => eligibleForScope(node, project, args.scope))
      .map((node) => ({ node, revision: revisions.get(node.currentRevisionId) }))
      .filter((candidate): candidate is { node: MemoryGraphNode; revision: MemoryGraphRevision } => Boolean(candidate.revision))
      .filter((candidate) => isFresh(candidate.revision, limits, now))
      .sort((left, right) => left.node.id.localeCompare(right.node.id))[0];
    if (fallback) {
      seedCandidates.push({ node: fallback.node, revision: fallback.revision, score: 1, reasons: ["deterministic-fallback"] });
      warnings.push("No explicit, changed, or lexical seed matched; selected one deterministic in-scope fallback.");
    }
  }

  const seeds: ResponsibilitySeed[] = seedCandidates
    .slice(0, Math.min(5, limits.maxNodes))
    .map((candidate) => ({ nodeId: candidate.node.id, score: candidate.score, reasons: candidate.reasons }));
  const selected: Array<Omit<ResponsibilitySelectedNode, "responsibilityUnitId">> = [];
  const selectedIds = new Set<string>();
  const traversedEdges: MemoryGraphEdge[] = [];
  const traversedEdgeIds = new Set<string>();
  const budgetExhaustion = { nodes: false, edges: false, hops: false, chars: false, tokens: false };
  let usedChars = 0;
  let usedTokens = 0;

  const selectNode = (node: MemoryGraphNode, depth: number, seed: boolean, viaEdgeId: string | null): boolean => {
    if (selectedIds.has(node.id)) return true;
    if (selected.length >= limits.maxNodes) {
      budgetExhaustion.nodes = true;
      addExclusion(exclusions, { nodeId: node.id, edgeId: viaEdgeId, reason: "node-budget", details: { maxNodes: limits.maxNodes } });
      return false;
    }
    if (!eligibleForScope(node, project, args.scope)) {
      addExclusion(exclusions, { nodeId: node.id, edgeId: viaEdgeId, reason: "scope-mismatch", details: { nodeProject: node.project, nodeScope: node.scope } });
      return false;
    }
    const revision = revisions.get(node.currentRevisionId);
    if (!revision) {
      addExclusion(exclusions, { nodeId: node.id, edgeId: viaEdgeId, reason: "missing-revision", details: { revisionId: node.currentRevisionId } });
      return false;
    }
    if (!isFresh(revision, limits, now)) {
      addExclusion(exclusions, { nodeId: node.id, edgeId: viaEdgeId, reason: "freshness-limit", details: { maxAgeDays: limits.maxAgeDays } });
      return false;
    }
    const remainingChars = limits.maxChars - usedChars;
    const remainingTokens = limits.maxTokens - usedTokens;
    if (remainingChars <= 0) {
      budgetExhaustion.chars = true;
      addExclusion(exclusions, { nodeId: node.id, edgeId: viaEdgeId, reason: "character-budget", details: { maxChars: limits.maxChars } });
      return false;
    }
    if (remainingTokens <= 0) {
      budgetExhaustion.tokens = true;
      addExclusion(exclusions, { nodeId: node.id, edgeId: viaEdgeId, reason: "token-budget", details: { maxTokens: limits.maxTokens } });
      return false;
    }
    const allowedChars = Math.min(remainingChars, remainingTokens * 4);
    const selectedText = revision.content.slice(0, allowedChars);
    const selectedChars = selectedText.length;
    const estimatedTokens = Math.max(1, Math.ceil(selectedChars / 4));
    if (selectedChars < revision.content.length) {
      if (allowedChars === remainingChars) budgetExhaustion.chars = true;
      if (allowedChars === remainingTokens * 4) budgetExhaustion.tokens = true;
    }
    selected.push({
      nodeId: node.id,
      revisionId: revision.id,
      kind: node.kind,
      depth,
      seed,
      viaEdgeId,
      selectedText,
      selectedChars,
      estimatedTokens,
    });
    selectedIds.add(node.id);
    usedChars += selectedChars;
    usedTokens += estimatedTokens;
    return true;
  };

  const queue: Array<{ nodeId: string; depth: number }> = [];
  for (const seed of seeds) {
    const node = nodes.get(seed.nodeId);
    if (node && selectNode(node, 0, true, null)) queue.push({ nodeId: node.id, depth: 0 });
  }
  const sortedEdges = [...args.index.edges].sort((left, right) => left.id.localeCompare(right.id));
  while (queue.length > 0) {
    const current = queue.shift()!;
    const adjacent = sortedEdges.filter((edge) => edge.sourceNodeId === current.nodeId || edge.targetNodeId === current.nodeId);
    for (const graphEdge of adjacent) {
      if (!limits.edgeKinds.includes(graphEdge.kind)) {
        addExclusion(exclusions, { nodeId: null, edgeId: graphEdge.id, reason: "edge-kind-filter", details: { kind: graphEdge.kind } });
        continue;
      }
      if (graphEdge.confidence < limits.minConfidence) {
        addExclusion(exclusions, { nodeId: null, edgeId: graphEdge.id, reason: "confidence-filter", details: { confidence: graphEdge.confidence, minConfidence: limits.minConfidence } });
        continue;
      }
      const nextDepth = current.depth + 1;
      const nextNodeId = graphEdge.sourceNodeId === current.nodeId ? graphEdge.targetNodeId : graphEdge.sourceNodeId;
      if (nextDepth > limits.maxHops) {
        budgetExhaustion.hops = true;
        addExclusion(exclusions, { nodeId: nextNodeId, edgeId: graphEdge.id, reason: "hop-limit", details: { maxHops: limits.maxHops } });
        continue;
      }
      const nextNode = nodes.get(nextNodeId);
      if (!nextNode) continue;
      if (!traversedEdgeIds.has(graphEdge.id)) {
        if (traversedEdges.length >= limits.maxEdges) {
          budgetExhaustion.edges = true;
          addExclusion(exclusions, { nodeId: nextNodeId, edgeId: graphEdge.id, reason: "edge-budget", details: { maxEdges: limits.maxEdges } });
          continue;
        }
      }
      if (selectNode(nextNode, nextDepth, false, graphEdge.id)) {
        if (!traversedEdgeIds.has(graphEdge.id)) {
          traversedEdges.push(graphEdge);
          traversedEdgeIds.add(graphEdge.id);
        }
      }
      if (selectedIds.has(nextNode.id) && !queue.some((queued) => queued.nodeId === nextNode.id)) {
        const selectedNode = selected.find((candidate) => candidate.nodeId === nextNode.id);
        if (selectedNode?.depth === nextDepth) queue.push({ nodeId: nextNode.id, depth: nextDepth });
      }
    }
  }

  const projected = buildUnits(selected, nodes);
  const awakeSeeds = projected.units.filter((unit) => unit.state === "awake").map((unit) => unit.id);
  const sleepingOneHop = projected.units.filter((unit) => unit.state === "sleeping").map((unit) => unit.id);
  const deferred = projected.units.filter((unit) => unit.state === "deferred").map((unit) => unit.id);
  const id = `responsibility-plan:${stableHash([
    args.index.schemaVersion,
    args.index.indexerVersion,
    args.index.syncedAt,
    project,
    args.scope,
    request ?? "",
    JSON.stringify(explicitNodeIds),
    JSON.stringify(changedNodeIds),
    JSON.stringify(limits),
  ]).slice(0, 24)}`;

  return {
    schemaVersion: responsibilityPlanSchemaVersion,
    id,
    generatedAt,
    index: {
      schemaVersion: args.index.schemaVersion,
      indexerVersion: args.index.indexerVersion,
      syncedAt: args.index.syncedAt,
      project: args.index.project,
    },
    objective: { request, project, scope: args.scope, explicitNodeIds, changedNodeIds },
    limits,
    seeds,
    selectedNodes: projected.selectedNodes.sort((left, right) => left.depth - right.depth || left.nodeId.localeCompare(right.nodeId)),
    traversedEdges: traversedEdges.sort((left, right) => left.id.localeCompare(right.id)),
    responsibilityUnits: projected.units,
    awakeSeeds,
    sleepingOneHop,
    exclusions: exclusions.sort((left, right) => {
      const leftKey = `${left.reason}\0${left.nodeId ?? ""}\0${left.edgeId ?? ""}`;
      const rightKey = `${right.reason}\0${right.nodeId ?? ""}\0${right.edgeId ?? ""}`;
      return leftKey.localeCompare(rightKey);
    }),
    budgetExhaustion,
    warnings,
    runtimeProjection: {
      adapter: "refinery-static-specialists-v1",
      dynamicAgents: false,
      awakeUnitIds: awakeSeeds,
      sleepingUnitIds: sleepingOneHop,
      deferredUnitIds: deferred,
      nextSeam: "sleeping-unit-first-wake-expansion",
    },
  };
}
