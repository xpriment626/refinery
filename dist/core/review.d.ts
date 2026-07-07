import { refineryReviewSchemaVersion, type MemoryProposal, type SourceSet, type SkillCandidateArtifact, type TargetSurface } from "./types.ts";
import { RefineryError } from "./errors.ts";
import { type ReviewRunMode } from "./artifacts.ts";
import { type ReviewIntent } from "./intents.ts";
export interface ReviewSinkOptions {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
}
export interface ReviewSinkResult {
    url: string;
    ok: boolean;
    status: number;
    deliveredAt: string;
    responseText: string;
}
export interface ReviewRejected {
    sourceId: string;
    reason: string;
}
export interface ReviewRunResult {
    ok: true;
    schemaVersion: typeof refineryReviewSchemaVersion;
    command: "review";
    sourceSets?: SourceSet[];
    targets?: TargetSurface[];
    scope: string;
    dryRun: true;
    runId: string;
    runDir: string;
    counts: {
        sourceSets?: number;
        documents?: number;
        activeMemoryHints?: number;
        sources?: number;
        activeMemories?: number;
        proposals: number;
        rejected: number;
        skillCandidates?: number;
        skillCandidateRejected?: number;
        skillCandidateUnresolved?: number;
        claims?: number;
        challenges?: number;
        deliberationMoves?: number;
    };
    proposals: MemoryProposal[];
    rejected: ReviewRejected[];
    skillCandidates?: SkillCandidateArtifact;
    metadata: ReviewRunMetadata;
    sink?: ReviewSinkResult;
}
export interface ReviewRunMetadata {
    schemaVersion: typeof refineryReviewSchemaVersion;
    runId: string;
    sourceSets?: SourceSet[];
    targets?: TargetSurface[];
    scope: string;
    dryRun: true;
    mode: ReviewRunMode;
    createdAt: string;
    writesAttempted: false;
    sinkUrl: string | null;
    runtime: Record<string, unknown>;
    specialistOrder: string[];
    sourceLimit: number | null;
    sourceCharLimit: number | null;
    intent: ReviewIntent;
    request: string | null;
    model?: Record<string, unknown>;
}
export interface ReviewFailureStatus {
    ok: false;
    schemaVersion: typeof refineryReviewSchemaVersion;
    command: "review";
    status: "failed";
    runId: string;
    runDir: string;
    scope: string;
    mode: ReviewRunMode;
    failedStep: string | null;
    rawOutputPath: string | null;
    createdAt: string;
    failedAt: string;
    error: Record<string, unknown>;
    intent?: ReviewIntent;
    request?: string | null;
}
export declare function writeReviewFailureStatus(args: {
    runDir: string;
    runId: string;
    scope: string;
    mode: ReviewRunMode;
    createdAt: string;
    error: RefineryError;
    intent?: ReviewIntent;
    request?: string | null;
}): ReviewFailureStatus;
export declare function deliverReviewSink(sink: ReviewSinkOptions, result: Omit<ReviewRunResult, "sink">): Promise<ReviewSinkResult>;
