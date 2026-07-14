import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReviewPacket, parseSourceSpec } from "../packets.ts";
import { RefineryError } from "../errors.ts";
import {
  getMemoryGraphNeighbors,
  getMemoryGraphStatus,
  inspectMemoryGraphNode,
  planMemoryGraph,
  prepareGraphReviewPacket,
  syncCodexMemoryGraph,
} from "./service.ts";
import { LibsqlGraphStore } from "./libsql-store.ts";
import { syncMemoryGraph } from "./sync.ts";

test("Codex graph service builds and inspects a project-scoped rebuildable index", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-service-"));
  const project = path.join(tmp, "project");
  const memoryHome = path.join(tmp, "memories");
  const graphPath = path.join(tmp, "state", "memory-graph.db");
  fs.mkdirSync(memoryHome, { recursive: true });
  fs.writeFileSync(path.join(memoryHome, "MEMORY.md"), [
    "# Task Group: graph service",
    "",
    `applies_to: cwd=${project}`,
    "",
    "## Reusable knowledge",
    "",
    "- Refinery graph indexes are derived and rebuildable.",
  ].join("\n"));

  const synced = await syncCodexMemoryGraph({
    project,
    graphPath,
    memoryHome,
    sourceSpecs: [parseSourceSpec("codex:memories")],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  const memoryNode = synced.index.nodes.find((node) => node.kind === "memory");
  assert.ok(memoryNode);
  assert.equal(memoryNode.project, path.resolve(project));
  assert.equal(synced.graphPath, path.resolve(graphPath));
  assert.equal(synced.canonicalSourcesMutated, false);
  assert.equal(fs.readFileSync(graphPath).subarray(0, 16).toString("utf8"), "SQLite format 3\0");

  const status = getMemoryGraphStatus({ graphPath, project });
  assert.equal(status.exists, true);
  assert.equal(status.counts.nodes, synced.index.nodes.length);
  assert.equal(status.sourceSpecs.includes("codex:memories"), true);

  const inspected = inspectMemoryGraphNode({ graphPath, project, nodeId: memoryNode.id });
  assert.equal(inspected.node.id, memoryNode.id);
  assert.equal(inspected.revision.id, memoryNode.currentRevisionId);
  assert.match(inspected.revision.content, /derived and rebuildable/);
});

test("graph review preparation selects packet context without mutating canonical Codex sources", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-review-"));
  const project = path.join(tmp, "project");
  const memoryHome = path.join(tmp, "memories");
  const memoryPath = path.join(memoryHome, "MEMORY.md");
  fs.mkdirSync(memoryHome, { recursive: true });
  fs.writeFileSync(memoryPath, [
    "# Task Group: graph review",
    "",
    `applies_to: cwd=${project}`,
    "",
    "## Reusable knowledge",
    "",
    "- Responsibility graph review remains proposal-only.",
  ].join("\n"));
  const original = fs.readFileSync(memoryPath);
  const sourceSpecs = [parseSourceSpec("codex:memories")];
  const packet = await buildReviewPacket({
    sourceSpecs,
    targets: ["codex:memories"],
    project,
    scope: "project",
    intent: "general-review",
    request: "responsibility graph proposal-only review",
    memoryHome,
  });

  const prepared = await prepareGraphReviewPacket({
    packet,
    sourceSpecs,
    memoryHome,
    graphPath: path.join(tmp, "state", "memory-graph.db"),
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  assert.ok(prepared.packet.graph);
  assert.equal(prepared.packet.graph.plan.id, prepared.plan.id);
  assert.equal(prepared.packet.graph.context.some((node) => node.kind === "source_document"), false);
  assert.equal(prepared.plan.exclusions.some((excluded) => excluded.reason === "scope-mismatch"), true);
  assert.equal(prepared.packet.derivedViews.source_chunks.length >= 1, true);
  assert.deepEqual(fs.readFileSync(memoryPath), original);
  assert.equal(prepared.sync.canonicalSourcesMutated, false);
});

test("graph store failures are actionable and never fall back to unbounded review context", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-failure-"));
  const project = path.join(tmp, "project");
  const memoryHome = path.join(tmp, "memories");
  const blockingParent = path.join(tmp, "graph-parent-is-a-file");
  const invalidGraphPath = path.join(blockingParent, "memory-graph.db");
  fs.mkdirSync(memoryHome, { recursive: true });
  fs.writeFileSync(blockingParent, "not a directory");
  fs.writeFileSync(path.join(memoryHome, "MEMORY.md"), "# Memory\n\n- Graph failures must be explicit.\n");
  const sourceSpecs = [parseSourceSpec("codex:memories")];
  const packet = await buildReviewPacket({
    sourceSpecs,
    targets: ["codex:memories"],
    project,
    scope: "project",
    intent: "general-review",
    request: "graph failure",
    memoryHome,
  });

  await assert.rejects(
    prepareGraphReviewPacket({ packet, sourceSpecs, memoryHome, graphPath: invalidGraphPath }),
    (error: unknown) => error instanceof RefineryError && error.code === "GRAPH_STORE_WRITE_FAILED",
  );
});

test("graph inspection and neighborhood reads reject nodes outside the requested project scope", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-scope-read-"));
  const project = path.join(tmp, "project-a");
  const graphPath = path.join(tmp, "memory-graph.db");
  const index = syncMemoryGraph({
    store: new LibsqlGraphStore(graphPath),
    project,
    sourceSpecs: ["test:scope"],
    items: [{
      sourceAdapter: "test",
      sourceKey: "memory:other-project",
      kind: "memory",
      scope: "project",
      project: path.join(tmp, "project-b"),
      label: "Other project memory",
      content: "This memory belongs to another project.",
      uri: "memory://other-project",
      metadata: {},
    }],
    edges: [],
  }).index;
  const nodeId = index.nodes[0]?.id;
  assert.ok(nodeId);

  for (const read of [
    () => inspectMemoryGraphNode({ graphPath, project, nodeId }),
    () => getMemoryGraphNeighbors({ graphPath, project, nodeId }),
  ]) {
    assert.throws(
      read,
      (error: unknown) => error instanceof RefineryError && error.code === "GRAPH_NODE_OUT_OF_SCOPE",
    );
  }
});

