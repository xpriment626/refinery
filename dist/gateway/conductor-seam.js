export function createGatewayEventBus(maxQueuedEvents = 1_000) {
    const listeners = new Set();
    const recent = [];
    let sequence = 0;
    return {
        publish(input) {
            const event = { ...input, sequence: ++sequence };
            recent.push(event);
            if (recent.length > maxQueuedEvents)
                recent.splice(0, recent.length - maxQueuedEvents);
            for (const listener of listeners)
                listener(event);
            return event;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
//# sourceMappingURL=conductor-seam.js.map