import assert from "node:assert/strict";
import test from "node:test";
import {
  createSequentialRefinementHarness,
  specialists,
} from "./specialists/index.ts";

test("local specialists are scaffolded as separate agents with contracts", () => {
  assert.deepEqual(
    specialists.map((s) => s.name),
    ["capture", "distillation", "schema", "relevance"],
  );

  for (const specialist of specialists) {
    assert.equal(specialist.kind, "local-specialist");
    assert.ok(specialist.prompt.includes("You are the"));
    assert.ok(specialist.inputContract.length > 0);
    assert.ok(specialist.outputContract.length > 0);
    assert.ok(specialist.toolBoundary.allowedTools.length > 0);
  }
});

test("sequential harness describes handoff order without invoking a live LLM", () => {
  const harness = createSequentialRefinementHarness();

  assert.deepEqual(harness.order, ["capture", "distillation", "schema", "relevance"]);
  assert.equal(harness.usesLiveLlm, false);
  assert.match(harness.describe(), /Capture -> Distillation -> Schema -> Relevance/);
});
