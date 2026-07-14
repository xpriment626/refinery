export type GraphNodeKind = "memory" | "source_document" | "session" | "skill" | "project" | "evidence";

export interface VisualNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  scope: string;
  sourceAdapter: string;
  hasUri: boolean;
}

export interface VisualEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  confidence: number;
}

export interface GraphSnapshot {
  ok: true;
  schemaVersion: "refinery.graph-visualization.v1";
  syncedAt: string;
  changeSequence: number;
  counts: { nodes: number; revisions: number; edges: number };
  nodes: VisualNode[];
  edges: VisualEdge[];
  truncated: { nodes: boolean; edges: boolean };
}

export interface GraphVisualizationDelta {
  ok: true;
  schemaVersion: "refinery.graph-visualization-delta.v1";
  afterSequence: number;
  sequence: number;
  syncedAt: string;
  counts: GraphSnapshot["counts"];
  resetRequired: boolean;
  hasMore: boolean;
  nodes: VisualNode[];
  edges: VisualEdge[];
  removedNodeIds: string[];
  removedEdgeIds: string[];
}

export interface GraphInspection {
  ok: true;
  node: VisualNode & { uri?: string | null; metadata?: Record<string, unknown> };
  revision: { id: string; content: string; indexedAt: string; sourceModifiedAt: string | null; charCount: number; contentTruncated?: boolean };
  incomingEdges: VisualEdge[];
  outgoingEdges: VisualEdge[];
  truncated: { incomingEdges: boolean; outgoingEdges: boolean };
}

export interface ResponsibilityPlan {
  id: string;
  generatedAt: string;
  seeds: Array<{ nodeId: string; score: number; reasons: string[] }>;
  selectedNodes: Array<{ nodeId: string; kind: GraphNodeKind; depth: number; seed: boolean; responsibilityUnitId: string }>;
  traversedEdges: Array<{ id: string; source: string; target: string; kind: string; confidence: number }>;
  responsibilityUnits: Array<{ id: string; label: string; kind: string; state: "awake" | "sleeping" | "deferred"; nodeIds: string[] }>;
  warnings: string[];
  budgetExhaustion: { nodes: boolean; edges: boolean; hops: boolean; chars: boolean; tokens: boolean };
}

export interface GatewayEvent {
  sequence: number;
  type: "gateway-started" | "graph-synced" | "gateway-stopping";
  occurredAt: string;
  projectKey: string;
  payload: Record<string, unknown>;
}
