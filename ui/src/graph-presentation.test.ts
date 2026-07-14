import assert from "node:assert/strict";
import test from "node:test";
import { sampleContextEdgeIds } from "./graph-presentation.ts";

test("context-edge sampling is deterministic, bounded, and spans the graph", () => {
  const edges = Array.from({ length: 4_000 }, (_, index) => ({ id: `edge-${String(index).padStart(4, "0")}` }));
  const selected = sampleContextEdgeIds(edges, 600);

  assert.equal(selected.size, 600);
  assert.deepEqual(selected, sampleContextEdgeIds(edges, 600));
  assert.equal(selected.has("edge-0000"), true);
  assert.equal([...selected].some((id) => id >= "edge-3900"), true);
  assert.equal(sampleContextEdgeIds(edges, 10_000).size, edges.length);
  assert.equal(sampleContextEdgeIds(edges, 0).size, 0);
});
