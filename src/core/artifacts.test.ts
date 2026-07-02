import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectReviewRun, writeReviewArtifactManifest } from "./artifacts.ts";

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("trial inspect reports claim deliberation artifacts", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-artifacts-"));
  writeJson(path.join(runDir, "proposals.json"), []);
  writeJson(path.join(runDir, "rejected.json"), [{ sourceId: "rejected:1", reason: "duplicate" }]);
  writeJson(path.join(runDir, "claims.json"), [{ claimId: "claim:run-1:1" }]);
  writeJson(path.join(runDir, "challenge-ledger.json"), [{ challengeId: "challenge:run-1:1" }]);
  writeJson(path.join(runDir, "deliberation.json"), {
    summary: {
      claims: 1,
      challenges: 1,
      moves: 3,
      unresolvedChallenges: 0,
    },
  });

  writeReviewArtifactManifest({
    runDir,
    runId: "run-1",
    adapterName: "fixture",
    scope: "project",
    mode: "coral",
    status: "succeeded",
    createdAt: "2026-07-01T00:00:00.000Z",
    counts: {
      proposals: 0,
      rejected: 1,
      claims: 1,
      challenges: 1,
      deliberationMoves: 3,
    },
    metadata: {
      runtime: {
        kind: "coral",
        topology: "debate-critique",
        topologyDesign: "claim-centered-interruptible",
      },
    },
  });

  const summary = inspectReviewRun(runDir);
  assert.equal(summary.deliberation.claims, 1);
  assert.equal(summary.deliberation.challenges, 1);
  assert.equal(summary.deliberation.moves, 3);
  assert.equal(summary.deliberation.unresolvedChallenges, 0);
  assert.equal(summary.artifacts.claims, "claims.json");
  assert.equal(summary.artifacts.challengeLedger, "challenge-ledger.json");
  assert.equal(summary.artifacts.deliberation, "deliberation.json");
  assert.equal(summary.manifest.runtime?.topologyDesign, "claim-centered-interruptible");
});
