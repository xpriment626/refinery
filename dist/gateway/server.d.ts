import { type GatewayEventBus } from "./conductor-seam.ts";
export interface GatewayListenAddress {
    host: "127.0.0.1";
    port: number;
}
export interface GatewayServer {
    listen(port?: number): Promise<GatewayListenAddress>;
    close(): Promise<void>;
    readonly events: GatewayEventBus;
}
export interface CreateGatewayServerOptions {
    home: string;
    project: string;
    capability: string;
    staticDir?: string;
    onShutdown?: () => void | Promise<void>;
}
export declare function createGatewayServer(options: CreateGatewayServerOptions): GatewayServer;
