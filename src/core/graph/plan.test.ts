import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResponsibilityPlan, responsibilityPlanSchemaVersion } from "./plan.ts";
import { JsonGraphStore, syncMemoryGraph, type GraphSourceItem } from "./sync.ts";

const project = "/tmp/refinery-project-a";
const otherProject = "/tmp/refinery-project-b";

function item(args: Partial<GraphSourceItem> & Pick<GraphSourceItem, "sourceKey" | "kind" | "content">): GraphSourceItem {
  return {
    sourceAdapter: "test",
    scope: "project",
    project,
    label: args.sourceKey,
    uri: `test://${args.sourceKey}`,
    metadata: {},
    ...args,
  };
}

function responsibilityFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-plan-"));
  return syncMemoryGraph({
    store: new JsonGraphStore(path.join(home, "graph.json")),
    project,
    sourceSpecs: ["test:graph"],
    items: [
      item({ sourceKey: `project:${project}`, kind: "project", content: project }),
      item({
        sourceKey: "memory:primary",
        kind: "memory",
        content: "Responsibility graph retrieval should remain project scoped.",
        metadata: { sourcePath: "MEMORY.md", line: 10 },
        sourceModifiedAt: "2026-06-01T00:00:00.000Z",
      }),
      item({
        sourceKey: "evidence:MEMORY.md:10",
        kind: "evidence",
        content: "Responsibility graph retrieval evidence.",
        metadata: { sourcePath: "MEMORY.md", line: 10 },
      }),
      item({
        sourceKey: "document:MEMORY.md",
        kind: "source_document",
        content: "# Responsibility graph memory source",
        metadata: { sourcePath: "MEMORY.md" },
      }),
      item({
        sourceKey: "memory:other-project",
        kind: "memory",
        content: "Responsibility graph retrieval from an unrelated project.",
        project: otherProject,
        metadata: { sourcePath: "OTHER.md", line: 4 },
      }),
      item({
        sourceKey: "skill:refinery",
        kind: "skill",
        content: "Refinery memory review skill.",
        scope: "global",
        project: null,
      }),
    ],
    edges: [
      {
        sourceAdapter: "test",
        sourceKey: "memory:primary",
        targetAdapter: "test",
        targetKey: "evidence:MEMORY.md:10",
        kind: "DERIVED_FROM",
        confidence: 0.6,
        derivation: "line-reference",
      },
      {
        sourceAdapter: "test",
        sourceKey: "evidence:MEMORY.md:10",
        targetAdapter: "test",
        targetKey: "document:MEMORY.md",
        kind: "DERIVED_FROM",
        confidence: 1,
        derivation: "document-reference",
      },
      {
        sourceAdapter: "test",
        sourceKey: "memory:primary",
        targetAdapter: "test",
        targetKey: "memory:other-project",
        kind: "SAME_TOPIC_AS",
        confidence: 1,
        derivation: "cross-project-fixture",
      },
    ],
    now: new Date("2026-07-10T00:00:00.000Z"),
  }).index;
}

test("ResponsibilityPlan is deterministic, scope-safe, and projects awake seeds plus sleeping one-hop units", () => {
  const index = responsibilityFixture();
  const primary = index.nodes.find((node) => node.sourceKey === "memory:primary");
  const other = index.nodes.find((node) => node.sourceKey === "memory:other-project");
  assert.ok(primary);
  assert.ok(other);

  const options = {
    index,
    request: "Map responsibility graph retrieval evidence.",
    project,
    scope: "project",
    explicitNodeIds: [primary.id, other.id],
    changedNodeIds: [],
    now: new Date("2026-07-11T00:00:00.000Z"),
  };
  const first = createResponsibilityPlan(options);
  const second = createResponsibilityPlan(options);

  assert.equal(first.schemaVersion, responsibilityPlanSchemaVersion);
  assert.deepEqual(second, first);
  assert.equal(first.selectedNodes.some((selected) => selected.nodeId === other.id), false);
  assert.equal(first.traversedEdges.some((edge) => edge.sourceNodeId === other.id || edge.targetNodeId === other.id), false);
  assert.equal(first.exclusions.some((excluded) => excluded.nodeId === other.id && excluded.reason === "scope-mismatch"), true);
  assert.equal(first.seeds.some((seed) => seed.nodeId === primary.id && seed.reasons.includes("explicit-id")), true);
  assert.equal(first.awakeSeeds.length >= 1, true);
  assert.equal(first.sleepingOneHop.length >= 1, true);
  assert.equal(first.responsibilityUnits.some((unit) => unit.kind === "memory" && unit.state === "awake"), true);
  assert.equal(first.responsibilityUnits.some((unit) => unit.kind === "source-cluster" && unit.state === "sleeping"), true);
  assert.equal(first.runtimeProjection.dynamicAgents, false);
  assert.equal(first.runtimeProjection.nextSeam, "sleeping-unit-first-wake-expansion");
});

