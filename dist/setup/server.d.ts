import http from "node:http";
import { provisionCoralRuntime } from "../coral/runtime.ts";
export declare const setupProtocolVersion: "refinery.setup-gateway.v1";
export interface SetupServerOptions {
    home?: string;
    project: string;
    codexHome?: string;
    capabilityHash: string;
    instanceId: string;
    expiresAt: string;
    port?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    shutdownAfterComplete?: boolean;
    onListening?: (address: {
        host: "127.0.0.1";
        port: number;
        pid: number;
    }) => void;
    onClosed?: () => void;
    provisionRuntime?: typeof provisionCoralRuntime;
}
export interface RunningSetupServer {
    server: http.Server;
    baseUrl: string;
    close: () => Promise<void>;
}
export declare function startSetupHttpServer(options: SetupServerOptions): Promise<RunningSetupServer>;
export declare function setupCapabilityHash(capability: string): string;
