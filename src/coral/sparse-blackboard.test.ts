import assert from "node:assert/strict";
import test from "node:test";
import { buildSparseTopics, createSparseBlackboard, routeSparseClaims } from "./sparse-blackboard.ts";
import type { ReviewPacket } from "../core/types.ts";

test("sparse router wakes specialists only for deterministic evidence conditions", () => {
  const candidate = {
    claim: "Release migration credentials must never be copied into run artifacts.",
    source_refs: [{ source_id: "source-1" }],
    why_future_useful: "Prevents a recurring security failure in future releases.",
  };
  const routed = routeSparseClaims({
    candidates: [candidate],
    activeMemories: [{ body: "Release credentials may be copied into temporary run artifacts." }],
  });
  assert.equal(routed.decision.wakeCartographer, true);
  assert.equal(routed.decision.wakeAuditor, true);
  assert.equal(routed.decision.contradictionRisk, true);
  assert.equal(routed.decision.wakeProposalEditor, true);
  assert.equal(routed.decision.wakeDecisionSynthesizer, false);

  const rejected = routeSparseClaims({
    candidates: [candidate],
    activeMemories: [],
    auditFindings: [{ body: candidate.claim, relation: "too_weak" }],
  });
  assert.equal(rejected.survivors.length, 0);
  assert.equal(rejected.decision.wakeProposalEditor, false);
});

test("sparse blackboard keeps only awake topics initially attached", () => {
  const packet = {
    objective: { project: "/tmp/Lab", request: null, scope: "project", intent: "general-review" },
    derivedViews: { source_chunks: [] },
    graph: {
      plan: {
        responsibilityUnits: [
          { id: "awake", nodeIds: ["n1"], state: "awake" },
          { id: "sleeping", nodeIds: ["n2"], state: "sleeping" },
        ],
      },
      context: [],
    },
  } as unknown as ReviewPacket;
  const blackboard = createSparseBlackboard("run-1", packet);
  assert.equal(blackboard.topics.length, 2);
  assert.deepEqual(blackboard.sleepingTopicIds, [blackboard.topics[1]?.id]);
  assert.deepEqual(blackboard.wakeSequence, []);
});

test("sparse topics receive only chunks owned by their graph responsibility unit", () => {
  const packet = {
    objective: { project: "/tmp/Lab", request: null, scope: "project", intent: "general-review" },
    derivedViews: {
      source_chunks: [
        { id: "memory-node", text: "Memory evidence." },
        { id: "session-node", text: "Session evidence.", metadata: { unitId: "session-source-unit" } },
        { id: "unselected-node", text: "Must not leak into either topic." },
      ],
    },
    graph: {
      plan: {
        responsibilityUnits: [
          { id: "memory-unit", nodeIds: ["memory-node"], state: "awake" },
          { id: "session-unit", nodeIds: ["session-node"], state: "awake" },
        ],
      },
      context: [
        { nodeId: "memory-node", responsibilityUnitId: "memory-unit", metadata: {} },
        { nodeId: "session-node", responsibilityUnitId: "session-unit", metadata: { unitId: "session-source-unit" } },
      ],
    },
  } as unknown as ReviewPacket;

  const topics = buildSparseTopics(packet);
  assert.deepEqual(topics.map((topic) => topic.sourceChunkIds), [["memory-node"], ["session-node"]]);
});
