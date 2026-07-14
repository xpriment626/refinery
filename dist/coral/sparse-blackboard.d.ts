import type { ReviewPacket } from "../core/types.ts";
export declare const sparseBlackboardSchemaVersion: "refinery.sparse-blackboard.v1";
export interface SparseTopic {
    id: string;
    responsibilityUnitId: string;
    sourceChunkIds: string[];
    graphNodeIds: string[];
    state: "awake" | "sleeping" | "deferred";
}
export interface SparseRoutingDecision {
    candidateCount: number;
    wakeCartographer: boolean;
    wakeAuditor: boolean;
    wakeProposalEditor: boolean;
    wakeDecisionSynthesizer: boolean;
    overlapDetected: boolean;
    weaknessDetected: boolean;
    contradictionRisk: boolean;
    highImpact: boolean;
    disagreement: boolean;
    reasons: string[];
}
export interface SparseBlackboard {
    schemaVersion: typeof sparseBlackboardSchemaVersion;
    runId: string;
    topology: "sparse-blackboard";
    topics: SparseTopic[];
    sleepingTopicIds: string[];
    deferredTopicIds: string[];
    claims: Record<string, unknown>[];
    cartographyFindings: Record<string, unknown>[];
    auditFindings: Record<string, unknown>[];
    typedCandidates: Record<string, unknown>[];
    routing: SparseRoutingDecision;
    wakeSequence: string[];
    modelCalls: number;
}
export declare function buildSparseTopics(packet: ReviewPacket): SparseTopic[];
export declare function routeSparseClaims(args: {
    candidates: Record<string, unknown>[];
    activeMemories: Record<string, unknown>[];
    cartographyFindings?: Record<string, unknown>[];
    auditFindings?: Record<string, unknown>[];
    typedCandidates?: Record<string, unknown>[];
}): {
    decision: SparseRoutingDecision;
    survivors: Record<string, unknown>[];
};
export declare function createSparseBlackboard(runId: string, packet: ReviewPacket): SparseBlackboard;
