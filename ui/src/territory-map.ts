import type { GraphNodeKind } from "./types.ts";

export interface TerritoryDefinition {
  kind: GraphNodeKind;
  label: string;
  color: string;
  angle: number;
  xPercent: number;
  yPercent: number;
}

const rawDefinitions: Array<Omit<TerritoryDefinition, "xPercent" | "yPercent">> = [
  { kind: "memory", label: "Memory", color: "#315cff", angle: -Math.PI * 5 / 6 },
  { kind: "source_document", label: "Sources", color: "#6f7c86", angle: -Math.PI / 2 },
  { kind: "evidence", label: "Evidence", color: "#d28a45", angle: -Math.PI / 6 },
  { kind: "project", label: "Project", color: "#2e6574", angle: Math.PI / 6 },
  { kind: "skill", label: "Skills", color: "#765886", angle: Math.PI / 2 },
  { kind: "session", label: "Sessions", color: "#5d8a72", angle: Math.PI * 5 / 6 },
];

export const territoryDefinitions: TerritoryDefinition[] = rawDefinitions.map((definition) => ({
  ...definition,
  xPercent: 50 + Math.cos(definition.angle) * 28,
  yPercent: 50 - Math.sin(definition.angle) * 28,
}));

const byKind = new Map(territoryDefinitions.map((definition) => [definition.kind, definition]));

function hashId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

export function positionForTerritoryNode(id: string, kind: GraphNodeKind): { x: number; y: number } {
  const hash = hashId(id);
  const definition = byKind.get(kind) ?? territoryDefinitions[0]!;
  const angularJitter = (((hash >>> 4) & 4095) / 4095 - 0.5) * 0.72;
  const radius = 0.28 + ((hash >>> 16) & 4095) / 4095 * 0.72;
  const angle = definition.angle + angularJitter;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function summarizeTerritories(nodes: Array<{ kind: GraphNodeKind }>): Array<TerritoryDefinition & { count: number }> {
  const counts = new Map<GraphNodeKind, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return territoryDefinitions.map((definition) => ({ ...definition, count: counts.get(definition.kind) ?? 0 }));
}
