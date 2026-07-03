export interface ModelConfig {
    provider: string;
    baseUrl: string;
    modelName: string;
    apiKey: string;
    maxTokens?: number;
}
export declare const defaultModelMaxTokens = 8000;
export declare const defaultModelProvider = "coral";
export declare const defaultModelBaseUrl = "https://llm.coralcloud.ai/deepseek/v1";
export declare const defaultModelName = "deepseek-v4-pro";
export declare function loadLocalEnv(cwd?: string): Record<string, string>;
export declare function parseModelMaxTokens(value: string | undefined, fallback?: number): number;
export declare function loadModelConfig(cwd?: string): ModelConfig;
