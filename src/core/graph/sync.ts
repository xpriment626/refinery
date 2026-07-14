import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RefineryError } from "../errors.ts";

export const memoryGraphSchemaVersion = "refinery.memory-graph.v1" as const;
export const memoryGraphIndexerVersion = "refinery.memory-graph-indexer.v1" as const;

export const memoryGraphNodeKinds = [
  "memory",
  "source_document",
  "session",
  "skill",
  "project",
  "evidence",
] as const;

export const memoryGraphEdgeKinds = [
  "DERIVED_FROM",
  "OBSERVED_IN_SESSION",
  "APPLIES_TO_PROJECT",
  "SUPPORTS",
  "CONTRADICTS",
  "SUPERSEDES",
  "DUPLICATES",
  "SAME_TOPIC_AS",
  "REQUIRES_SKILL",
] as const;

export type GraphNodeKind = (typeof memoryGraphNodeKinds)[number];
export type GraphEdgeKind = (typeof memoryGraphEdgeKinds)[number];

export interface GraphSourceItem {
  sourceAdapter: string;
  sourceKey: string;
  kind: GraphNodeKind;
  scope: string;
  project: string | null;
  label: string;
  content: string;
  uri: string | null;
  metadata: Record<string, unknown>;
  sourceModifiedAt?: string | null;
}

export interface GraphEdgeInput {
  sourceAdapter: string;
  sourceKey: string;
  targetAdapter: string;
  targetKey: string;
  kind: GraphEdgeKind;
  confidence: number;
  derivation: string;
  evidenceRefs?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface MemoryGraphNode {
  id: string;
  sourceAdapter: string;
  sourceKey: string;
  kind: GraphNodeKind;
  scope: string;
  project: string | null;
  label: string;
  uri: string | null;
  currentRevisionId: string;
  metadata: Record<string, unknown>;
}

export interface MemoryGraphRevision {
  id: string;
  nodeId: string;
  contentHash: string;
  indexerVersion: typeof memoryGraphIndexerVersion;
  content: string;
  charCount: number;
  indexedAt: string;
  sourceModifiedAt: string | null;
}

export interface MemoryGraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: GraphEdgeKind;
  sourceRevisionId: string;
  confidence: number;
  provenance: {
    derivation: string;
    evidenceRefs: unknown[];
    metadata: Record<string, unknown>;
  };
}

export interface MemoryGraphIndex {
  schemaVersion: typeof memoryGraphSchemaVersion;
  indexerVersion: typeof memoryGraphIndexerVersion;
  project: string;
  sourceSpecs: string[];
  syncedAt: string;
  nodes: MemoryGraphNode[];
  revisions: MemoryGraphRevision[];
  edges: MemoryGraphEdge[];
}

export interface GraphSyncDelta {
  createdNodeIds: string[];
  updatedNodeIds: string[];
  removedNodeIds: string[];
  createdRevisionIds: string[];
  removedRevisionIds: string[];
  createdEdgeIds: string[];
  updatedEdgeIds: string[];
  removedEdgeIds: string[];
}

export interface GraphStore {
  readonly location: string | null;
  read(): MemoryGraphIndex | null;
  write(index: MemoryGraphIndex, previous?: MemoryGraphIndex | null, delta?: GraphSyncDelta): void;
}

export interface GraphSyncSummary {
  createdNodes: number;
  updatedNodes: number;
  unchangedNodes: number;
  removedNodes: number;
  createdRevisions: number;
  removedRevisions: number;
  updatedEdges: number;
  removedEdges: number;
  nodes: number;
  revisions: number;
  edges: number;
}

export interface GraphSyncResult {
  index: MemoryGraphIndex;
  summary: GraphSyncSummary;
  delta: GraphSyncDelta;
  changedNodeIds: string[];
  removedNodeIds: string[];
}

export class JsonGraphStore implements GraphStore {
  readonly location: string;

  constructor(location: string) {
    this.location = path.resolve(location);
  }

  read(): MemoryGraphIndex | null {
    if (!fs.existsSync(this.location)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.location, "utf8")) as Partial<MemoryGraphIndex>;
      if (
        parsed.schemaVersion !== memoryGraphSchemaVersion ||
        parsed.indexerVersion !== memoryGraphIndexerVersion ||
        typeof parsed.project !== "string" ||
        !Array.isArray(parsed.nodes) ||
        !Array.isArray(parsed.revisions) ||
        !Array.isArray(parsed.edges)
      ) {
        throw new Error("graph index schema is unsupported or incomplete");
      }
      return parsed as MemoryGraphIndex;
    } catch (error) {
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not read Refinery graph index at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location } },
      );
    }
  }

  write(index: MemoryGraphIndex): void {
    const parent = path.dirname(this.location);
    const temporary = `${this.location}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.location);
      fs.chmodSync(this.location, 0o600);
    } catch (error) {
      throw new RefineryError(
        "GRAPH_STORE_WRITE_FAILED",
        `Could not write Refinery graph index at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location } },
      );
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }
}

