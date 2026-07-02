import assert from "node:assert/strict";
import test from "node:test";
import { parseDecisionSynthesizer, parseProposalEditor } from "./live-review.ts";

test("parseProposalEditor accepts multi-target memory proposals", () => {
  const parsed = parseProposalEditor(JSON.stringify({
    typed: [
      {
        body: "Merge overlapping project preferences.",
        memory_type: "semantic",
        primary_type: "semantic",
        secondary_type: null,
        type_confidence: 0.87,
        type_rationale: "Durable project preference.",
        ambiguities: [],
        durability: "durable",
        ttl: null,
        proposed_scope: "project",
        action: "supersede",
        target_memory_id: ["memory:a", "memory:b"],
        replacement_body: "Merged preference body.",
        source_refs: ["source:1"],
      },
    ],
  }));

  assert.equal(parsed.typed[0].target_memory_id, "memory:a");
  assert.deepEqual(parsed.typed[0].target_memory_ids, ["memory:a", "memory:b"]);
});

test("parseDecisionSynthesizer preserves target_memory_ids when supplied explicitly", () => {
  const parsed = parseDecisionSynthesizer(JSON.stringify({
    proposals: [
      {
        memory_type: "semantic",
        proposed_scope: "project",
        body: "Merged preference body.",
        confidence: 0.83,
        rationale: "Two existing memories should be superseded by one clearer body.",
        source_refs: ["source:1"],
        action: "supersede",
        target_memory_id: "memory:a",
        target_memory_ids: ["memory:a", "memory:b"],
        staleness_reason: null,
        forget_reason: null,
        update_reason: "Consolidates duplicates.",
        conflict_reason: null,
        scope_reason: null,
        replacement_body: "Merged preference body.",
        ambiguities: [],
      },
    ],
    rejected: [],
  }));

  assert.equal(parsed.proposals[0].target_memory_id, "memory:a");
  assert.deepEqual(parsed.proposals[0].target_memory_ids, ["memory:a", "memory:b"]);
});

test("parseDecisionSynthesizer accepts rejection rationale aliases", () => {
  const parsed = parseDecisionSynthesizer(JSON.stringify({
    proposals: [],
    rejected: [
      {
        body: "Merge unrelated keyword memories.",
        rejection_reason: "evidence_gap",
        rejection_rationale: "The evidence does not show the memories are duplicates.",
      },
    ],
  }));

  assert.equal(parsed.rejected[0].body, "Merge unrelated keyword memories.");
  assert.equal(parsed.rejected[0].reason, "The evidence does not show the memories are duplicates.");
});
