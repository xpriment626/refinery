import type { MemoryStoreAdapter } from "../core/adapter.ts";
export interface CodexMemoryAdapterOptions {
    memoryHome?: string;
}
export declare function resolveCodexMemoryHome(memoryHome?: string): string;
export declare function createCodexMemoryAdapter(options?: CodexMemoryAdapterOptions): MemoryStoreAdapter;
