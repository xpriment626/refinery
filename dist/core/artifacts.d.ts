import { refineryReviewSchemaVersion } from "./types.ts";
import { type ReviewIntent } from "./intents.ts";
export declare const reviewStepOrder: string[];
export type ReviewRunMode = "coral";
export type ReviewRunStatus = "succeeded" | "failed";
export interface ReviewStepArtifactPaths {
    input?: string;
    outputRaw?: string;
    outputParsed?: string;
}
export interface ReviewArtifactManifest {
    ok: boolean;
    schemaVersion: typeof refineryReviewSchemaVersion;
    command: "review";
    runId: string;
    runDir: string;
    mode: ReviewRunMode;
    scope: string;
    intent?: ReviewIntent;
    request?: string | null;
    status: ReviewRunStatus;
    createdAt: string;
    failedAt?: string;
    failedStep?: string | null;
    rawOutputPath?: string | null;
    counts?: Record<string, number>;
    runtime?: Record<string, unknown>;
    model?: Record<string, unknown>;
    stepOrder: string[];
    artifacts: {
        manifest: string;
        input?: string;
        sourceCounts?: string;
        metadata?: string;
        review?: string;
        proposals?: string;
        rejected?: string;
        claims?: string;
        challengeLedger?: string;
        deliberation?: string;
        status?: string;
        sink?: string;
        coral?: string;
        transcript?: string;
        skillCandidates?: string;
        steps: Record<string, ReviewStepArtifactPaths>;
    };
    error?: Record<string, unknown>;
}
export interface TrialInspectSummary {
    ok: boolean;
    command: "trial inspect";
    schemaVersion: typeof refineryReviewSchemaVersion;
    runId: string;
    runDir: string;
    mode: ReviewRunMode;
    status: ReviewRunStatus;
    counts: Record<string, number>;
    actionDistribution: Record<string, number>;
    lifecycleDistribution: Record<string, number>;
    deliberation: {
        claims: number;
        challenges: number;
        moves: number;
        unresolvedChallenges: number;
    };
    steps: Record<string, {
        input: boolean;
        outputRaw: boolean;
        outputParsed: boolean;
    }>;
    artifacts: ReviewArtifactManifest["artifacts"];
    sink?: Record<string, unknown>;
    error?: Record<string, unknown>;
    manifest: ReviewArtifactManifest;
}
export declare function writeReviewArtifactManifest(args: {
    runDir: string;
    runId: string;
    scope: string;
    mode: ReviewRunMode;
    status: ReviewRunStatus;
    createdAt: string;
    failedAt?: string;
    failedStep?: string | null;
    rawOutputPath?: string | null;
    counts?: Record<string, number>;
    metadata?: Record<string, unknown>;
    error?: Record<string, unknown>;
    intent?: ReviewIntent;
    request?: string | null;
}): ReviewArtifactManifest;
export declare function inspectReviewRun(runDirInput: string): TrialInspectSummary;
