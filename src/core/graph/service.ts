import path from "node:path";
import { buildCodexGraphSnapshot } from "../../sources/codex-graph.ts";
import { parseSourceSpecs, type SourceCorpus } from "../packets.ts";
import { readSourceCorpusIsolated } from "../source-reader.ts";
import { RefineryError } from "../errors.ts";
import { resolveRefineryPaths } from "../paths.ts";
import type { ReviewPacket, SourceSpec } from "../types.ts";
import { attachResponsibilityContext } from "./context.ts";
import { LibsqlGraphStore, type GraphNodeWithRevision } from "./libsql-store.ts";
import {
  createResponsibilityPlan,
  type ResponsibilityPlan,
  type ResponsibilityPlanLimits,
} from "./plan.ts";
import {
  memoryGraphEdgeKinds,
  memoryGraphIndexerVersion,
  memoryGraphSchemaVersion,
  syncMemoryGraph,
  type GraphSyncResult,
  type MemoryGraphEdge,
  type MemoryGraphIndex,
  type MemoryGraphNode,
  type MemoryGraphRevision,
  type GraphEdgeKind,
} from "./sync.ts";

const DEFAULT_GRAPH_SOURCE_LIMIT = 500;
const MAX_GRAPH_SOURCE_LIMIT = 5_000;
const GRAPH_DOCUMENT_CHAR_LIMIT = 1_000_000;
const GRAPH_ACTIVE_MEMORY_LIMIT = 50_000;

export interface SyncCodexMemoryGraphResult extends GraphSyncResult {
  graphPath: string;
  warnings: string[];
  canonicalSourcesMutated: false;
  sourceIsolation: { processSeparated: true; permissionModel: boolean };
}

function resolvedGraphPath(args: { project: string; graphPath?: string; home?: string }): string {
  if (args.graphPath) return path.resolve(args.graphPath);
  return resolveRefineryPaths({ cwd: path.resolve(args.project), home: args.home }).graphIndexPath;
}

function graphStore(args: { project: string; graphPath?: string; home?: string }): LibsqlGraphStore {
  const project = path.resolve(args.project);
  const paths = resolveRefineryPaths({ cwd: project, home: args.home });
  const graphPath = args.graphPath ? path.resolve(args.graphPath) : paths.graphIndexPath;
  return new LibsqlGraphStore(graphPath, {
    legacyJsonPath: args.graphPath ? undefined : paths.legacyGraphIndexPath,
  });
}

function readRequiredGraph(args: { store: LibsqlGraphStore; project: string }): MemoryGraphIndex {
  const store = args.store;
  const index = store.read();
  if (!index) {
    throw new RefineryError(
      "GRAPH_INDEX_NOT_FOUND",
      `Refinery graph index not found at ${store.location}. Run refinery graph sync first.`,
      { phase: "graph-read", details: { graphPath: store.location, next: "refinery graph sync --json" } },
    );
  }
  const project = path.resolve(args.project);
  if (index.project !== project) {
    throw new RefineryError(
      "GRAPH_PROJECT_MISMATCH",
      `Graph index belongs to ${index.project}, not ${project}.`,
      { phase: "graph-read", details: { graphPath: store.location, indexProject: index.project, requestedProject: project } },
    );
  }
  return index;
}

function assertGraphAvailable(store: LibsqlGraphStore, projectInput: string, phase: string): void {
  const metadata = store.readMetadata();
  const project = path.resolve(projectInput);
  if (!metadata) {
    throw new RefineryError(
      "GRAPH_INDEX_NOT_FOUND",
      `Refinery graph index not found at ${store.location}. Run refinery graph sync first.`,
      { phase, details: { graphPath: store.location, next: "refinery graph sync --json" } },
    );
  }
  if (metadata.project !== project) {
    throw new RefineryError(
      "GRAPH_PROJECT_MISMATCH",
      `Graph index belongs to ${metadata.project}, not ${project}.`,
      { phase, details: { graphPath: store.location, indexProject: metadata.project, requestedProject: project } },
    );
  }
}

function assertNodeInProjectScope(node: MemoryGraphNode, projectInput: string, phase: string): void {
  const project = path.resolve(projectInput);
  if (node.scope === "global" || node.project === project) return;
  throw new RefineryError(
    "GRAPH_NODE_OUT_OF_SCOPE",
    `Graph node ${node.id} is outside the requested project scope.`,
    {
      phase,
      details: {
        nodeId: node.id,
        nodeScope: node.scope,
        nodeProject: node.project,
        requestedProject: project,
      },
    },
  );
}

