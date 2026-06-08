import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RefineryPaths } from "./config.ts";
import { openDb } from "./db.ts";

export type RetrievalPaths = RefineryPaths;

export interface MemoryProvenance {
  kind: string;
  source_id: number | null;
  source_path: string | null;
  source_refs: unknown[];
  proposal_id: number | null;
}

export interface MemoryRecord {
  id: number;
  project_id: number;
  type: string;
  scope: string;
  status: string;
  body: string;
  confidence: number | null;
  created_at: string;
  provenance: MemoryProvenance;
}

export interface SearchMemoryInput {
  query?: string;
  limit?: number;
  type?: string;
}

export interface SearchMemoryResult extends MemoryRecord {
  score: number;
}

export interface GetMemoryInput {
  id: number;
}

export interface ProjectContextInput {
  query?: string;
  limit?: number;
}

export interface ProjectContextResult {
  orientation: string;
  supporting_memories: SearchMemoryResult[];
  query: string | null;
}

type MemoryRow = {
  id: number;
  project_id: number;
  type: string;
  scope: string;
  status: string;
  body: string;
  confidence: number | null;
  provenance_kind: string;
  source_id: number | null;
  source_path: string | null;
  source_refs: string | null;
  proposal_id: number | null;
  created_at: string;
};

function tokenize(query: string | undefined): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseSourceRefs(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{ raw }];
  }
}

function toMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    scope: row.scope,
    status: row.status,
    body: row.body,
    confidence: row.confidence,
    created_at: row.created_at,
    provenance: {
      kind: row.provenance_kind,
      source_id: row.source_id,
      source_path: row.source_path,
      source_refs: parseSourceRefs(row.source_refs),
      proposal_id: row.proposal_id,
    },
  };
}

function scoreMemory(memory: MemoryRecord, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const haystack = [
    memory.body,
    memory.type,
    memory.scope,
    memory.provenance.kind,
    memory.provenance.source_path ? path.basename(memory.provenance.source_path) : "",
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  if (score === 0) return 0;
  return score + (memory.confidence ?? 0) * 0.1;
}

function snippet(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 320 ? compact.slice(0, 317) + "..." : compact;
}

function activeProjectRows(db: DatabaseSync): MemoryRow[] {
  return db
    .prepare(
      `SELECT id, project_id, type, scope, status, body, confidence, provenance_kind,
              source_id, source_path, source_refs, proposal_id, created_at
       FROM memory
       WHERE status = 'active' AND scope = 'project'
       ORDER BY created_at DESC, id DESC`,
    )
    .all() as unknown as MemoryRow[];
}

function withDb<T>(paths: RetrievalPaths, fn: (db: DatabaseSync) => T): T {
  const db = openDb(paths);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function searchMemory(
  paths: RetrievalPaths,
  input: SearchMemoryInput = {},
): SearchMemoryResult[] {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
  const tokens = tokenize(input.query);

  return withDb(paths, (db) =>
    activeProjectRows(db)
      .map(toMemory)
      .filter((memory) => !input.type || memory.type === input.type)
      .map((memory) => ({ ...memory, score: scoreMemory(memory, tokens) }))
      .filter((memory) => tokens.length === 0 || memory.score > 0)
      .sort((a, b) => b.score - a.score || (b.confidence ?? 0) - (a.confidence ?? 0) || b.id - a.id)
      .slice(0, limit),
  );
}

export function getMemory(paths: RetrievalPaths, input: GetMemoryInput): MemoryRecord | null {
  return withDb(paths, (db) => {
    const row = db
      .prepare(
        `SELECT id, project_id, type, scope, status, body, confidence, provenance_kind,
                source_id, source_path, source_refs, proposal_id, created_at
         FROM memory
         WHERE id = ? AND status = 'active' AND scope = 'project'`,
      )
      .get(input.id) as MemoryRow | undefined;
    return row ? toMemory(row) : null;
  });
}

function summarize(memories: SearchMemoryResult[]): string {
  if (memories.length === 0) {
    return "Refinery found no active project memories for this query.";
  }

  const noun = memories.length === 1 ? "memory" : "memories";
  const bullets = memories
    .map((memory) => {
      const provenance = memory.provenance.source_path
        ? ` (${path.basename(memory.provenance.source_path)})`
        : memory.provenance.proposal_id
          ? ` (proposal#${memory.provenance.proposal_id})`
          : "";
      return `- [memory#${memory.id} ${memory.type}] ${snippet(memory.body)}${provenance}`;
    })
    .join("\n");
  return `Refinery found ${memories.length} active project ${noun} relevant to this query:\n${bullets}`;
}

export function getProjectContext(
  paths: RetrievalPaths,
  input: ProjectContextInput = {},
): ProjectContextResult {
  const supporting = searchMemory(paths, {
    query: input.query,
    limit: input.limit ?? 8,
  });
  return {
    orientation: summarize(supporting),
    supporting_memories: supporting,
    query: input.query ?? null,
  };
}
