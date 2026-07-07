import { type ModelConfig } from "../env.ts";
export interface ModelCallMetadata {
    provider: string;
    baseUrl: string;
    modelName: string;
    status: number;
    responseId: string | null;
    responseModel: string | null;
    finishReason: string | null;
    usage: unknown;
}
export declare function callCoralChatWithMetadata(request: {
    model: ModelConfig;
    system: string;
    user: string;
}): Promise<{
    content: string;
    metadata: ModelCallMetadata;
}>;
