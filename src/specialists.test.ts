import assert from "node:assert/strict";
import test from "node:test";
import { specialists } from "./core/specialists/index.ts";

test("local specialists remain explicit Coral review roles with contracts", () => {
  assert.deepEqual(
    specialists.map((s) => s.name),
    ["capture", "distillation", "schema", "relevance", "relationship-review"],
  );

  for (const specialist of specialists) {
    assert.equal(specialist.kind, "local-specialist");
    assert.ok(specialist.prompt.includes("You are the"));
    assert.ok(specialist.inputContract.length > 0);
    assert.ok(specialist.outputContract.length > 0);
    assert.ok(specialist.toolBoundary.allowedTools.length > 0);
  }
});
