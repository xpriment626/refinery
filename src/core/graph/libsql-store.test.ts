import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "libsql";
import { RefineryError } from "../errors.ts";
import {
  LibsqlGraphStore,
  graphDatabaseSchemaVersion,
} from "./libsql-store.ts";
import { syncMemoryGraph, type GraphSourceItem } from "./sync.ts";

const project = "/tmp/refinery-libsql-project";

function item(sourceKey: string, content: string): GraphSourceItem {
  return {
    sourceAdapter: "test",
    sourceKey,
    kind: "memory",
    scope: "project",
    project,
    label: sourceKey,
    content,
    uri: `memory://${sourceKey}`,
    metadata: { sourcePath: "MEMORY.md" },
  };
}

test("embedded libSQL store migrates, round-trips deterministic graph state, and restricts file permissions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-libsql-store-"));
  const databasePath = path.join(home, "private", "memory-graph.db");
  const store = new LibsqlGraphStore(databasePath);

  const synced = syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:memories"],
    items: [item("memory:one", "A durable responsibility memory.")],
    edges: [],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  assert.deepEqual(store.read(), synced.index);
  assert.equal(store.diagnostics().schemaVersion, graphDatabaseSchemaVersion);
  assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(databasePath)).mode & 0o777, 0o700);

  const database = new Database(databasePath, { readonly: true });
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
  database.close();
  assert.equal(indexes.some(({ name }) => name === "graph_edges_source_idx"), true);
  assert.equal(indexes.some(({ name }) => name === "graph_edges_target_idx"), true);
  assert.equal(indexes.some(({ name }) => name === "graph_nodes_source_key_idx"), true);

  store.close();
  assert.deepEqual(store.read(), synced.index);
});

test("embedded libSQL store imports a valid legacy JSON graph exactly once", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-libsql-import-"));
  const legacyPath = path.join(home, "memory-graph.json");
  const databasePath = path.join(home, "memory-graph.db");
  const memoryStore = new LibsqlGraphStore(":memory:");
  const index = syncMemoryGraph({
    store: memoryStore,
    project,
    sourceSpecs: ["test:legacy"],
    items: [item("memory:legacy", "Legacy JSON graph content.")],
    edges: [],
    now: new Date("2026-07-11T00:00:00.000Z"),
  }).index;
  fs.writeFileSync(legacyPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });

  const imported = new LibsqlGraphStore(databasePath, { legacyJsonPath: legacyPath });
  assert.deepEqual(imported.read(), index);
  assert.equal(imported.diagnostics().legacyImported, true);

  fs.writeFileSync(legacyPath, "not valid JSON", { mode: 0o600 });
  assert.deepEqual(new LibsqlGraphStore(databasePath, { legacyJsonPath: legacyPath }).read(), index);
});

test("embedded libSQL store fails closed on corrupt database files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-libsql-corrupt-"));
  const databasePath = path.join(home, "memory-graph.db");
  fs.writeFileSync(databasePath, "not a database", { mode: 0o600 });

  assert.throws(
    () => new LibsqlGraphStore(databasePath).read(),
    (error: unknown) => error instanceof RefineryError && error.code === "GRAPH_INDEX_INVALID",
  );
});

test("embedded libSQL store rejects databases created by a newer schema", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-libsql-newer-"));
  const databasePath = path.join(home, "memory-graph.db");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE graph_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  database.prepare("INSERT INTO graph_migrations(version, applied_at) VALUES (?, ?)").run(999, "2026-07-11T00:00:00.000Z");
  database.close();

  assert.throws(
    () => new LibsqlGraphStore(databasePath).diagnostics(),
    (error: unknown) => error instanceof RefineryError && error.code === "GRAPH_SCHEMA_UNSUPPORTED",
  );
});

