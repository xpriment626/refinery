export declare const memoryMaintenanceActions: readonly ["create", "update", "supersede", "merge", "archive", "retag", "quarantine", "promote", "demote", "ttl_update", "contradiction_review"];
export declare const memoryProposalLifecycleStates: readonly ["proposed", "needs_review", "accepted", "rejected", "deferred", "applied_externally", "superseded", "archived_for_audit"];
export declare const refineryReviewSchemaVersion = "refinery.review.v1";
export type MemoryMaintenanceAction = (typeof memoryMaintenanceActions)[number];
export type MemoryProposalLifecycle = (typeof memoryProposalLifecycleStates)[number];
export interface SourceEvidence {
    id: string;
    kind: string;
    path?: string | null;
    text: string;
    refs?: unknown[];
    metadata?: Record<string, unknown>;
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
export interface AdapterScopeInput {
    scope: string;
    limit?: number;
}
export interface AdapterSearchInput extends AdapterScopeInput {
    query: string;
}
export interface AdapterReadInput {
    scope: string;
    id: string;
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
export interface ApplyProposalInput {
    proposal: MemoryProposal;
    approvedBy: string;
    dryRun?: boolean;
}
export interface MemoryStoreAdapter {
    name: string;
    listSourceEvidence(input: AdapterScopeInput): Promise<SourceEvidence[]>;
    searchSourceEvidence(input: AdapterSearchInput): Promise<SourceEvidence[]>;
    getSourceEvidence(input: AdapterReadInput): Promise<SourceEvidence | null>;
    listActiveMemories(input: AdapterScopeInput): Promise<ActiveMemory[]>;
    searchActiveMemories(input: AdapterSearchInput): Promise<ActiveMemory[]>;
    getActiveMemory(input: AdapterReadInput): Promise<ActiveMemory | null>;
    applyProposal?(input: ApplyProposalInput): Promise<unknown>;
}
export interface AdapterValidationResult {
    valid: boolean;
    name: string | null;
    capabilities: {
        listSourceEvidence: boolean;
        searchSourceEvidence: boolean;
        getSourceEvidence: boolean;
        listActiveMemories: boolean;
        searchActiveMemories: boolean;
        getActiveMemory: boolean;
        applyProposal: boolean;
    };
    errors: string[];
}
export interface AdapterProbeResult {
    probed: boolean;
    valid: boolean;
    sourceCount: number;
    activeMemoryCount: number;
    errors: string[];
}
export declare function validateMemoryStoreAdapter(adapter: unknown): AdapterValidationResult;
export declare function probeMemoryStoreAdapter(adapter: MemoryStoreAdapter, input: AdapterScopeInput): Promise<AdapterProbeResult>;
