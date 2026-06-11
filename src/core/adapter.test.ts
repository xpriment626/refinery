import assert from "node:assert/strict";
import test from "node:test";
import {
  memoryMaintenanceActions,
  validateMemoryStoreAdapter,
  type MemoryStoreAdapter,
} from "./adapter.ts";

test("memory maintenance actions include review-only operations beyond create/update", () => {
  assert.deepEqual(memoryMaintenanceActions, [
    "create",
    "update",
    "supersede",
    "merge",
    "archive",
    "retag",
    "quarantine",
    "promote",
    "demote",
    "ttl_update",
    "contradiction_review",
  ]);
});

test("validateMemoryStoreAdapter accepts the minimal read-only adapter contract", () => {
  const adapter: MemoryStoreAdapter = {
    name: "fixture",
    async listSourceEvidence() {
      return [];
    },
    async searchSourceEvidence() {
      return [];
    },
    async getSourceEvidence() {
      return null;
    },
    async listActiveMemories() {
      return [];
    },
    async searchActiveMemories() {
      return [];
    },
    async getActiveMemory() {
      return null;
    },
  };

  const result = validateMemoryStoreAdapter(adapter);

  assert.equal(result.valid, true);
  assert.deepEqual(result.capabilities, {
    listSourceEvidence: true,
    searchSourceEvidence: true,
    getSourceEvidence: true,
    listActiveMemories: true,
    searchActiveMemories: true,
    getActiveMemory: true,
    applyProposal: false,
  });
  assert.deepEqual(result.errors, []);
});

test("validateMemoryStoreAdapter reports missing required adapter methods", () => {
  const result = validateMemoryStoreAdapter({
    name: "broken",
    listSourceEvidence: async () => [],
    getSourceEvidence: async () => null,
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /searchSourceEvidence/);
  assert.match(result.errors.join("\n"), /listActiveMemories/);
  assert.match(result.errors.join("\n"), /searchActiveMemories/);
  assert.match(result.errors.join("\n"), /getActiveMemory/);
});
