import { type ActiveMemory, type ReviewPacket, type ReviewPacketLimits, type SourceDocument, type SourceSet, type SourceSpec, type TargetSurface } from "./types.ts";
export interface BuildReviewPacketOptions {
    sourceSpecs: SourceSpec[];
    targets: TargetSurface[];
    project: string;
    scope: string;
    intent: string;
    request: string | null;
    home?: string;
    memoryHome?: string;
    sourceLimit?: number;
    sourceCharLimit?: number;
    documentCharLimit?: number;
    activeMemoryLimit?: number;
    now?: Date;
}
export interface SourceInspectResult {
    ok: true;
    command: "sources inspect";
    sources: Array<{
        id: string;
        spec: SourceSpec;
        label: string;
        role: string;
        counts: {
            documents: number;
            activeMemories: number;
        };
        sampleDocuments: Array<{
            id: string;
            role: string;
            uri: string;
            textChars: number;
            metadata: Record<string, unknown>;
        }>;
        metadata: Record<string, unknown>;
    }>;
    counts: {
        sourceSets: number;
        documents: number;
        activeMemories: number;
    };
    warnings: string[];
}
export interface SourceCorpus {
    sourceSets: SourceSet[];
    documents: SourceDocument[];
    activeMemories: ActiveMemory[];
    warnings: string[];
}
export interface LoadSourceCorpusOptions {
    sourceSpecs: SourceSpec[];
    project: string;
    scope: string;
    home?: string;
    memoryHome?: string;
    sourceIndexes?: number[];
    limits: ReviewPacketLimits;
    now?: Date;
}
export declare function parseSourceSpec(raw: string): SourceSpec;
export declare function parseSourceSpecs(values: unknown, fallback?: string[]): SourceSpec[];
export declare function parseTargetSurface(raw: string): TargetSurface;
export declare function parseTargetSurfaces(values: unknown, fallback?: string[]): TargetSurface[];
export declare function toSourceChunks(documents: SourceDocument[], charLimit: number): unknown[];
export declare function activeMemoryHints(memories: ActiveMemory[], limit: number): unknown[];
export declare function buildReviewPacket(options: BuildReviewPacketOptions): Promise<ReviewPacket>;
export declare function loadSourceCorpus(options: LoadSourceCorpusOptions): Promise<SourceCorpus>;
export declare function inspectSources(options: Omit<BuildReviewPacketOptions, "targets" | "intent" | "request">): Promise<SourceInspectResult>;
