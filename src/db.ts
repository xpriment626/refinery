import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { RefineryPaths } from "./config.ts";

/**
 * The canonical relational store (pattern-language §7/§8: relational DB is the
 * single source of truth; everything else points back to it).
 *
 * Schema kept deliberately small for this slice. Lifecycle, scope, type, and
 * provenance are first-class fields from the start so refinement/proposals can
 * be layered in later without a redesign.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id           INTEGER PRIMARY KEY,
  root_path    TEXT NOT NULL UNIQUE,
  encoded_path TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Immutable source archive index. Raw bytes live in the content-addressed raw
-- store; this row records provenance and points at the blob.
CREATE TABLE IF NOT EXISTS source (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id),
  kind         TEXT NOT NULL,          -- 'claude-code-session' | 'claude-memory-legacy'
  source_path  TEXT NOT NULL,          -- absolute path of the ORIGINAL file (never modified)
  session_id   TEXT,
  sha256       TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  source_mtime TEXT,
  raw_blob     TEXT NOT NULL,          -- path inside the raw store (copy of original)
  imported_at  TEXT NOT NULL,
  UNIQUE (project_id, source_path)
);

-- Active memory records. Legacy Claude Code memory/*.md import here directly as
-- active memories tagged with provenance 'claude-memory-legacy'. Memories
-- produced by approving a proposal carry proposal_id + source_refs instead of a
-- single source_id (source_id stays NULL — multiple NULLs are allowed by the
-- UNIQUE below, which preserves legacy-import idempotency).
CREATE TABLE IF NOT EXISTS memory (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES project(id),
  type            TEXT NOT NULL,       -- memory type
  scope           TEXT NOT NULL,       -- 'project'
  status          TEXT NOT NULL,       -- lifecycle state: 'active' | 'superseded' | 'archived'
  body            TEXT NOT NULL,
  confidence      REAL,
  provenance_kind TEXT NOT NULL,       -- 'claude-memory-legacy' | 'refinery-proposal'
  source_id       INTEGER REFERENCES source(id),
  source_path     TEXT,
  source_refs     TEXT,                -- JSON source transcript references (proposal-derived)
  proposal_id     INTEGER REFERENCES proposal(id), -- originating proposal, when proposal-derived
  created_at      TEXT NOT NULL,
  UNIQUE (source_id)
);

-- Proposed mutations against the active set. Every proposal carries the full
-- eight-field contract. Nothing here is active memory until an explicit approve
-- transitions it (pattern-language §5: proposals-not-direct-writes).
CREATE TABLE IF NOT EXISTS proposal (
  id                  INTEGER PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES project(id),
  dedupe_key          TEXT UNIQUE,                 -- stable key for idempotent seeding
  memory_type         TEXT NOT NULL,               -- (1) memory type
  proposed_scope      TEXT NOT NULL,               -- (2) proposed scope
  body                TEXT NOT NULL,               -- (3) atomic body
  confidence          REAL NOT NULL,               -- (4) confidence
  rationale           TEXT NOT NULL,               -- (5) rationale
  source_refs         TEXT NOT NULL,               -- (6) source transcript references (JSON)
  mutation_op         TEXT NOT NULL                -- (7) suggested mutation operation
                        CHECK (mutation_op IN ('create','update','supersede','archive','merge')),
  target_memory_id    INTEGER REFERENCES memory(id), -- (8) existing-memory target, when applicable
  status              TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','approved','rejected')),
  created_at          TEXT NOT NULL,
  reviewed_by         TEXT,
  reviewed_at         TEXT,
  resulting_memory_id INTEGER REFERENCES memory(id)
);
`;

export function openDb(paths: RefineryPaths): DatabaseSync {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.rawDir, { recursive: true });
  const db = new DatabaseSync(paths.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Bring a pre-existing store up to the current schema. The original slice's
 * `memory` table had a NOT NULL source_id and no proposal-provenance columns;
 * rebuild it (preserving rows and the UNIQUE(source_id) idempotency guarantee
 * for legacy imports) so proposal-derived memories can carry proposal_id +
 * source_refs with a NULL source_id.
 */
function migrate(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(memory)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (cols.includes("proposal_id")) return; // already current

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE memory_new (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id),
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        confidence REAL,
        provenance_kind TEXT NOT NULL,
        source_id INTEGER REFERENCES source(id),
        source_path TEXT,
        source_refs TEXT,
        proposal_id INTEGER REFERENCES proposal(id),
        created_at TEXT NOT NULL,
        UNIQUE (source_id)
      );`);
    db.exec(`
      INSERT INTO memory_new
        (id, project_id, type, scope, status, body, confidence, provenance_kind,
         source_id, source_path, created_at)
      SELECT id, project_id, type, scope, status, body, confidence, provenance_kind,
             source_id, source_path, created_at
      FROM memory;`);
    db.exec("DROP TABLE memory;");
    db.exec("ALTER TABLE memory_new RENAME TO memory;");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON;");
}

/** Active memories only (lifecycle status = 'active'). */
export function activeMemoryCount(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM memory WHERE status = 'active'`)
    .get() as { c: number };
  return row.c;
}

export function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ["project", "source", "memory"]) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number };
    out[t] = row.c;
  }
  return out;
}

/** Idempotent: a path that has already been imported returns the existing id. */
export function ensureProject(db: DatabaseSync, rootAbs: string, encoded: string): number {
  db.prepare(
    `INSERT INTO project (root_path, encoded_path, created_at)
     VALUES (?, ?, ?) ON CONFLICT(root_path) DO NOTHING`,
  ).run(rootAbs, encoded, new Date().toISOString());
  const row = db.prepare(`SELECT id FROM project WHERE root_path = ?`).get(rootAbs) as {
    id: number;
  };
  return row.id;
}

export { path };
