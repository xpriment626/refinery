import { type GraphStore, type GraphSyncDelta, type MemoryGraphEdge, type MemoryGraphIndex, type MemoryGraphNode, type MemoryGraphRevision } from "./sync.ts";
export declare const graphDatabaseSchemaVersion: 3;
export interface GraphDatabaseDiagnostics {
    schemaVersion: number;
    legacyImported: boolean;
    changeSequence: number;
}
export interface GraphChangeEvent {
    sequence: number;
    syncedAt: string;
    delta: GraphSyncDelta;
}
export interface GraphNodeWithRevision {
    node: MemoryGraphNode;
    revision: MemoryGraphRevision;
}
export interface GraphStoreMetadata {
    project: string;
    schemaVersion: MemoryGraphIndex["schemaVersion"];
    indexerVersion: MemoryGraphIndex["indexerVersion"];
    syncedAt: string;
    sourceSpecs: string[];
    counts: {
        nodes: number;
        revisions: number;
        edges: number;
    };
}
export interface GraphVisualizationSnapshot {
    schemaVersion: "refinery.graph-visualization.v1";
    syncedAt: string;
    changeSequence: number;
    counts: GraphStoreMetadata["counts"];
    nodes: GraphVisualizationNode[];
    edges: GraphVisualizationEdge[];
    truncated: {
        nodes: boolean;
        edges: boolean;
    };
}
export interface GraphVisualizationNode {
    id: string;
    label: string;
    kind: MemoryGraphNode["kind"];
    scope: string;
    sourceAdapter: string;
    hasUri: boolean;
}
export interface GraphVisualizationEdge {
    id: string;
    source: string;
    target: string;
    kind: MemoryGraphEdge["kind"];
    confidence: number;
}
export interface GraphVisualizationDelta {
    schemaVersion: "refinery.graph-visualization-delta.v1";
    afterSequence: number;
    sequence: number;
    syncedAt: string;
    counts: GraphStoreMetadata["counts"];
    resetRequired: boolean;
    hasMore: boolean;
    nodes: GraphVisualizationNode[];
    edges: GraphVisualizationEdge[];
    removedNodeIds: string[];
    removedEdgeIds: string[];
}
interface LibsqlGraphStoreOptions {
    legacyJsonPath?: string;
}
export declare class LibsqlGraphStore implements GraphStore {
    #private;
    readonly location: string;
    readonly legacyJsonPath: string | null;
    constructor(location: string, options?: LibsqlGraphStoreOptions);
    close(): void;
    read(): MemoryGraphIndex | null;
    write(index: MemoryGraphIndex, previous?: MemoryGraphIndex | null, delta?: GraphSyncDelta): void;
    diagnostics(): GraphDatabaseDiagnostics;
    readChanges(options?: {
        afterSequence?: number;
        limit?: number;
    }): GraphChangeEvent[];
    findCurrentNode(identifier: string): GraphNodeWithRevision | null;
    findFirstEligibleNode(projectInput: string, scope: string): GraphNodeWithRevision | null;
    readAdjacentEdges(options: {
        nodeId: string;
        direction?: "both" | "incoming" | "outgoing";
        edgeKinds: MemoryGraphEdge["kind"][];
        minConfidence: number;
        limit: number;
    }): {
        edges: MemoryGraphEdge[];
        truncated: boolean;
    };
    searchNodeIds(options: {
        request: string;
        project: string;
        scope: string;
        limit: number;
    }): string[];
    readMetadata(): GraphStoreMetadata | null;
    readVisualizationSnapshot(options: {
        maxNodes: number;
        maxEdges: number;
    }): GraphVisualizationSnapshot | null;
    readVisualizationDelta(options: {
        afterSequence: number;
        maxEvents?: number;
        maxNodeChanges?: number;
        maxEdgeChanges?: number;
    }): GraphVisualizationDelta;
}
export {};
