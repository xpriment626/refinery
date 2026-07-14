import { type GraphEdgeKind, type MemoryGraphEdge, type MemoryGraphIndex, type MemoryGraphNode } from "./sync.ts";
export declare const responsibilityPlanSchemaVersion: "refinery.responsibility-plan.v1";
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
export type ResponsibilityExclusionReason = "scope-mismatch" | "freshness-limit" | "node-budget" | "edge-budget" | "hop-limit" | "character-budget" | "token-budget" | "edge-kind-filter" | "confidence-filter" | "missing-revision";
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
export declare function createResponsibilityPlan(args: {
    index: MemoryGraphIndex;
    request?: string | null;
    project: string;
    scope: string;
    explicitNodeIds?: string[];
    changedNodeIds?: string[];
    limits?: Partial<ResponsibilityPlanLimits>;
    now?: Date;
}): ResponsibilityPlan;