test("embedded libSQL store journals bounded deterministic sync deltas", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-libsql-events-"));
  const store = new LibsqlGraphStore(path.join(home, "memory-graph.db"));
  const first = syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:events"],
    items: [item("memory:one", "First body"), item("memory:two", "Second body")],
    edges: [],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const second = syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:events"],
    items: [item("memory:one", "Changed body")],
    edges: [],
    now: new Date("2026-07-12T00:00:00.000Z"),
  });

  assert.equal(first.delta.createdNodeIds.length, 2);
  assert.equal(second.delta.updatedNodeIds.length, 1);
  assert.equal(second.delta.removedNodeIds.length, 1);
  const events = store.readChanges({ afterSequence: 0, limit: 10 });
  assert.equal(events.length, 2);
  assert.equal(events[0]?.sequence, 1);
  assert.deepEqual(events[1]?.delta, second.delta);
  assert.equal(store.diagnostics().changeSequence, 2);
});

test("embedded libSQL store materializes bounded visualization deltas", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-libsql-visual-delta-"));
  const store = new LibsqlGraphStore(path.join(home, "memory-graph.db"));
  const edge = (confidence: number) => ({
    sourceAdapter: "test",
    sourceKey: "memory:one",
    targetAdapter: "test",
    targetKey: "memory:two",
    kind: "SUPPORTS" as const,
    confidence,
    derivation: "visual-delta-test",
  });
  syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:delta"],
    items: [item("memory:one", "First body"), item("memory:two", "Second body")],
    edges: [edge(0.6)],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const second = syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:delta"],
    items: [item("memory:one", "First body"), item("memory:two", "Second body")],
    edges: [edge(0.95)],
    now: new Date("2026-07-12T00:00:00.000Z"),
  });

  const delta = store.readVisualizationDelta({ afterSequence: 1, maxEvents: 10 });
  assert.equal(delta.schemaVersion, "refinery.graph-visualization-delta.v1");
  assert.equal(delta.afterSequence, 1);
  assert.equal(delta.sequence, 2);
  assert.equal(delta.resetRequired, false);
  assert.equal(delta.hasMore, false);
  assert.deepEqual(delta.nodes, []);
  assert.deepEqual(delta.removedNodeIds, []);
  assert.deepEqual(delta.removedEdgeIds, []);
  assert.equal(delta.edges.length, 1);
  assert.equal(delta.edges[0]?.id, second.index.edges[0]?.id);
  assert.equal(delta.edges[0]?.confidence, 0.95);
  assert.deepEqual(delta.counts, { nodes: 2, revisions: 2, edges: 1 });

  const oversized = store.readVisualizationDelta({ afterSequence: 0, maxEvents: 10, maxNodeChanges: 1 });
  assert.equal(oversized.resetRequired, true);
  assert.equal(oversized.sequence, 2);
  assert.deepEqual(oversized.nodes, []);
  assert.deepEqual(oversized.edges, []);
});

test("embedded libSQL store serves node and adjacency reads from bounded indexed primitives", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-libsql-query-"));
  const store = new LibsqlGraphStore(path.join(home, "memory-graph.db"));
  syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:query"],
    items: [item("memory:one", "First query body"), item("memory:two", "Second query body")],
    edges: [{
      sourceAdapter: "test",
      sourceKey: "memory:one",
      targetAdapter: "test",
      targetKey: "memory:two",
      kind: "SUPPORTS",
      confidence: 0.9,
      derivation: "query-test",
    }],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  const found = store.findCurrentNode("memory:one");
  assert.ok(found);
  assert.equal(found.node.sourceKey, "memory:one");
  assert.match(found.revision.content, /First query body/);
  const adjacency = store.readAdjacentEdges({
    nodeId: found.node.id,
    direction: "both",
    edgeKinds: ["SUPPORTS"],
    minConfidence: 0.8,
    limit: 10,
  });
  assert.equal(adjacency.truncated, false);
  assert.equal(adjacency.edges.length, 1);
  assert.equal(adjacency.edges[0]?.kind, "SUPPORTS");
  const candidates = store.searchNodeIds({
    request: "Second query body",
    project,
    scope: "project",
    limit: 10,
  });
  assert.equal(candidates[0], store.findCurrentNode("memory:two")?.node.id);
  const metadata = store.readMetadata();
  assert.ok(metadata);
  assert.equal(metadata.project, project);
  assert.deepEqual(metadata.counts, { nodes: 2, revisions: 2, edges: 1 });
});
