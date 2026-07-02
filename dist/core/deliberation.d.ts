import { refineryReviewSchemaVersion } from "./adapter.ts";
export type DeliberationMoveKind = "claim" | "question" | "challenge" | "handoff" | "endorsement";
export type ChallengeKind = "duplicate" | "evidence_gap" | "conflict" | "scope_risk" | "staleness" | "open_question";
export type ChallengeStatus = "open" | "answered" | "accepted" | "rejected" | "resolved";
export type ClaimStatus = "proposed" | "challenged" | "endorsed" | "accepted" | "rejected" | "unresolved";
export interface ClaimCard {
    schemaVersion: typeof refineryReviewSchemaVersion;
    claimId: string;
    body: string;
    sourceRefs: unknown[];
    whyFutureUseful: string | null;
    candidateAction: string | null;
    targetMemoryRefs: Array<string | number>;
    confidence: number | null;
    status: ClaimStatus;
    statusReason: string | null;
    specialistTrace: Array<{
        step: string;
        phase: string | null;
        messageId: string | null;
        threadId: string | null;
    }>;
}
export interface ChallengeLedgerEntry {
    schemaVersion: typeof refineryReviewSchemaVersion;
    challengeId: string;
    claimId: string;
    kind: ChallengeKind;
    raisedBy: string;
    targetAgent: string | null;
    status: ChallengeStatus;
    rationale: string;
    evidenceRefs: unknown[];
    memoryRefs: Array<{
        memory_id: string | number;
        provenance_kind: string | null;
    }>;
    resolution: string | null;
    phase: string | null;
    threadId: string | null;
    messageId: string | null;
}
export interface DeliberationTraceEntry {
    moveId: string;
    kind: DeliberationMoveKind;
    claimId: string | null;
    challengeId: string | null;
    agent: string;
    step: string;
    phase: string | null;
    threadId: string | null;
    messageId: string | null;
    summary: string;
    refs: unknown[];
}
export interface DeliberationSpecialistMessage {
    step: string;
    agent: string;
    status: "succeeded" | "failed";
    messageId: string | null;
    threadId: string | null;
    phase: string | null;
    output: Record<string, unknown> | null;
}
export interface DeliberationArtifacts {
    schemaVersion: typeof refineryReviewSchemaVersion;
    topology: string;
    claims: ClaimCard[];
    challengeLedger: ChallengeLedgerEntry[];
    trace: DeliberationTraceEntry[];
    summary: {
        claims: number;
        acceptedClaims: number;
        rejectedClaims: number;
        challengedClaims: number;
        challenges: number;
        unresolvedChallenges: number;
        moves: number;
    };
}
export declare function buildDeliberationArtifacts(args: {
    runId: string;
    topology: string;
    messages: DeliberationSpecialistMessage[];
}): DeliberationArtifacts;
export declare function claimCardsForCritique(args: {
    runId: string;
    claimScoutOutput: Record<string, unknown>;
}): ClaimCard[];
