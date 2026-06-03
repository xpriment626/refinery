import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import {
  runCaptureExperiment,
  selectDeterministicSessionSlice,
  type ExperimentPaths,
} from "./experiments/capture.ts";

function makePaths(): ExperimentPaths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-experiment-"));
  return {
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
  };
}

function seedSession(paths: ExperimentPaths): void {
  fs.mkdirSync(paths.rawDir, { recursive: true });
  const rawBlob = path.join(paths.rawDir, "session-a");
  const jsonl = [
    {
      type: "user",
      timestamp: "2026-06-03T00:00:00.000Z",
      sessionId: "session-a",
      message: { role: "user", content: "We decided memory refinement should run over session history first, not only pre-existing memories." },
    },
    {
      type: "assistant",
      timestamp: "2026-06-03T00:01:00.000Z",
      sessionId: "session-a",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "That makes existing memories a weak ground-truth baseline while raw sessions remain the primary source evidence." }],
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
  fs.writeFileSync(rawBlob, jsonl);

  const db = openDb(paths);
  db.prepare(
    `INSERT INTO project (id, root_path, encoded_path, created_at)
     VALUES (1, '/tmp/fabrick', '-tmp-fabrick', '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO source
       (id, project_id, kind, source_path, session_id, sha256, byte_size, source_mtime, raw_blob, imported_at)
     VALUES
       (1, 1, 'claude-code-session', '/tmp/fabrick-session.jsonl', 'session-a', 'session-a', ?, '2026-06-03T00:01:00.000Z', ?, '2026-06-03T00:02:00.000Z')`,
  ).run(Buffer.byteLength(jsonl), rawBlob);
  db.close();
}

test("selectDeterministicSessionSlice extracts compact source chunks from archived JSONL", () => {
  const paths = makePaths();
  seedSession(paths);

  const slice = selectDeterministicSessionSlice(paths, { maxTurns: 4, maxChars: 2000 });

  assert.equal(slice.source.id, 1);
  assert.equal(slice.chunks.length, 2);
  assert.equal(slice.chunks[0].role, "user");
  assert.match(slice.chunks[0].text, /session history first/);
});

test("runCaptureExperiment writes local artifacts without requiring a live LLM", async () => {
  const paths = makePaths();
  seedSession(paths);

  const result = await runCaptureExperiment(paths, {
    runId: "capture-test",
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "test-key",
    },
    callModel: async () =>
      [
        "```json",
        JSON.stringify({
          candidates: [
            {
              claim: "Memory refinement should run over session history first; existing memories are a weak ground-truth baseline.",
              source_refs: [{ source_id: 1, session_id: "session-a" }],
              why_future_useful: "Keeps future refinement tests pointed at source evidence instead of curated memory files.",
            },
          ],
        }),
        "```",
      ].join("\n"),
  });

  assert.equal(result.runId, "capture-test");
  assert.equal(result.parsed.candidates.length, 1);
  assert.equal(fs.existsSync(path.join(result.runDir, "input.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "output.raw.md")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "output.parsed.json")), true);
  assert.equal(fs.existsSync(path.join(result.runDir, "eval.md")), true);
  assert.doesNotMatch(fs.readFileSync(path.join(result.runDir, "input.json"), "utf8"), /test-key/);
});
