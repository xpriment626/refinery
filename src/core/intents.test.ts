import assert from "node:assert/strict";
import test from "node:test";
import { reviewIntents, parseReviewIntent, defaultReviewIntent } from "./intents.ts";

test("review intent taxonomy includes pointed memory-maintenance requests", () => {
  assert.deepEqual(reviewIntents, [
    "general-review",
    "stale-audit",
    "forget-candidates",
    "update-candidates",
    "conflict-audit",
    "scope-audit",
    "session-recurrence",
    "memory-gap-audit",
    "skill-promotion-audit",
  ]);
  assert.equal(defaultReviewIntent, "general-review");
  assert.equal(parseReviewIntent("stale-audit"), "stale-audit");
  assert.equal(parseReviewIntent("session-recurrence"), "session-recurrence");
});

test("review intent parsing rejects non-taxonomy strings", () => {
  assert.throws(
    () => parseReviewIntent("stale-ish"),
    /review --intent must be one of/,
  );
});
