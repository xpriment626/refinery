import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type ReviewTopology } from "./topology.ts";
import { refineryReviewSchemaVersion, type ReviewPacket, type SkillCandidateArtifact } from "../core/types.ts";
import { type ReviewRunResult, type ReviewSinkOptions, type ReviewSinkResult } from "../core/review.ts";
export interface CoralReviewRuntimeOptions {
    apiUrl?: string;
    authKey?: string;
    configPath?: string;
    namespace?: string;
    sessionId?: string;
    threadId?: string;
    startServer?: boolean;
    noTeardown?: boolean;
    coralPackage?: string;
    timeoutMs?: number;
    modelName?: string;
    modelBaseUrl?: string;
    reasoningEffort?: string;
    maxTurns?: string;
    topology?: ReviewTopology;
}
export interface CoralReviewRunOptions {
    packet: ReviewPacket;
    runId: string;
    outputDir: string;
    sink?: ReviewSinkOptions;
    coral?: CoralReviewRuntimeOptions;
}
export interface CoralReviewRunResult extends ReviewRunResult {
    mode: "coral";
    sourceSets: ReviewPacket["sourceSets"];
    targets: ReviewPacket["targets"];
    project: string;
    evidenceReview: unknown;
    skillCandidates?: SkillCandidateArtifact;
    coral: {
        namespace: string;
        sessionId: string;
        threadId: string;
        threadIds?: string[];
        agents: string[];
    };
    sink?: ReviewSinkResult;
}
export interface CoralConsoleRunOptions {
    packet: ReviewPacket;
    runId: string;
    coral?: CoralReviewRuntimeOptions;
}
export interface CoralConsoleRunResult {
    ok: true;
    schemaVersion: typeof refineryReviewSchemaVersion;
    command: "console run";
    mode: "coral-console";
    sourceSets: ReviewPacket["sourceSets"];
    targets: ReviewPacket["targets"];
    project: string;
    scope: string;
    dryRun: true;
    archive: false;
    artifactDir: null;
    writesAttempted: false;
    runId: string;
    consoleUrl: string;
    schemaUrl: string;
    counts: {
        sourceSets: number;
        documents: number;
        activeMemoryHints: number;
        seededMessages: number;
    };
    coral: {
        apiUrl: string;
        namespace: string;
        sessionId: string;
        threadId: string;
        threadIds: string[];
        proposalThreadId?: string;
        critiqueThreadId?: string;
        agents: string[];
        topology: ReviewTopology;
        serverMode: "managed" | "attached";
        managedServerStarted: boolean;
    };
    seededMessages: Array<{
        id: string;
        threadId: string;
        senderName: string;
        mentionNames: string[];
        textExcerpt: string;
    }>;
    next: string;
}
export interface CoralConsoleRunSession {
    result: CoralConsoleRunResult;
    managedServerStarted: boolean;
    managedProcess: ChildProcessWithoutNullStreams | null;
    close: () => Promise<void>;
}
export declare function defaultCoralReviewTimeoutMs(topology: ReviewTopology): number;
export declare function resolveRuntimeCoralConfigPath(configPath: string): string;
export declare function startCoralConsoleRun(options: CoralConsoleRunOptions): Promise<CoralConsoleRunSession>;
export declare function runCoralReview(options: CoralReviewRunOptions): Promise<CoralReviewRunResult>;
