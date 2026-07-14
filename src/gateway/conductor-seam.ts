export interface GatewayRuntimeEvent {
  sequence: number;
  type: "gateway-started" | "graph-synced" | "gateway-stopping";
  occurredAt: string;
  projectKey: string;
  payload: Record<string, unknown>;
}

export interface FutureConductorAdapter {
  readonly id: string;
  start(context: { projectKey: string; subscribe: (listener: (event: GatewayRuntimeEvent) => void) => () => void }): Promise<void>;
  stop(reason: "gateway-shutdown" | "adapter-error"): Promise<void>;
}

export interface GatewayEventBus {
  publish(event: Omit<GatewayRuntimeEvent, "sequence">): GatewayRuntimeEvent;
  subscribe(listener: (event: GatewayRuntimeEvent) => void): () => void;
}

export function createGatewayEventBus(maxQueuedEvents = 1_000): GatewayEventBus {
  const listeners = new Set<(event: GatewayRuntimeEvent) => void>();
  const recent: GatewayRuntimeEvent[] = [];
  let sequence = 0;
  return {
    publish(input) {
      const event = { ...input, sequence: ++sequence };
      recent.push(event);
      if (recent.length > maxQueuedEvents) recent.splice(0, recent.length - maxQueuedEvents);
      for (const listener of listeners) listener(event);
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