export async function syncCodexMemoryGraph(args: {
  project: string;
  sourceSpecs?: SourceSpec[];
  memoryHome?: string;
  graphPath?: string;
  home?: string;
  sourceLimit?: number;
  now?: Date;
}): Promise<SyncCodexMemoryGraphResult> {
  const project = path.resolve(args.project);
  const sourceSpecs = args.sourceSpecs ?? parseSourceSpecs(undefined);
  const sourceLimit = Math.max(1, Math.min(args.sourceLimit ?? DEFAULT_GRAPH_SOURCE_LIMIT, MAX_GRAPH_SOURCE_LIMIT));
  let corpus: SourceCorpus;
  let sourceIsolation: SyncCodexMemoryGraphResult["sourceIsolation"];
  try {
    const isolated = await readSourceCorpusIsolated({
      sourceSpecs,
      project,
      scope: "project",
      home: args.home,
      memoryHome: args.memoryHome,
      limits: {
        sourceLimit,
        sourceCharLimit: GRAPH_DOCUMENT_CHAR_LIMIT,
        documentCharLimit: GRAPH_DOCUMENT_CHAR_LIMIT,
        activeMemoryLimit: GRAPH_ACTIVE_MEMORY_LIMIT,
      },
      now: args.now,
    });
    corpus = isolated.corpus;
    sourceIsolation = {
      processSeparated: isolated.isolation.processSeparated,
      permissionModel: isolated.isolation.permissionModel,
    };
  } catch (error) {
    if (error instanceof RefineryError) throw error;
    throw new RefineryError(
      "GRAPH_SOURCE_LOAD_FAILED",
      `Could not load graph sources: ${error instanceof Error ? error.message : String(error)}`,
      { phase: "graph-source" },
    );
  }
  const snapshot = buildCodexGraphSnapshot({
    project,
    sourceSets: corpus.sourceSets,
    documents: corpus.documents,
    activeMemories: corpus.activeMemories,
  });
  const store = graphStore({ project, graphPath: args.graphPath, home: args.home });
  const graphPath = store.location;
  try {
    const result = syncMemoryGraph({
      store,
      project,
      sourceSpecs: snapshot.sourceSpecs,
      items: snapshot.items,
      edges: snapshot.edges,
      now: args.now,
    });
    return {
      ...result,
      graphPath,
      warnings: corpus.warnings,
      canonicalSourcesMutated: false,
      sourceIsolation,
    };
  } finally {
    store.close();
  }
}

export interface MemoryGraphStatus {
  ok: true;
  command: "graph status";
  exists: boolean;
  graphPath: string;
  project: string;
  schemaVersion: typeof memoryGraphSchemaVersion | null;
  indexerVersion: typeof memoryGraphIndexerVersion | null;
  syncedAt: string | null;
  sourceSpecs: string[];
  counts: { nodes: number; revisions: number; edges: number };
}

export function getMemoryGraphStatus(args: {
  project: string;
  graphPath?: string;
  home?: string;
}): MemoryGraphStatus {
  const project = path.resolve(args.project);
  const store = graphStore({ project, graphPath: args.graphPath, home: args.home });
  const graphPath = store.location;
  const metadata = store.readMetadata();
  if (!metadata) {
    store.close();
    return {
      ok: true,
      command: "graph status",
      exists: false,
      graphPath,
      project,
      schemaVersion: null,
      indexerVersion: null,
      syncedAt: null,
      sourceSpecs: [],
      counts: { nodes: 0, revisions: 0, edges: 0 },
    };
  }
  store.close();
  if (metadata.project !== project) {
    throw new RefineryError(
      "GRAPH_PROJECT_MISMATCH",
      `Graph index belongs to ${metadata.project}, not ${project}.`,
      { phase: "graph-status", details: { graphPath, indexProject: metadata.project, requestedProject: project } },
    );
  }
  return {
    ok: true,
    command: "graph status",
    exists: true,
    graphPath,
    project,
    schemaVersion: metadata.schemaVersion,
    indexerVersion: metadata.indexerVersion,
    syncedAt: metadata.syncedAt,
    sourceSpecs: metadata.sourceSpecs,
    counts: metadata.counts,
  };
}

export interface MemoryGraphNodeInspection {
  ok: true;
  command: "graph inspect";
  graphPath: string;
  node: MemoryGraphNode;
  revision: MemoryGraphRevision;
  incomingEdges: MemoryGraphEdge[];
  outgoingEdges: MemoryGraphEdge[];
  truncated: { incomingEdges: boolean; outgoingEdges: boolean };
}

