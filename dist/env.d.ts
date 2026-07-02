export interface ModelConfig {
    provider: string;
    baseUrl: string;
    modelName: string;
    apiKey: string;
    maxTokens?: number;
}
export declare const defaultOpenRouterMaxTokens = 8000;
export declare function loadLocalEnv(cwd?: string): Record<string, string>;
export declare function parseModelMaxTokens(value: string | undefined, fallback?: number): number;
export declare function loadModelConfig(cwd?: string): ModelConfig;
