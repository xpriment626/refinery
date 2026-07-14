import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  JsonGraphStore,
  memoryGraphIndexerVersion,
  memoryGraphSchemaVersion,
  syncMemoryGraph,
  type GraphSourceItem,
} from "./sync.ts";

function sourceItem(content: string): GraphSourceItem {
  return {
    sourceAdapter: "test",
    sourceKey: "memory:stable-key",
    kind: "memory",
    scope: "project",
    project: "/tmp/refinery-project",
    label: "Stable memory",
    content,
    uri: "memory://stable-key",
    metadata: { sourcePath: "MEMORY.md", line: 10 },
  };
}

function documentItem(): GraphSourceItem {
  return {
    sourceAdapter: "test",
    sourceKey: "document:MEMORY.md",
    kind: "source_document",
    scope: "project",
    project: "/tmp/refinery-project",
    label: "MEMORY.md",
    content: "# Project memory",
    uri: "file:///tmp/memories/MEMORY.md",
    metadata: { sourcePath: "MEMORY.md" },
  };
}

test("unchanged graph sources keep stable node and revision identities", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-sync-"));
  const graphPath = path.join(home, "graph.json");
  const store = new JsonGraphStore(graphPath);

  const first = syncMemoryGraph({
    store,
    project: "/tmp/refinery-project",
    sourceSpecs: ["test:memories"],
    items: [sourceItem("Refinery keeps canonical memory outside its graph.")],
    edges: [],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const second = syncMemoryGraph({
    store,
    project: "/tmp/refinery-project",
    sourceSpecs: ["test:memories"],
    items: [sourceItem("Refinery keeps canonical memory outside its graph.")],
    edges: [],
    now: new Date("2026-07-12T00:00:00.000Z"),
  });

  assert.equal(first.index.schemaVersion, memoryGraphSchemaVersion);
  assert.equal(first.index.indexerVersion, memoryGraphIndexerVersion);
  assert.equal(first.summary.createdNodes, 1);
  assert.equal(first.summary.createdRevisions, 1);
  assert.equal(second.summary.createdNodes, 0);
  assert.equal(second.summary.createdRevisions, 0);
  assert.equal(second.summary.unchangedNodes, 1);
  assert.equal(second.index.nodes[0]?.id, first.index.nodes[0]?.id);
  assert.equal(second.index.nodes[0]?.currentRevisionId, first.index.nodes[0]?.currentRevisionId);
  assert.equal(second.index.revisions.length, 1);
  assert.equal(fs.statSync(graphPath).mode & 0o777, 0o600);
});

test("changed sources replace revision-owned edges instead of retaining stale edges", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-edge-"));
  const store = new JsonGraphStore(path.join(home, "graph.json"));
  const edge = {
    sourceAdapter: "test",
    sourceKey: "memory:stable-key",
    targetAdapter: "test",
    targetKey: "document:MEMORY.md",
    kind: "DERIVED_FROM" as const,
    confidence: 1,
    derivation: "test-source-reference",
    evidenceRefs: [{ sourcePath: "MEMORY.md", line: 10 }],
  };

  const first = syncMemoryGraph({
    store,
    project: "/tmp/refinery-project",
    sourceSpecs: ["test:memories"],
    items: [sourceItem("Old memory body."), documentItem()],
    edges: [edge],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const oldRevisionId = first.index.nodes.find((node) => node.kind === "memory")?.currentRevisionId;
  const oldEdgeId = first.index.edges[0]?.id;

  const second = syncMemoryGraph({
    store,
    project: "/tmp/refinery-project",
    sourceSpecs: ["test:memories"],
    items: [sourceItem("New memory body."), documentItem()],
    edges: [edge],
    now: new Date("2026-07-12T00:00:00.000Z"),
  });
  const currentMemory = second.index.nodes.find((node) => node.kind === "memory");

  assert.equal(first.index.edges.length, 1);
  assert.equal(first.index.edges[0]?.sourceRevisionId, oldRevisionId);
  assert.equal(second.summary.updatedNodes, 1);
  assert.notEqual(currentMemory?.currentRevisionId, oldRevisionId);
  assert.equal(second.index.edges.length, 1);
  assert.equal(second.index.edges[0]?.sourceRevisionId, currentMemory?.currentRevisionId);
  assert.notEqual(second.index.edges[0]?.id, oldEdgeId);
  assert.equal(second.index.edges.some((candidate) => candidate.sourceRevisionId === oldRevisionId), false);
});

test("same-identity edge attribute changes are reported as updates", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-edge-update-"));
  const store = new JsonGraphStore(path.join(home, "graph.json"));
  const syncWithConfidence = (confidence: number, day: number) => syncMemoryGraph({
    store,
    project: "/tmp/refinery-project",
    sourceSpecs: ["test:memories"],
    items: [sourceItem("Stable body."), documentItem()],
    edges: [{
      sourceAdapter: "test",
      sourceKey: "memory:stable-key",
      targetAdapter: "test",
      targetKey: "document:MEMORY.md",
      kind: "DERIVED_FROM",
      confidence,
      derivation: "test-source-reference",
    }],
    now: new Date(`2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`),
  });

  const first = syncWithConfidence(0.7, 11);
  const second = syncWithConfidence(0.9, 12);

  assert.equal(first.index.edges[0]?.id, second.index.edges[0]?.id);
  assert.deepEqual(second.delta.createdEdgeIds, []);
  assert.deepEqual(second.delta.removedEdgeIds, []);
  assert.deepEqual(second.delta.updatedEdgeIds, [second.index.edges[0]?.id]);
  assert.equal(second.summary.updatedEdges, 1);
});

test("deleted sources remove their nodes, revisions, and incident edges from the retrievable index", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-delete-"));
  const store = new JsonGraphStore(path.join(home, "graph.json"));
  const first = syncMemoryGraph({
    store,
    project: "/tmp/refinery-project",
    sourceSpecs: ["test:memories"],
    items: [sourceItem("Memory that will be deleted."), documentItem()],
    edges: [{
      sourceAdapter: "test",
      sourceKey: "memory:stable-key",
      targetAdapter: "test",
      targetKey: "document:MEMORY.md",
      kind: "DERIVED_FROM",
      confidence: 1,
      derivation: "test-source-reference",
    }],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const deletedNode = first.index.nodes.find((node) => node.kind === "memory");
  assert.ok(deletedNode);

  const second = syncMemoryGraph({
    store,
    project: "/tmp/refinery-project",
    sourceSpecs: ["test:memories"],
    items: [documentItem()],
    edges: [],
    now: new Date("2026-07-12T00:00:00.000Z"),
  });

  assert.equal(second.summary.removedNodes, 1);
  assert.equal(second.summary.removedRevisions, 1);
  assert.equal(second.summary.removedEdges, 1);
  assert.equal(second.index.nodes.some((node) => node.id === deletedNode.id), false);
  assert.equal(second.index.revisions.some((revision) => revision.nodeId === deletedNode.id), false);
  assert.equal(second.index.edges.some((edge) => edge.sourceNodeId === deletedNode.id || edge.targetNodeId === deletedNode.id), false);
  assert.deepEqual(store.read(), second.index);
});
