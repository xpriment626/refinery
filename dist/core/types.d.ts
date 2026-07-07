export declare const memoryMaintenanceActions: readonly ["create", "update", "supersede", "merge", "archive", "retag", "quarantine", "promote", "demote", "ttl_update", "contradiction_review"];
export declare const memoryProposalLifecycleStates: readonly ["proposed", "needs_review", "accepted", "rejected", "deferred", "applied_externally", "superseded", "archived_for_audit"];
export declare const refineryReviewSchemaVersion = "refinery.review.v1";
export declare const reviewPacketSchemaVersion = "refinery.review-packet.v1";
export declare const sourceSpecKinds: readonly ["codex:memories", "codex:sessions", "codex:skills", "file", "glob"];
export declare const targetSurfaces: readonly ["codex:memories", "codex:skills"];
export type MemoryMaintenanceAction = (typeof memoryMaintenanceActions)[number];
export type MemoryProposalLifecycle = (typeof memoryProposalLifecycleStates)[number];
export type SourceSpecKind = (typeof sourceSpecKinds)[number];
export type TargetSurface = (typeof targetSurfaces)[number];
export interface SourceSpec {
    raw: string;
    kind: SourceSpecKind;
    value: string | null;
    params: Record<string, string>;
}
export interface SourceSet {
    id: string;
    spec: SourceSpec;
    label: string;
    role: string;
    metadata: Record<string, unknown>;
}
export interface SourceDocument {
    id: string;
    sourceSet: string;
    role: string;
    uri: string;
    text: string;
    metadata: Record<string, unknown>;
}
export interface ActiveMemory {
    id: string;
    type: string;
    scope: string;
    status: string;
    body: string;
    confidence?: number | null;
    provenance?: Record<string, unknown>;
}
export interface ReviewPacketLimits {
    sourceLimit: number;
    sourceCharLimit: number;
    documentCharLimit: number;
    activeMemoryLimit: number;
}
export interface ReviewPacketDerivedViews {
    source_chunks: unknown[];
    active_memory_hints: unknown[];
}
export interface ReviewPacket {
    schemaVersion: typeof reviewPacketSchemaVersion;
    type: "refinery-review-packet";
    sourceSets: SourceSet[];
    documents: SourceDocument[];
    targets: TargetSurface[];
    objective: {
        intent: string;
        request: string | null;
        project: string;
        scope: string;
    };
    limits: ReviewPacketLimits;
    derivedViews: ReviewPacketDerivedViews;
    counts: {
        sourceSets: number;
        documents: number;
        activeMemoryHints: number;
        sourceChunks: number;
    };
    warnings: string[];
}
export interface MemoryProposal {
    schemaVersion: typeof refineryReviewSchemaVersion;
    id: string;
    action: MemoryMaintenanceAction;
    lifecycle: MemoryProposalLifecycle;
    intent?: string;
    memoryType: string;
    scope: string;
    body: string;
    confidence: number;
    rationale: string;
    sourceRefs: unknown[];
    targetMemoryId: string | null;
    targetMemoryIds?: string[];
    stalenessReason?: string | null;
    forgetReason?: string | null;
    updateReason?: string | null;
    conflictReason?: string | null;
    scopeReason?: string | null;
    replacementBody?: string | null;
    ambiguities?: string[];
}
export interface SkillCandidate {
    name: string;
    trigger: string;
    evidenceRefs: unknown[];
    existingSkillRefs: unknown[];
    skillMdOutline: string[];
    skillMdDraft: string;
    rationale: string;
    confidence: number;
}
export interface SkillCandidateRejection {
    sourceId: string;
    reason: string;
}
export interface SkillCandidateUnresolved {
    sourceId: string;
    question: string;
    evidenceRefs: unknown[];
}
export interface SkillCandidateArtifact {
    candidates: SkillCandidate[];
    rejected: SkillCandidateRejection[];
    unresolved: SkillCandidateUnresolved[];
}
