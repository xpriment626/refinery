import type { GatewayEvent, GraphInspection, GraphSnapshot, GraphVisualizationDelta, ResponsibilityPlan } from "./types.ts";

interface ApiErrorShape {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export class GatewayApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorShape) {
    super(body.error?.message ?? `Gateway request failed with status ${status}`);
    this.name = "GatewayApiError";
    this.code = body.error?.code ?? "GATEWAY_REQUEST_FAILED";
    this.status = status;
    this.details = body.error?.details;
  }
}

export class GatewayApi {
  constructor(readonly capability: string) {}

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(pathname, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.capability}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await response.json() as T & ApiErrorShape;
    if (!response.ok) throw new GatewayApiError(response.status, body);
    return body;
  }

  health(): Promise<{ ok: true; project: { key: string; label: string }; uptimeSeconds: number }> {
    return this.request("/api/v1/health");
  }

  status(): Promise<{ ok: true; exists: boolean; syncedAt: string | null; counts: GraphSnapshot["counts"]; project: { key: string; label: string } }> {
    return this.request("/api/v1/graph/status");
  }

  snapshot(): Promise<GraphSnapshot> {
    return this.request("/api/v1/graph/snapshot?maxNodes=25000&maxEdges=4000");
  }

  delta(afterSequence: number): Promise<GraphVisualizationDelta> {
    return this.request(`/api/v1/graph/delta?after=${encodeURIComponent(afterSequence)}`);
  }

  inspect(nodeId: string): Promise<GraphInspection> {
    return this.request(`/api/v1/graph/node/${encodeURIComponent(nodeId)}`);
  }

  async plan(request: string): Promise<{ plan: ResponsibilityPlan; retrieval: { candidateNodes: number; hydratedNodes: number; hydratedEdges: number } }> {
    return this.request("/api/v1/graph/plan", { method: "POST", body: JSON.stringify({ request }) });
  }

  async streamEvents(onEvent: (event: GatewayEvent) => void, signal: AbortSignal, onConnected?: () => void): Promise<void> {
    const response = await fetch("/api/v1/events", {
      headers: { Authorization: `Bearer ${this.capability}`, Accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({})) as ApiErrorShape;
      throw new GatewayApiError(response.status, body);
    }
    onConnected?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventName = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (eventName && eventName !== "connected" && data) onEvent(JSON.parse(data) as GatewayEvent);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }
}
