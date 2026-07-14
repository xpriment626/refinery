import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareCoralTopologyRuns } from "./coral-topology-comparison.ts";

function fixture(root: string, name: string, calls: number, tokens: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const input = { derivedViews: { source_chunks: [{ id: "source:1", uri: "memory://source-1", refs: [{ source_id: "source:1" }] }] } };
  fs.writeFileSync(path.join(dir, "input.json"), JSON.stringify(input));
  fs.writeFileSync(path.join(dir, "paid-run.json"), JSON.stringify({
    topology: name,
    model: "gpt-5.4-nano",
    usage: { callCount: calls, status200Count: calls, totalTokens: tokens, promptTokens: tokens - 10, completionTokens: 10, promptChars: tokens * 4 },
  }));
  fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify({
    runId: name,
    proposals: [{ action: "create", body: "Durable conclusion", sourceRefs: ["memory://source-1"] }],
  }));
  return dir;
}

test("topology comparison requires identical input, valid citations, parity, and fifty-percent efficiency", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-comparison-"));
  const result = compareCoralTopologyRuns(fixture(root, "baseline", 5, 1_000), fixture(root, "sparse", 2, 400));
  assert.equal(result.pass, true);
  assert.deepEqual(result.reductions, { callReduction: 0.6, tokenReduction: 0.6, promptCharReduction: 0.6 });
});
