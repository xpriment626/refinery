import { type ModelConfig } from "../env.ts";
export interface OpenRouterCallMetadata {
    provider: "openrouter";
    baseUrl: string;
    modelName: string;
    status: number;
    responseId: string | null;
    responseModel: string | null;
    finishReason: string | null;
    usage: unknown;
}
export declare function callOpenRouterChatWithMetadata(request: {
    model: ModelConfig;
    system: string;
    user: string;
}): Promise<{
    content: string;
    metadata: OpenRouterCallMetadata;
}>;
