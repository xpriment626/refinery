export declare const coralVerificationSchemaVersion: "refinery.coral-verification.v1";
export declare const defaultCoralCloudApiUrl = "https://api.coralcloud.ai";
export declare const defaultCoralModelBaseUrl = "https://llm.coralcloud.ai/openai/v1";
export interface CoralCredentialVerification {
    schemaVersion: typeof coralVerificationSchemaVersion;
    verified: true;
    verifiedAt: string;
    registry: {
        reachable: true;
        status: number;
        endpoint: string;
    };
    modelCatalogue: {
        reachable: true;
        status: number;
        endpoint: string;
        count: number;
        modelIds: string[];
        requestedModelName: string | null;
        requestedModelAvailable: boolean | null;
        modelName?: string;
        available?: boolean;
    };
}
type FetchLike = typeof fetch;
export declare function verifyCoralCredential(args: {
    apiKey: string;
    cloudApiUrl?: string;
    modelBaseUrl?: string;
    modelName?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    now?: Date;
}): Promise<CoralCredentialVerification>;
export {};
