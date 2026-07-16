export declare const modelCatalogueSchemaVersion: "refinery.model-catalogue.v1";
export declare const modelSelectionSchemaVersion: "refinery.model-selection.v1";
export type ModelCompatibilityFamily = "openai-gpt" | "openai-reasoning" | "deepseek-v4" | "unknown";
export interface ModelCompatibility {
    supported: boolean;
    family: ModelCompatibilityFamily;
    reason: string | null;
}
export interface CoralModelRecord extends Record<string, unknown> {
    id: string;
}
export interface CoralModelCatalogue {
    schemaVersion: typeof modelCatalogueSchemaVersion;
    provider: "coral";
    endpoint: string;
    retrievedAt: string;
    status: number;
    models: CoralModelRecord[];
}
export interface PersistedModelSelection {
    schemaVersion: typeof modelSelectionSchemaVersion;
    provider: "coral";
    modelName: string;
    selectedAt: string;
    catalogueEndpoint: string;
}
export interface ResolvedModelSelection {
    modelName: string;
    source: "explicit" | "env:MODEL_NAME" | "env:REFINERY_MODEL_NAME" | "project:MODEL_NAME" | "project:REFINERY_MODEL_NAME" | "persisted" | "default";
    persisted: PersistedModelSelection | null;
}
type FetchLike = typeof fetch;
export declare function classifyModelCompatibility(modelName: string): ModelCompatibility;
export declare function parseCoralModelCatalogue(value: unknown): CoralModelRecord[];
export declare function fetchCoralModelCatalogue(args: {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    now?: Date;
}): Promise<CoralModelCatalogue>;
export declare function readPersistedModelSelection(options?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): PersistedModelSelection | null;
export declare function writePersistedModelSelection(args: {
    modelName: string;
    catalogueEndpoint: string;
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    now?: Date;
}): PersistedModelSelection;
export declare function resetPersistedModelSelection(options?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): {
    removed: boolean;
    path: string;
};
export declare function resolveModelSelection(args?: {
    explicit?: string;
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    localEnv?: Record<string, string | undefined>;
}): ResolvedModelSelection;
export declare function resolveCatalogueAccess(args?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): {
    apiKey: string;
    baseUrl: string;
    authSource: string;
};
export {};
