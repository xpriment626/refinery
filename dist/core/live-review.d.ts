import type { ModelConfig } from "../env.ts";
import { type MemoryMaintenanceAction } from "./adapter.ts";
import type { LocalSpecialist } from "./specialists/types.ts";
export interface ClaimScoutCandidate {
    claim: string;
    source_refs: unknown[];
    why_future_useful: string;
}
export interface ClaimScoutOutput {
    candidates: ClaimScoutCandidate[];
}
export interface DistilledMemory {
    body: string;
    source_refs: unknown[];
    rationale: string;
}
export interface TypedCandidate {
    body: string;
    memory_type: string;
    primary_type: string;
    secondary_type: string | null;
    type_confidence: number;
    type_rationale: string;
    ambiguities: string[];
    durability: "durable" | "ttl" | "ephemeral";
    ttl: string | null;
    proposed_scope: string;
    action: MemoryMaintenanceAction;
    target_memory_id: string | number | null;
    target_memory_ids?: Array<string | number>;
    source_refs: unknown[];
}
export interface ProposalEditorOutput {
    typed: TypedCandidate[];
}
export interface MemoryProposalDraft {
    memory_type: string;
    proposed_scope: string;
    body: string;
    confidence: number;
    rationale: string;
    source_refs: unknown[];
    action: MemoryMaintenanceAction;
    target_memory_id: string | number | null;
    target_memory_ids?: Array<string | number>;
    staleness_reason?: string | null;
    forget_reason?: string | null;
    update_reason?: string | null;
    conflict_reason?: string | null;
    scope_reason?: string | null;
    replacement_body?: string | null;
    ambiguities?: string[];
}
export interface RejectedCandidate {
    body?: string;
    reason: string;
}
export interface DecisionSynthesizerOutput {
    proposals: MemoryProposalDraft[];
    rejected: RejectedCandidate[];
}
export interface RelationshipFinding {
    body: string;
    relation: "novel" | "duplicate" | "refinement" | "contradiction" | "supersession" | "too_weak";
    target_memory_id: string | number | null;
    confidence: number;
    rationale: string;
    source_refs: unknown[];
    memory_refs: {
        memory_id: string | number;
        provenance_kind: string | null;
    }[];
}
export interface EvidenceFindingOutput {
    findings: RelationshipFinding[];
}
export declare function extractJson(raw: string): unknown;
export declare function redactModel(config: ModelConfig): Omit<ModelConfig, "apiKey"> & {
    apiKeyPresent: boolean;
};
export declare function parseClaimScout(raw: string): ClaimScoutOutput;
export declare function parseProposalEditor(raw: string): ProposalEditorOutput;
export declare function parseDecisionSynthesizer(raw: string): DecisionSynthesizerOutput;
export declare function parseEvidenceFindings(raw: string): EvidenceFindingOutput;
export declare function buildPrompt(args: {
    specialist: LocalSpecialist;
    shape: string;
    instruction: string;
    payload: unknown;
}): {
    system: string;
    user: string;
};