export function inspectMemoryGraphNode(args: {
  project: string;
  nodeId: string;
  graphPath?: string;
  home?: string;
}): MemoryGraphNodeInspection {
  const store = graphStore(args);
  const graphPath = store.location;
  try {
    assertGraphAvailable(store, args.project, "graph-inspect");
    const found = store.findCurrentNode(args.nodeId);
    if (!found) {
      throw new RefineryError(
        "GRAPH_NODE_NOT_FOUND",
        `Graph node not found: ${args.nodeId}`,
        { phase: "graph-inspect", details: { graphPath, nodeId: args.nodeId } },
      );
    }
    assertNodeInProjectScope(found.node, args.project, "graph-inspect");
    const incoming = store.readAdjacentEdges({
      nodeId: found.node.id,
      direction: "incoming",
      edgeKinds: [...memoryGraphEdgeKinds],
      minConfidence: 0,
      limit: 500,
    });
    const outgoing = store.readAdjacentEdges({
      nodeId: found.node.id,
      direction: "outgoing",
      edgeKinds: [...memoryGraphEdgeKinds],
      minConfidence: 0,
      limit: 500,
    });
    return {
      ok: true,
      command: "graph inspect",
      graphPath,
      node: found.node,
      revision: found.revision,
      incomingEdges: incoming.edges,
      outgoingEdges: outgoing.edges,
      truncated: { incomingEdges: incoming.truncated, outgoingEdges: outgoing.truncated },
    };
  } finally {
    store.close();
  }
}

export interface MemoryGraphNeighborhood {
  ok: true;
  command: "graph neighbors";
  graphPath: string;
  rootNodeId: string;
  depth: number;
  limits: { maxNodes: number; maxEdges: number; edgeKinds: GraphEdgeKind[]; minConfidence: number };
  nodes: Array<{ node: MemoryGraphNode; revision: MemoryGraphRevision; depth: number }>;
  edges: MemoryGraphEdge[];
  truncated: { nodes: boolean; edges: boolean; depth: boolean };
}

export function getMemoryGraphNeighbors(args: {
  project: string;
  nodeId: string;
  graphPath?: string;
  home?: string;
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
  edgeKinds?: GraphEdgeKind[];
  minConfidence?: number;
}): MemoryGraphNeighborhood {
  const store = graphStore(args);
  const graphPath = store.location;
  try {
    assertGraphAvailable(store, args.project, "graph-neighbors");
  } catch (error) {
    store.close();
    throw error;
  }
  const rootRecord = store.findCurrentNode(args.nodeId);
  if (!rootRecord) {
    store.close();
    throw new RefineryError("GRAPH_NODE_NOT_FOUND", `Graph node not found: ${args.nodeId}`, {
      phase: "graph-neighbors",
      details: { graphPath, nodeId: args.nodeId },
    });
  }
  const root = rootRecord.node;
  try {
    assertNodeInProjectScope(root, args.project, "graph-neighbors");
  } catch (error) {
    store.close();
    throw error;
  }
  const project = path.resolve(args.project);
  const depth = Math.max(0, Math.min(6, Math.floor(args.depth ?? 1)));
  const maxNodes = Math.max(1, Math.min(1_000, Math.floor(args.maxNodes ?? 100)));
  const maxEdges = Math.max(0, Math.min(3_000, Math.floor(args.maxEdges ?? 300)));
  const edgeKinds = [...new Set(args.edgeKinds ?? memoryGraphEdgeKinds)].sort();
  const minConfidence = Math.max(0, Math.min(1, args.minConfidence ?? 0));
  const records = new Map([[root.id, rootRecord]]);
  const selected = new Map<string, number>([[root.id, 0]]);
  const selectedEdges = new Map<string, MemoryGraphEdge>();
  const queue = [{ nodeId: root.id, depth: 0 }];
  const truncated = { nodes: false, edges: false, depth: false };
  const eligible = (node: MemoryGraphNode) => node.scope === "global" || node.project === project;

  try {
    while (queue.length > 0) {
      const current = queue.shift()!;
      const adjacentResult = store.readAdjacentEdges({
        nodeId: current.nodeId,
        direction: "both",
        edgeKinds,
        minConfidence,
        limit: Math.max(1, maxEdges - selectedEdges.size + 1),
      });
      if (adjacentResult.truncated) truncated.edges = true;
      const adjacent = adjacentResult.edges;
      for (const edge of adjacent) {
        const nextNodeId = edge.sourceNodeId === current.nodeId ? edge.targetNodeId : edge.sourceNodeId;
        const nextRecord = records.get(nextNodeId) ?? store.findCurrentNode(nextNodeId);
        if (!nextRecord) continue;
        records.set(nextNodeId, nextRecord);
        if (!eligible(nextRecord.node)) continue;
        const nextDepth = current.depth + 1;
        if (nextDepth > depth) {
          truncated.depth = true;
          continue;
        }
        if (!selectedEdges.has(edge.id)) {
          if (selectedEdges.size >= maxEdges) {
            truncated.edges = true;
            continue;
          }
          selectedEdges.set(edge.id, edge);
        }
        if (!selected.has(nextRecord.node.id)) {
          if (selected.size >= maxNodes) {
            truncated.nodes = true;
            selectedEdges.delete(edge.id);
            continue;
          }
          selected.set(nextRecord.node.id, nextDepth);
          queue.push({ nodeId: nextRecord.node.id, depth: nextDepth });
        }
      }
    }
    return {
      ok: true,
      command: "graph neighbors",
      graphPath,
      rootNodeId: root.id,
      depth,
      limits: { maxNodes, maxEdges, edgeKinds, minConfidence },
      nodes: [...selected.entries()].map(([nodeId, nodeDepth]) => {
        const record = records.get(nodeId)!;
        return { node: record.node, revision: record.revision, depth: nodeDepth };
      }).sort((left, right) => left.depth - right.depth || left.node.id.localeCompare(right.node.id)),
      edges: [...selectedEdges.values()].sort((left, right) => left.id.localeCompare(right.id)),
      truncated,
    };
  } finally {
    store.close();
  }
}

