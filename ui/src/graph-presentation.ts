interface EdgeIdentity {
  id: string;
}

export function sampleContextEdgeIds(edges: EdgeIdentity[], limit: number): Set<string> {
  const boundedLimit = Math.max(0, Math.min(edges.length, Math.floor(limit)));
  if (boundedLimit === 0) return new Set();
  if (boundedLimit === edges.length) return new Set(edges.map((edge) => edge.id));
  const selected = new Set<string>();
  const step = edges.length / boundedLimit;
  for (let index = 0; index < boundedLimit; index += 1) {
    selected.add(edges[Math.floor(index * step)]!.id);
  }
  return selected;
}
