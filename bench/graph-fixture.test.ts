import assert from "node:assert/strict";
import test from "node:test";
import { createDeterministicGraphFixture, createDeterministicGraphMutation } from "./graph-fixture.ts";

test("graph benchmark fixtures are deterministic and preserve requested density", () => {
  const first = createDeterministicGraphFixture({ nodes: 1_000, edges: 4_000 });
  const second = createDeterministicGraphFixture({ nodes: 1_000, edges: 4_000 });

  assert.deepEqual(second, first);
  assert.equal(first.nodes.length, 1_000);
  assert.equal(first.revisions.length, 1_000);
  assert.equal(first.edges.length, 4_000);
  assert.equal(new Set(first.nodes.map((node) => node.id)).size, 1_000);
  assert.equal(new Set(first.edges.map((edge) => edge.id)).size, 4_000);
  assert.equal(first.edges.every((edge) => edge.sourceRevisionId === first.nodes.find((node) => node.id === edge.sourceNodeId)?.currentRevisionId), true);
});

test("graph mutation fixture changes exactly the requested nodes and edges", () => {
  const base = createDeterministicGraphFixture({ nodes: 1_000, edges: 4_000 });
  const mutated = createDeterministicGraphMutation(base, { updatedNodes: 500, createdEdges: 2_000 });

  assert.equal(mutated.nodes.length, base.nodes.length);
  assert.equal(mutated.edges.length, base.edges.length + 2_000);
  assert.equal(mutated.nodes.filter((node, index) => node.label !== base.nodes[index]?.label).length, 500);
  assert.deepEqual(mutated.edges.slice(0, base.edges.length), base.edges);
});
