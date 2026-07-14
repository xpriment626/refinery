import type { ReviewPacket, SourceSpec } from "../types.ts";
import { type ResponsibilityPlan, type ResponsibilityPlanLimits } from "./plan.ts";
import { memoryGraphIndexerVersion, memoryGraphSchemaVersion, type GraphSyncResult, type MemoryGraphEdge, type MemoryGraphIndex, type MemoryGraphNode, type MemoryGraphRevision, type GraphEdgeKind } from "./sync.ts";
export interface SyncCodexMemoryGraphResult extends GraphSyncResult {
    graphPath: string;
    warnings: string[];
    canonicalSourcesMutated: false;
    sourceIsolation: {
        processSeparated: true;
        permissionModel: boolean;
    };
}
export declare function syncCodexMemoryGraph(args: {
    project: string;
    sourceSpecs?: SourceSpec[];
    memoryHome?: string;
    graphPath?: string;
    home?: string;
    sourceLimit?: number;
    now?: Date;
}): Promise<SyncCodexMemoryGraphResult>;
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
    counts: {
        nodes: number;
        revisions: number;
        edges: number;
    };
}
export declare function getMemoryGraphStatus(args: {
    project: string;
    graphPath?: string;
    home?: string;
}): MemoryGraphStatus;
export interface MemoryGraphNodeInspection {
    ok: true;
    command: "graph inspect";
    graphPath: string;
    node: MemoryGraphNode;
    revision: MemoryGraphRevision;
    incomingEdges: MemoryGraphEdge[];
    outgoingEdges: MemoryGraphEdge[];
    truncated: {
        incomingEdges: boolean;
        outgoingEdges: boolean;
    };
}
export declare function inspectMemoryGraphNode(args: {
    project: string;
    nodeId: string;
    graphPath?: string;
    home?: string;
}): MemoryGraphNodeInspection;
export interface MemoryGraphNeighborhood {
    ok: true;
    command: "graph neighbors";
    graphPath: string;
    rootNodeId: string;
    depth: number;
    limits: {
        maxNodes: number;
        maxEdges: number;
        edgeKinds: GraphEdgeKind[];
        minConfidence: number;
    };
    nodes: Array<{
        node: MemoryGraphNode;
        revision: MemoryGraphRevision;
        depth: number;
    }>;
    edges: MemoryGraphEdge[];
    truncated: {
        nodes: boolean;
        edges: boolean;
        depth: boolean;
    };
}
export declare function getMemoryGraphNeighbors(args: {
    project: string;
    nodeId: string;
    graphPath?: string;
    home?: string;
    depth?: number;
    maxNodes?: number;
    maxEdges?: number;
    edgeKinds?: GraphEdgeKind[];
    minConfidence?: number;
}): MemoryGraphNeighborhood;
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
export declare function planMemoryGraph(args: {
    project: string;
    graphPath?: string;
    home?: string;
    request?: string | null;
    scope: string;
    explicitNodeIds?: string[];
    changedNodeIds?: string[];
    limits?: Partial<ResponsibilityPlanLimits>;
    now?: Date;
}): StoredResponsibilityPlan;
export declare function readMemoryGraph(args: {
    project: string;
    graphPath?: string;
    home?: string;
}): {
    graphPath: string;
    index: MemoryGraphIndex;
};
export interface PreparedGraphReviewPacket {
    packet: ReviewPacket;
    plan: ResponsibilityPlan;
    sync: SyncCodexMemoryGraphResult;
}
export declare function prepareGraphReviewPacket(args: {
    packet: ReviewPacket;
    sourceSpecs?: SourceSpec[];
    memoryHome?: string;
    graphPath?: string;
    home?: string;
    sourceLimit?: number;
    explicitNodeIds?: string[];
    planLimits?: Partial<ResponsibilityPlanLimits>;
    now?: Date;
}): Promise<PreparedGraphReviewPacket>;