test("stored responsibility planning hydrates a deterministic bounded subgraph", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-graph-plan-store-"));
  const project = path.join(tmp, "project");
  const graphPath = path.join(tmp, "memory-graph.db");
  const store = new LibsqlGraphStore(graphPath);
  syncMemoryGraph({
    store,
    project,
    sourceSpecs: ["test:plan"],
    items: [
      { sourceAdapter: "test", sourceKey: "memory:gateway", kind: "memory", scope: "project", project, label: "Gateway memory", content: "Indexed gateway observability and responsibility planning.", uri: null, metadata: {} },
      { sourceAdapter: "test", sourceKey: "memory:support", kind: "memory", scope: "project", project, label: "Supporting memory", content: "Supporting provenance for the gateway.", uri: null, metadata: {} },
    ],
    edges: [{ sourceAdapter: "test", sourceKey: "memory:gateway", targetAdapter: "test", targetKey: "memory:support", kind: "SUPPORTS", confidence: 1, derivation: "test" }],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });
  store.close();
  const options = {
    project,
    graphPath,
    scope: "project",
    request: "indexed gateway observability",
    limits: { maxNodes: 4, maxEdges: 4, maxHops: 1, maxChars: 1_000, maxTokens: 250 },
    now: new Date("2026-07-11T12:00:00.000Z"),
  };

  const first = planMemoryGraph(options);
  const second = planMemoryGraph(options);
  assert.deepEqual(second, first);
  assert.equal(first.plan.selectedNodes.length, 2);
  assert.equal(first.plan.traversedEdges.length, 1);
  assert.equal(first.plan.seeds[0]?.reasons.includes("lexical-match"), true);
});
