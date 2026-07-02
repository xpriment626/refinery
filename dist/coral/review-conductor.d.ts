import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type ReviewTopology } from "./topology.ts";
import { refineryReviewSchemaVersion, type MemoryStoreAdapter } from "../core/adapter.ts";
import { type ReviewRunResult, type ReviewSinkOptions, type ReviewSinkResult } from "../core/review.ts";
import { type ReviewIntent } from "../core/intents.ts";
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
    adapter: MemoryStoreAdapter;
    project: string;
    source: "codex-memory";
    target: "codex-memory";
    scope: string;
    runId: string;
    outputDir: string;
    intent?: ReviewIntent;
    request?: string | null;
    sink?: ReviewSinkOptions;
    sourceLimit?: number;
    sourceCharLimit?: number;
    coral?: CoralReviewRuntimeOptions;
}
export interface CoralReviewRunResult extends ReviewRunResult {
    mode: "coral";
    source: "codex-memory";
    target: "codex-memory";
    project: string;
    evidenceReview: unknown;
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
    adapter: MemoryStoreAdapter;
    project: string;
    source: "codex-memory";
    target: "codex-memory";
    scope: string;
    runId: string;
    intent?: ReviewIntent;
    request?: string | null;
    sourceLimit?: number;
    sourceCharLimit?: number;
    coral?: CoralReviewRuntimeOptions;
}
export interface CoralConsoleRunResult {
    ok: true;
    schemaVersion: typeof refineryReviewSchemaVersion;
    command: "console run";
    mode: "coral-console";
    source: "codex-memory";
    target: "codex-memory";
    project: string;
    adapter: {
        name: string;
    };
    scope: string;
    dryRun: true;
    archive: false;
    artifactDir: null;
    writesAttempted: false;
    runId: string;
    consoleUrl: string;
    schemaUrl: string;
    counts: {
        sources: number;
        activeMemories: number;
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
export declare function startCoralConsoleRun(options: CoralConsoleRunOptions): Promise<CoralConsoleRunSession>;
export declare function runCoralReview(options: CoralReviewRunOptions): Promise<CoralReviewRunResult>;
