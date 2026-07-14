export declare const memoryGraphSchemaVersion: "refinery.memory-graph.v1";
export declare const memoryGraphIndexerVersion: "refinery.memory-graph-indexer.v1";
export declare const memoryGraphNodeKinds: readonly ["memory", "source_document", "session", "skill", "project", "evidence"];
export declare const memoryGraphEdgeKinds: readonly ["DERIVED_FROM", "OBSERVED_IN_SESSION", "APPLIES_TO_PROJECT", "SUPPORTS", "CONTRADICTS", "SUPERSEDES", "DUPLICATES", "SAME_TOPIC_AS", "REQUIRES_SKILL"];
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
export declare class JsonGraphStore implements GraphStore {
    readonly location: string;
    constructor(location: string);
    read(): MemoryGraphIndex | null;
    write(index: MemoryGraphIndex): void;
}
export declare function syncMemoryGraph(args: {
    store: GraphStore;
    project: string;
    sourceSpecs: string[];
    items: GraphSourceItem[];
    edges: GraphEdgeInput[];
    now?: Date;
}): GraphSyncResult;
