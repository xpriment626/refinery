export interface ModelConfig {
    provider: "coral";
    baseUrl: string;
    modelName: string;
    apiKey: string;
    maxTokens?: number;
}
export declare const defaultModelMaxTokens = 8000;
export declare const defaultModelBaseUrl = "https://llm.coralcloud.ai/openai/v1";
export declare const defaultModelName = "gpt-5.4-nano";
export declare function loadLocalEnv(cwd?: string): Record<string, string>;
export declare function parseModelMaxTokens(value: string | undefined, fallback?: number): number;
export declare function loadModelConfig(cwd?: string): ModelConfig;
