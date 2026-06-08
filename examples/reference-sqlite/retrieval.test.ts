import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import {
  getMemory,
  getProjectContext,
  searchMemory,
  type RetrievalPaths,
} from "./retrieval.ts";

function tempPaths(): RetrievalPaths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-retrieval-"));
  return {
    home,
    dbPath: path.join(home, "refinery.db"),
    rawDir: path.join(home, "raw"),
  };
}

function seedStore(paths: RetrievalPaths): void {
  const db = openDb(paths);
  db.prepare(
    `INSERT INTO project (id, root_path, encoded_path, created_at)
     VALUES (1, '/tmp/fabrick', '-tmp-fabrick', '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO source
       (id, project_id, kind, source_path, session_id, sha256, byte_size, source_mtime, raw_blob, imported_at)
     VALUES
       (1, 1, 'claude-memory-legacy', '/tmp/memory/project_dream_pass.md', NULL, 'abc', 10, NULL, '/tmp/raw/abc', '2026-06-03T00:00:00.000Z'),
       (2, 1, 'claude-memory-legacy', '/tmp/memory/old.md', NULL, 'def', 10, NULL, '/tmp/raw/def', '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO memory
       (id, project_id, type, scope, status, body, confidence, provenance_kind, source_id, source_path, created_at)
     VALUES
       (1, 1, 'procedural', 'project', 'active', 'Dream-pass runs capture, distillation, schema, and relevance as a governed proposal loop.', 0.91, 'claude-memory-legacy', 1, '/tmp/memory/project_dream_pass.md', '2026-06-03T00:00:00.000Z'),
       (2, 1, 'semantic', 'project', 'superseded', 'Old inactive memory mentioning dream-pass should not retrieve by default.', 0.40, 'claude-memory-legacy', 2, '/tmp/memory/old.md', '2026-06-03T00:00:00.000Z'),
       (3, 1, 'semantic', 'team', 'active', 'Team scoped memory should not appear in project-scoped Stage A retrieval.', 0.80, 'claude-memory-legacy', NULL, NULL, '2026-06-03T00:00:00.000Z')`,
  ).run();
  db.close();
}

test("searchMemory returns active project-scoped memories with provenance", () => {
  const paths = tempPaths();
  seedStore(paths);

  const results = searchMemory(paths, { query: "dream pass", limit: 5 });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 1);
  assert.equal(results[0].status, "active");
  assert.equal(results[0].scope, "project");
  assert.equal(results[0].provenance.source_path, "/tmp/memory/project_dream_pass.md");
  assert.equal(results[0].score > 0, true);
});

test("getMemory hydrates one active memory and omits inactive records", () => {
  const paths = tempPaths();
  seedStore(paths);

  assert.equal(getMemory(paths, { id: 2 }), null);

  const memory = getMemory(paths, { id: 1 });
  assert.equal(memory?.body.includes("governed proposal loop"), true);
  assert.equal(memory?.provenance.kind, "claude-memory-legacy");
});

test("getProjectContext returns readable synthesis plus supporting records", () => {
  const paths = tempPaths();
  seedStore(paths);

  const context = getProjectContext(paths, { query: "How does the dream pass work?" });

  assert.match(context.orientation, /Refinery found 1 active project memory/);
  assert.match(context.orientation, /Dream-pass runs capture/);
  assert.equal(context.supporting_memories.length, 1);
  assert.equal(context.supporting_memories[0].id, 1);
  assert.equal(context.supporting_memories[0].provenance.source_path, "/tmp/memory/project_dream_pass.md");
});
