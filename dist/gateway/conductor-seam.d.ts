export interface GatewayRuntimeEvent {
    sequence: number;
    type: "gateway-started" | "graph-synced" | "gateway-stopping";
    occurredAt: string;
    projectKey: string;
    payload: Record<string, unknown>;
}
export interface FutureConductorAdapter {
    readonly id: string;
    start(context: {
        projectKey: string;
        subscribe: (listener: (event: GatewayRuntimeEvent) => void) => () => void;
    }): Promise<void>;
    stop(reason: "gateway-shutdown" | "adapter-error"): Promise<void>;
}
export interface GatewayEventBus {
    publish(event: Omit<GatewayRuntimeEvent, "sequence">): GatewayRuntimeEvent;
    subscribe(listener: (event: GatewayRuntimeEvent) => void): () => void;
}
export declare function createGatewayEventBus(maxQueuedEvents?: number): GatewayEventBus;
