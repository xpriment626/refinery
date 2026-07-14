export declare const gatewayStateSchemaVersion: "refinery.gateway-state.v1";
export interface GatewayState {
    schemaVersion: typeof gatewayStateSchemaVersion;
    instanceId: string;
    pid: number;
    host: "127.0.0.1";
    port: number;
    startedAt: string;
    project: string;
    projectKey: string;
    capability: string;
}
export interface GatewayPublicState {
    schemaVersion: typeof gatewayStateSchemaVersion;
    instanceId: string;
    pid: number;
    host: "127.0.0.1";
    port: number;
    startedAt: string;
    projectKey: string;
    projectLabel: string;
}
export interface GatewayLifecycleResult {
    running: boolean;
    stale: boolean;
    alreadyRunning?: boolean;
    staleRecovered?: boolean;
    publicState: GatewayPublicState | null;
    uiUrl: string | null;
}
export declare function buildGatewayEnvironment(environment?: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string>;
export declare function gatewayStatus(options: {
    home?: string;
    project: string;
}): Promise<GatewayLifecycleResult>;
export declare function startGateway(options: {
    home?: string;
    project: string;
    port?: number;
}): Promise<GatewayLifecycleResult>;
export declare function stopGateway(options: {
    home?: string;
    project: string;
}): Promise<GatewayLifecycleResult>;
export declare function notifyGatewayGraphSync(options: {
    home?: string;
    project: string;
    payload: Record<string, unknown>;
}): Promise<boolean>;
