import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRetrievalHoldouts,
  queryWithoutSilverLabel,
  type RetrievalHoldout,
} from "./session-retrieval-benchmark.ts";
import type { SessionUnitSearchResult } from "../src/sources/codex-session-catalogue.ts";

function result(unitId: string, sessionId: string, text: string): SessionUnitSearchResult {
  return {
    unitId,
    sessionId,
    rank: -1,
    text,
    metadata: { unitId, sessionId, provenance: { lineStart: 1, lineEnd: 2 } },
  };
}

test("labelled retrieval fixtures score provenance, evidence, citations, and misses deterministically", () => {
  const holdouts: RetrievalHoldout[] = [
    { id: "fixture-hit", query: "release manifest repair", targetSessionId: "session-a", label: "fixture" },
    { id: "fixture-miss", query: "gateway lifecycle", targetSessionId: "session-b", label: "fixture" },
  ];
  const evaluation = evaluateRetrievalHoldouts({
    holdouts,
    retrieve: (query) => query.includes("manifest")
      ? [result("unit-a", "session-a", "The release manifest repair passed verification.")]
      : [result("unit-c", "session-c", "Gateway lifecycle evidence.")],
  });
  assert.equal(evaluation.holdouts, 2);
  assert.equal(evaluation.recoveredAt10, 1);
  assert.equal(evaluation.recallAt10, 0.5);
  assert.equal(evaluation.durableLearningRecovered, 1);
  assert.equal(evaluation.citationValidity, 1);
  assert.equal(evaluation.duplicateResultRate, 0);
});

test("silver-label metadata is removed from holdout queries", () => {
  const query = queryWithoutSilverLabel("Keep graph retrieval. (thread_id=abc-123, cwd=/Users/name/Lab/private)");
  assert.equal(query, "Keep graph retrieval.");
});
