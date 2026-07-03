import { type ModelConfig } from "../env.ts";
import type { SpecialistName } from "../core/specialists/types.ts";
import { type ModelCallMetadata } from "../core/model-client.ts";
interface WorkerModelConfig extends ModelConfig {
    modelName: string;
    baseUrl: string;
    reasoningEffort: string;
    apiKeyPresent: boolean;
}
type WorkerModelCaller = (request: {
    model: ModelConfig;
    system: string;
    user: string;
}) => Promise<{
    content: string;
    metadata?: ModelCallMetadata;
}>;
export declare function loadWorkerModelConfig(cwd?: string): WorkerModelConfig;
export declare function isCoralWaitTimeout(error: unknown): boolean;
export declare function expectedReviewAgent(envelope: Record<string, unknown>, senderName: string): string | null;
export declare function buildLiveReviewEnvelope(args: {
    specialistName: SpecialistName;
    agentName: string;
    envelope: Record<string, unknown>;
    message: {
        id: string;
        senderName: string;
        mentionNames: string[];
        threadId: string;
    };
    model: WorkerModelConfig;
    callModel?: WorkerModelCaller;
}): Promise<Record<string, unknown>>;
export {};
