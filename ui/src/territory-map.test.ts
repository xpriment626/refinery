import assert from "node:assert/strict";
import test from "node:test";
import { positionForTerritoryNode, summarizeTerritories, territoryDefinitions } from "./territory-map.ts";

test("territory map assigns deterministic separated sectors and bounded summaries", () => {
  const memory = positionForTerritoryNode("stable-id", "memory");
  const repeated = positionForTerritoryNode("stable-id", "memory");
  const skill = positionForTerritoryNode("stable-id", "skill");

  assert.deepEqual(memory, repeated);
  assert.notDeepEqual(memory, skill);
  assert.equal(Number.isFinite(memory.x) && Number.isFinite(memory.y), true);
  assert.equal(territoryDefinitions.length, 6);

  const summary = summarizeTerritories([
    { kind: "memory" },
    { kind: "memory" },
    { kind: "skill" },
    { kind: "evidence" },
  ]);
  assert.equal(summary.find((territory) => territory.kind === "memory")?.count, 2);
  assert.equal(summary.find((territory) => territory.kind === "skill")?.count, 1);
  assert.equal(summary.find((territory) => territory.kind === "session")?.count, 0);
});
