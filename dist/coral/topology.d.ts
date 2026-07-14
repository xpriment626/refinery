import type { ResponsibilityUnit } from "../core/graph/plan.ts";
export declare const reviewTopologies: readonly ["pipeline", "debate-critique", "sparse-blackboard"];
export type ReviewTopology = (typeof reviewTopologies)[number];
export declare const defaultReviewTopology: ReviewTopology;
export interface CoralResponsibilityAttachment {
    responsibilityUnitId: string;
    responsibilityState: ResponsibilityUnit["state"];
    wakeTargetAgent: string;
    attachedAgent: string | null;
}
export interface CoralCommunicationProjection {
    schemaVersion: "refinery.coral-runtime-projection.v1";
    topology: ReviewTopology;
    roster: "static-specialists";
    groups: string[][];
    dynamicAgentInsertion: false;
    nativeSleep: false;
    idleMechanism: "wait_for_mention";
    wakeSignal: "mention";
    durableStateOwner: "refinery-libsql";
    coordination: "agent-chain" | "claim-critique" | "app-owned-topic-blackboard";
    attachments: CoralResponsibilityAttachment[];
}
export declare function buildCoralCommunicationGroups(topology: ReviewTopology): string[][];
export declare function buildCoralCommunicationProjection(topology: ReviewTopology, units?: ResponsibilityUnit[]): CoralCommunicationProjection;
export declare function parseReviewTopology(value: unknown): ReviewTopology;
export declare function isReviewTopology(value: unknown): value is ReviewTopology;
