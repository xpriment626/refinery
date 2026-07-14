import type { ActiveMemory } from "../core/types.ts";
export interface CodexMemorySourceDocument {
    id: string;
    role: string;
    relPath: string;
    absPath: string;
    text: string;
    refs: unknown[];
    metadata: Record<string, unknown>;
}
export declare function resolveCodexMemoryHome(memoryHome?: string): string;
export declare function listCodexMemorySourceDocuments(options?: {
    memoryHome?: string;
    limit?: number;
    maxChars?: number;
}): CodexMemorySourceDocument[];
export declare function listCodexActiveMemories(options?: {
    memoryHome?: string;
    limit?: number;
}): ActiveMemory[];