function hash(parts: string[]): string {
  const digest = crypto.createHash("sha256");
  parts.forEach((part) => digest.update(part).update("\0"));
  return digest.digest("hex");
}

function nodeIdFor(item: Pick<GraphSourceItem, "sourceAdapter" | "sourceKey">): string {
  return `graph-node:${hash([item.sourceAdapter, item.sourceKey]).slice(0, 24)}`;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function revisionFor(item: GraphSourceItem, nodeId: string, indexedAt: string): MemoryGraphRevision {
  const content = normalizeContent(item.content);
  const contentHash = hash([content]);
  return {
    id: `graph-revision:${hash([nodeId, contentHash, memoryGraphIndexerVersion]).slice(0, 24)}`,
    nodeId,
    contentHash,
    indexerVersion: memoryGraphIndexerVersion,
    content,
    charCount: content.length,
    indexedAt,
    sourceModifiedAt: item.sourceModifiedAt ?? null,
  };
}

function assertUniqueItems(items: GraphSourceItem[]): void {
  const identities = new Set<string>();
  for (const item of items) {
    const identity = `${item.sourceAdapter}\0${item.sourceKey}`;
    if (identities.has(identity)) {
      throw new RefineryError(
        "GRAPH_SOURCE_DUPLICATE",
        `Graph source identity is duplicated: ${item.sourceAdapter}:${item.sourceKey}`,
        { phase: "graph-sync", details: { sourceAdapter: item.sourceAdapter, sourceKey: item.sourceKey } },
      );
    }
    identities.add(identity);
  }
}

function edgeIdentity(sourceAdapter: string, sourceKey: string): string {
  return `${sourceAdapter}\0${sourceKey}`;
}

function materializeEdges(
  inputs: GraphEdgeInput[],
  nodes: MemoryGraphNode[],
): MemoryGraphEdge[] {
  const nodesBySource = new Map(
    nodes.map((node) => [edgeIdentity(node.sourceAdapter, node.sourceKey), node]),
  );
  const edges = inputs.map((input) => {
    const source = nodesBySource.get(edgeIdentity(input.sourceAdapter, input.sourceKey));
    const target = nodesBySource.get(edgeIdentity(input.targetAdapter, input.targetKey));
    if (!source || !target) {
      const missing = [
        ...(!source ? [`${input.sourceAdapter}:${input.sourceKey}`] : []),
        ...(!target ? [`${input.targetAdapter}:${input.targetKey}`] : []),
      ];
      throw new RefineryError(
        "GRAPH_EDGE_ENDPOINT_MISSING",
        `Graph edge ${input.kind} references missing endpoint(s): ${missing.join(", ")}`,
        { phase: "graph-sync", details: { edge: input, missing } },
      );
    }
    const confidence = Math.max(0, Math.min(1, input.confidence));
    return {
      id: `graph-edge:${hash([
        source.id,
        target.id,
        input.kind,
        source.currentRevisionId,
        input.derivation,
      ]).slice(0, 24)}`,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      kind: input.kind,
      sourceRevisionId: source.currentRevisionId,
      confidence,
      provenance: {
        derivation: input.derivation,
        evidenceRefs: input.evidenceRefs ?? [],
        metadata: input.metadata ?? {},
      },
    } satisfies MemoryGraphEdge;
  });
  const unique = new Map(edges.map((edge) => [edge.id, edge]));
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function syncMemoryGraph(args: {
  store: GraphStore;
  project: string;
  sourceSpecs: string[];
  items: GraphSourceItem[];
  edges: GraphEdgeInput[];
  now?: Date;
}): GraphSyncResult {
  assertUniqueItems(args.items);
  const project = path.resolve(args.project);
  const previous = args.store.read();
  const previousForProject = previous?.project === project ? previous : null;
  const previousNodes = new Map(previousForProject?.nodes.map((node) => [node.id, node]) ?? []);
  const previousRevisions = new Map(previousForProject?.revisions.map((revision) => [revision.id, revision]) ?? []);
  const indexedAt = (args.now ?? new Date()).toISOString();
  const nodes: MemoryGraphNode[] = [];
  const currentRevisions: MemoryGraphRevision[] = [];
  const changedNodeIds: string[] = [];
  const createdNodeIds: string[] = [];
  const updatedNodeIds: string[] = [];
  const createdRevisionIds: string[] = [];
  let createdNodes = 0;
  let updatedNodes = 0;
  let unchangedNodes = 0;
  let createdRevisions = 0;

  const sortedItems = [...args.items].sort((left, right) => {
    const leftKey = `${left.sourceAdapter}\0${left.sourceKey}`;
    const rightKey = `${right.sourceAdapter}\0${right.sourceKey}`;
    return leftKey.localeCompare(rightKey);
  });
  for (const item of sortedItems) {
    const id = nodeIdFor(item);
    const revision = revisionFor(item, id, indexedAt);
    const priorNode = previousNodes.get(id);
    const priorRevision = previousRevisions.get(revision.id);
    const node: MemoryGraphNode = {
      id,
      sourceAdapter: item.sourceAdapter,
      sourceKey: item.sourceKey,
      kind: item.kind,
      scope: item.scope,
      project: item.project ? path.resolve(item.project) : null,
      label: item.label,
      uri: item.uri,
      currentRevisionId: revision.id,
      metadata: item.metadata,
    };
    if (!priorNode) {
      createdNodes += 1;
      createdNodeIds.push(id);
      changedNodeIds.push(id);
    } else if (JSON.stringify(priorNode) !== JSON.stringify(node)) {
      updatedNodes += 1;
      updatedNodeIds.push(id);
      changedNodeIds.push(id);
    } else {
      unchangedNodes += 1;
    }
    if (!priorRevision) {
      createdRevisions += 1;
      createdRevisionIds.push(revision.id);
    }
    currentRevisions.push(priorRevision ?? revision);
    nodes.push(node);
  }

  const currentNodeIds = new Set(nodes.map((node) => node.id));
  const removedNodeIds = [...previousNodes.keys()].filter((id) => !currentNodeIds.has(id)).sort();
  const currentRevisionIds = new Set(currentRevisions.map((revision) => revision.id));
  const removedRevisionIds = [...previousRevisions.keys()].filter((id) => !currentRevisionIds.has(id)).sort();
  const removedRevisions = removedRevisionIds.length;
  const edges = materializeEdges(args.edges, nodes);
  const currentEdgeIds = new Set(edges.map((edge) => edge.id));
  const previousEdges = new Map(previousForProject?.edges.map((edge) => [edge.id, edge]) ?? []);
  const previousEdgeIds = new Set(previousEdges.keys());
  const createdEdgeIds = edges.filter((edge) => !previousEdgeIds.has(edge.id)).map((edge) => edge.id).sort();
  const updatedEdgeIds = edges
    .filter((edge) => previousEdges.has(edge.id) && JSON.stringify(previousEdges.get(edge.id)) !== JSON.stringify(edge))
    .map((edge) => edge.id)
    .sort();
  const removedEdgeIds = previousForProject?.edges.filter((edge) => !currentEdgeIds.has(edge.id)).map((edge) => edge.id).sort() ?? [];
  const removedEdges = removedEdgeIds.length;
  const index: MemoryGraphIndex = {
    schemaVersion: memoryGraphSchemaVersion,
    indexerVersion: memoryGraphIndexerVersion,
    project,
    sourceSpecs: [...new Set(args.sourceSpecs)].sort(),
    syncedAt: indexedAt,
    nodes,
    revisions: currentRevisions.sort((left, right) => left.id.localeCompare(right.id)),
    edges,
  };
  const delta: GraphSyncDelta = {
    createdNodeIds: createdNodeIds.sort(),
    updatedNodeIds: updatedNodeIds.sort(),
    removedNodeIds,
    createdRevisionIds: createdRevisionIds.sort(),
    removedRevisionIds,
    createdEdgeIds,
    updatedEdgeIds,
    removedEdgeIds,
  };
  args.store.write(index, previousForProject, delta);
  return {
    index,
    summary: {
      createdNodes,
      updatedNodes,
      unchangedNodes,
      removedNodes: removedNodeIds.length,
      createdRevisions,
      removedRevisions,
      updatedEdges: updatedEdgeIds.length,
      removedEdges,
      nodes: index.nodes.length,
      revisions: index.revisions.length,
      edges: index.edges.length,
    },
    delta,
    changedNodeIds: changedNodeIds.sort(),
    removedNodeIds,
  };
}