export interface StoredResponsibilityPlan {
  graphPath: string;
  plan: ResponsibilityPlan;
  retrieval: {
    candidateNodes: number;
    hydratedNodes: number;
    hydratedEdges: number;
    fullGraphLoaded: false;
  };
}

export function planMemoryGraph(args: {
  project: string;
  graphPath?: string;
  home?: string;
  request?: string | null;
  scope: string;
  explicitNodeIds?: string[];
  changedNodeIds?: string[];
  limits?: Partial<ResponsibilityPlanLimits>;
  now?: Date;
}): StoredResponsibilityPlan {
  const store = graphStore(args);
  const graphPath = store.location;
  try {
    assertGraphAvailable(store, args.project, "graph-plan");
    const metadata = store.readMetadata()!;
    const maxNodes = Math.max(1, Math.floor(args.limits?.maxNodes ?? 24));
    const maxEdges = Math.max(0, Math.floor(args.limits?.maxEdges ?? 48));
    const maxHops = Math.max(0, Math.floor(args.limits?.maxHops ?? 2));
    const candidateLimit = Math.max(16, Math.min(1_000, maxNodes * 4));
    const candidateIds = store.searchNodeIds({
      request: args.request?.trim() ?? "",
      project: args.project,
      scope: args.scope,
      limit: candidateLimit,
    });
    const records = new Map<string, GraphNodeWithRevision>();
    const addRecord = (record: GraphNodeWithRevision | null): void => {
      if (record) records.set(record.node.id, record);
    };
    for (const nodeId of candidateIds) addRecord(store.findCurrentNode(nodeId));
    for (const identifier of [...(args.explicitNodeIds ?? []), ...(args.changedNodeIds ?? [])]) {
      addRecord(store.findCurrentNode(identifier));
    }
    if (records.size === 0) addRecord(store.findFirstEligibleNode(args.project, args.scope));

    const candidateIndex: MemoryGraphIndex = {
      schemaVersion: metadata.schemaVersion,
      indexerVersion: metadata.indexerVersion,
      project: metadata.project,
      sourceSpecs: metadata.sourceSpecs,
      syncedAt: metadata.syncedAt,
      nodes: [...records.values()].map((record) => record.node).sort((left, right) => left.id.localeCompare(right.id)),
      revisions: [...records.values()].map((record) => record.revision).sort((left, right) => left.id.localeCompare(right.id)),
      edges: [],
    };
    const candidatePlan = createResponsibilityPlan({
      index: candidateIndex,
      request: args.request,
      project: args.project,
      scope: args.scope,
      explicitNodeIds: args.explicitNodeIds,
      changedNodeIds: args.changedNodeIds,
      limits: { ...args.limits, maxNodes, maxEdges: 0, maxHops: 0 },
      now: args.now,
    });

    const hydratedNodeLimit = Math.max(100, Math.min(4_000, maxNodes * 8));
    const hydratedEdgeLimit = Math.max(200, Math.min(12_000, maxEdges * 8));
    const hydratedEdges = new Map<string, MemoryGraphEdge>();
    const queuedDepth = new Map(candidatePlan.seeds.map((seed) => [seed.nodeId, 0]));
    const queue = candidatePlan.seeds.map((seed) => ({ nodeId: seed.nodeId, depth: 0 }));
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxHops) continue;
      const adjacent = store.readAdjacentEdges({
        nodeId: current.nodeId,
        direction: "both",
        edgeKinds: [...memoryGraphEdgeKinds],
        minConfidence: 0,
        limit: Math.max(1, hydratedEdgeLimit - hydratedEdges.size),
      });
      for (const edge of adjacent.edges) {
        if (hydratedEdges.size >= hydratedEdgeLimit) break;
        hydratedEdges.set(edge.id, edge);
        const nextNodeId = edge.sourceNodeId === current.nodeId ? edge.targetNodeId : edge.sourceNodeId;
        if (!records.has(nextNodeId) && records.size < hydratedNodeLimit) addRecord(store.findCurrentNode(nextNodeId));
        if (!records.has(nextNodeId)) continue;
        const nextDepth = current.depth + 1;
        const knownDepth = queuedDepth.get(nextNodeId);
        if (nextDepth <= maxHops && (knownDepth === undefined || nextDepth < knownDepth)) {
          queuedDepth.set(nextNodeId, nextDepth);
          queue.push({ nodeId: nextNodeId, depth: nextDepth });
        }
      }
    }

    const index: MemoryGraphIndex = {
      ...candidateIndex,
      nodes: [...records.values()].map((record) => record.node).sort((left, right) => left.id.localeCompare(right.id)),
      revisions: [...records.values()].map((record) => record.revision).sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...hydratedEdges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
    return {
      graphPath,
      plan: createResponsibilityPlan({
        index,
        request: args.request,
        project: args.project,
        scope: args.scope,
        explicitNodeIds: args.explicitNodeIds,
        changedNodeIds: args.changedNodeIds,
        limits: args.limits,
        now: args.now,
      }),
      retrieval: {
        candidateNodes: candidateIndex.nodes.length,
        hydratedNodes: index.nodes.length,
        hydratedEdges: index.edges.length,
        fullGraphLoaded: false,
      },
    };
  } finally {
    store.close();
  }
}

