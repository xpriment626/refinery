import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type CoralRuntimeCapabilities } from "./client.ts";
import { type CoralCommunicationProjection, type ReviewTopology } from "./topology.ts";
import { refineryReviewSchemaVersion, type ReviewPacket, type SkillCandidateArtifact } from "../core/types.ts";
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
    coralRuntimeJar?: string;
    coralJar?: string;
    timeoutMs?: number;
    modelName?: string;
    modelBaseUrl?: string;
    reasoningEffort?: string;
    maxTurns?: string;
    llmProxy?: boolean;
    modelProxyProvider?: string;
    topology?: ReviewTopology;
    modelHome?: string;
    modelCwd?: string;
}
export interface CoralReviewRunOptions {
    packet: ReviewPacket;
    runId: string;
    outputDir: string;
    hypothesis?: string;
    sink?: ReviewSinkOptions;
    coral?: CoralReviewRuntimeOptions;
}
interface CoralUsageSummary {
    callCount: number;
    status200Count: number;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    promptChars: number;
    usageComplete: boolean;
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
        model?: {
            name: string;
            transport: "direct" | "coral-server-proxy";
            proxyProvider: string | null;
        };
        runtimeCapabilities?: CoralRuntimeCapabilities;
        runtimeProjection?: CoralCommunicationProjection;
        usage?: CoralUsageSummary;
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
        model: {
            name: string;
            transport: "direct" | "coral-server-proxy";
            proxyProvider: string | null;
        };
        runtimeCapabilities: CoralRuntimeCapabilities;
        runtimeProjection: CoralCommunicationProjection;
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
export declare function buildReviewIntake(args: {
    runId: string;
    packet: ReviewPacket;
    intent: ReviewIntent;
    request: string | null;
    topology: ReviewTopology;
    runtimeProjection?: CoralCommunicationProjection;
}): Record<string, unknown>;
export declare function validateCoralDecisionContract(args: {
    sourceChunks: unknown[];
    typedCandidates: unknown[];
    proposals: Array<{
        action: string;
        sourceRefs: unknown[];
    }>;
}): void;
export declare function redactCoralLogText(text: string, secrets?: string[]): string;
export declare function reserveLoopbackPort(): Promise<number>;
interface RuntimeCoralConfigOptions {
    modernAgents?: boolean;
    coralCloudProxy?: boolean;
    deepSeekProxy?: boolean;
    port?: number;
    authKey?: string;
}
export declare function resolveRuntimeCoralConfigPath(configPath: string, options?: RuntimeCoralConfigOptions): string;
export declare function cleanupRuntimeCoralConfigPath(configPath: string): void;
export declare function selectCoralServerSecretEnv(model: {
    transport: "direct" | "coral-server-proxy";
    proxyProvider: string | null;
}, secrets: {
    coralApiKey: string;
    deepSeekApiKey: string;
}): Record<string, string>;
export declare function startCoralConsoleRun(options: CoralConsoleRunOptions): Promise<CoralConsoleRunSession>;
export declare function runCoralReview(options: CoralReviewRunOptions): Promise<CoralReviewRunResult>;
export {};
