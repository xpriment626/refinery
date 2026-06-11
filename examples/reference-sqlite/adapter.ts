import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ActiveMemory,
  type AdapterReadInput,
  type AdapterSearchInput,
  type AdapterScopeInput,
  type MemoryStoreAdapter,
  type SourceEvidence,
} from "../../src/core/adapter.ts";
import { resolvePaths, type RefineryPaths } from "./config.ts";

type SourceRow = {
  id: number;
  kind: string;
  source_path: string;
  session_id: string | null;
  sha256: string;
  raw_blob: string;
};

type MemoryRow = {
  id: number;
  type: string;
  scope: string;
  status: string;
  body: string;
  confidence: number | null;
  provenance_kind: string;
  source_path: string | null;
  source_refs: string | null;
  proposal_id: number | null;
};

async function withDb<T>(paths: RefineryPaths, fn: (db: DatabaseSync) => T): Promise<T> {
  const { openDb } = await import("./db.ts");
  const db = openDb(paths);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function resolveRawPath(paths: RefineryPaths, row: SourceRow): string {
  if (fs.existsSync(row.raw_blob)) return row.raw_blob;
  const contentAddressed = path.join(paths.rawDir, row.sha256);
  return contentAddressed;
}

function readSourceText(paths: RefineryPaths, row: SourceRow): string {
  const rawPath = resolveRawPath(paths, row);
  if (!fs.existsSync(rawPath)) return "";
  return fs.readFileSync(rawPath, "utf8");
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

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchesQuery(text: string, query: string): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  const haystack = text.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function createReferenceSqliteAdapter(paths = resolvePaths()): MemoryStoreAdapter {
  const listSourceEvidence = async (input: AdapterScopeInput): Promise<SourceEvidence[]> => {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    return await withDb(paths, (db) => {
      const rows = db
        .prepare(
          `SELECT id, kind, source_path, session_id, sha256, raw_blob
           FROM source
           ORDER BY imported_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as unknown as SourceRow[];
      return rows.map((row) => ({
        id: `source:${row.id}`,
        kind: row.kind,
        path: row.source_path,
        text: readSourceText(paths, row),
        refs: [
          {
            source_id: `source:${row.id}`,
            source_path: row.source_path,
            session_id: row.session_id,
            sha256: row.sha256,
          },
        ],
      }));
    });
  };

  const listActiveMemories = async (input: AdapterScopeInput): Promise<ActiveMemory[]> => {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return await withDb(paths, (db) => {
      const rows = db
        .prepare(
          `SELECT id, type, scope, status, body, confidence, provenance_kind,
                  source_path, source_refs, proposal_id
           FROM memory
           WHERE status = 'active' AND scope = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(input.scope, limit) as unknown as MemoryRow[];
      return rows.map((row) => ({
        id: `memory:${row.id}`,
        type: row.type,
        scope: row.scope,
        status: row.status,
        body: row.body,
        confidence: row.confidence,
        provenance: {
          kind: row.provenance_kind,
          source_path: row.source_path,
          source_refs: parseSourceRefs(row.source_refs),
          proposal_id: row.proposal_id == null ? null : `proposal:${row.proposal_id}`,
        },
      }));
    });
  };

  return {
    name: "reference-sqlite",
    listSourceEvidence,

    async searchSourceEvidence(input: AdapterSearchInput): Promise<SourceEvidence[]> {
      const sources = await listSourceEvidence(input);
      return sources.filter((source) =>
        matchesQuery([source.text, source.kind, source.path ?? ""].join(" "), input.query),
      );
    },

    async getSourceEvidence(input: AdapterReadInput): Promise<SourceEvidence | null> {
      const sources = await listSourceEvidence({ scope: input.scope, limit: 100 });
      return sources.find((source) => source.id === input.id) ?? null;
    },

    listActiveMemories,

    async searchActiveMemories(input: AdapterSearchInput): Promise<ActiveMemory[]> {
      const memories = await listActiveMemories(input);
      return memories.filter((memory) =>
        matchesQuery([memory.body, memory.type, memory.scope].join(" "), input.query),
      );
    },

    async getActiveMemory(input: AdapterReadInput): Promise<ActiveMemory | null> {
      const memories = await listActiveMemories({ scope: input.scope, limit: 200 });
      return memories.find((memory) => memory.id === input.id) ?? null;
    },
  };
}

export const adapter = createReferenceSqliteAdapter();