test("ResponsibilityPlan reports explicit seeds excluded by the freshness limit", () => {
  const index = responsibilityFixture();
  const primary = index.nodes.find((node) => node.sourceKey === "memory:primary");
  assert.ok(primary);

  const plan = createResponsibilityPlan({
    index,
    request: "Responsibility graph retrieval.",
    project,
    scope: "project",
    explicitNodeIds: [primary.id],
    limits: { maxAgeDays: 3 },
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  assert.equal(plan.selectedNodes.some((selected) => selected.nodeId === primary.id), false);
  assert.equal(plan.exclusions.some((excluded) => excluded.nodeId === primary.id && excluded.reason === "freshness-limit"), true);
});

test("ResponsibilityPlan enforces node, edge, hop, character, token, kind, and confidence bounds", async (t) => {
  const index = responsibilityFixture();
  const primary = index.nodes.find((node) => node.sourceKey === "memory:primary");
  assert.ok(primary);
  const planWith = (limits: Parameters<typeof createResponsibilityPlan>[0]["limits"]) => createResponsibilityPlan({
    index,
    request: "Responsibility graph retrieval evidence.",
    project,
    scope: "project",
    explicitNodeIds: [primary.id],
    limits,
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  await t.test("node bound", () => {
    const plan = planWith({ maxNodes: 1 });
    assert.equal(plan.selectedNodes.length <= 1, true);
    assert.equal(plan.budgetExhaustion.nodes, true);
  });
  await t.test("edge bound", () => {
    const plan = planWith({ maxEdges: 0 });
    assert.equal(plan.traversedEdges.length, 0);
    assert.equal(plan.budgetExhaustion.edges, true);
  });
  await t.test("hop bound", () => {
    const plan = planWith({ maxHops: 0 });
    assert.equal(plan.selectedNodes.every((selected) => selected.depth === 0), true);
    assert.equal(plan.budgetExhaustion.hops, true);
  });
  await t.test("character bound", () => {
    const plan = planWith({ maxChars: 10, maxTokens: 100 });
    assert.equal(plan.selectedNodes.reduce((total, selected) => total + selected.selectedChars, 0) <= 10, true);
    assert.equal(plan.budgetExhaustion.chars, true);
  });
  await t.test("token bound", () => {
    const plan = planWith({ maxChars: 1_000, maxTokens: 2 });
    assert.equal(plan.selectedNodes.reduce((total, selected) => total + selected.estimatedTokens, 0) <= 2, true);
    assert.equal(plan.budgetExhaustion.tokens, true);
  });
  await t.test("edge-kind allowlist", () => {
    const plan = planWith({ edgeKinds: ["REQUIRES_SKILL"] });
    assert.equal(plan.traversedEdges.length, 0);
    assert.equal(plan.exclusions.some((excluded) => excluded.reason === "edge-kind-filter"), true);
  });
  await t.test("confidence threshold", () => {
    const plan = planWith({ minConfidence: 0.9, edgeKinds: ["DERIVED_FROM"] });
    assert.equal(plan.traversedEdges.some((edge) => edge.confidence < 0.9), false);
    assert.equal(plan.exclusions.some((excluded) => excluded.reason === "confidence-filter"), true);
  });
});

test("changed-node seeding does not override a focused lexical request", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-plan-focused-"));
  const index = syncMemoryGraph({
    store: new JsonGraphStore(path.join(home, "graph.json")),
    project,
    sourceSpecs: ["test:graph"],
    items: [
      item({ sourceKey: "memory:focused", kind: "memory", content: "Unique narwhal retrieval policy." }),
      item({ sourceKey: "memory:unrelated", kind: "memory", content: "Completely unrelated release checklist." }),
    ],
    edges: [],
    now: new Date("2026-07-11T00:00:00.000Z"),
  }).index;

  const plan = createResponsibilityPlan({
    index,
    request: "narwhal retrieval",
    project,
    scope: "project",
    changedNodeIds: index.nodes.map((node) => node.id),
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  const focused = index.nodes.find((node) => node.sourceKey === "memory:focused");
  const unrelated = index.nodes.find((node) => node.sourceKey === "memory:unrelated");
  assert.ok(focused);
  assert.ok(unrelated);
  assert.equal(plan.seeds.some((seed) => seed.nodeId === focused.id), true);
  assert.equal(plan.seeds.some((seed) => seed.nodeId === unrelated.id), false);
});

test("explicit source-document identifiers become responsibility seeds", () => {
  const index = responsibilityFixture();
  const document = index.nodes.find((node) => node.sourceKey === "document:MEMORY.md");
  assert.ok(document);

  const plan = createResponsibilityPlan({
    index,
    request: null,
    project,
    scope: "project",
    explicitNodeIds: [document.id],
    changedNodeIds: [],
    now: new Date("2026-07-11T00:00:00.000Z"),
  });

  assert.equal(plan.seeds.some((seed) => seed.nodeId === document.id && seed.reasons.includes("explicit-id")), true);
  assert.equal(plan.selectedNodes.some((selected) => selected.nodeId === document.id && selected.seed), true);
});