export function readMemoryGraph(args: { project: string; graphPath?: string; home?: string }): {
  graphPath: string;
  index: MemoryGraphIndex;
} {
  const store = graphStore(args);
  try {
    return { graphPath: store.location, index: readRequiredGraph({ store, project: args.project }) };
  } finally {
    store.close();
  }
}

export interface PreparedGraphReviewPacket {
  packet: ReviewPacket;
  plan: ResponsibilityPlan;
  sync: SyncCodexMemoryGraphResult;
}

export async function prepareGraphReviewPacket(args: {
  packet: ReviewPacket;
  sourceSpecs?: SourceSpec[];
  memoryHome?: string;
  graphPath?: string;
  home?: string;
  sourceLimit?: number;
  explicitNodeIds?: string[];
  planLimits?: Partial<ResponsibilityPlanLimits>;
  now?: Date;
}): Promise<PreparedGraphReviewPacket> {
  const sourceSpecs = args.sourceSpecs ?? args.packet.sourceSets.map((sourceSet) => sourceSet.spec);
  const sync = await syncCodexMemoryGraph({
    project: args.packet.objective.project,
    sourceSpecs,
    memoryHome: args.memoryHome,
    graphPath: args.graphPath,
    home: args.home,
    sourceLimit: args.sourceLimit,
    now: args.now,
  });
  const plan = createResponsibilityPlan({
    index: sync.index,
    request: args.packet.objective.request,
    project: args.packet.objective.project,
    scope: args.packet.objective.scope,
    explicitNodeIds: args.explicitNodeIds,
    changedNodeIds: sync.changedNodeIds,
    limits: args.planLimits,
    now: args.now,
  });
  return {
    packet: attachResponsibilityContext({ packet: args.packet, index: sync.index, plan }),
    plan,
    sync,
  };
}
