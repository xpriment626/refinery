import fs from "node:fs";
import path from "node:path";
import Database from "libsql";
import { RefineryError } from "../errors.ts";
import {
  JsonGraphStore,
  memoryGraphIndexerVersion,
  memoryGraphSchemaVersion,
  type GraphStore,
  type GraphSyncDelta,
  type MemoryGraphEdge,
  type MemoryGraphIndex,
  type MemoryGraphNode,
  type MemoryGraphRevision,
} from "./sync.ts";

export const graphDatabaseSchemaVersion = 3 as const;

export interface GraphDatabaseDiagnostics {
  schemaVersion: number;
  legacyImported: boolean;
  changeSequence: number;
}

export interface GraphChangeEvent {
  sequence: number;
  syncedAt: string;
  delta: GraphSyncDelta;
}

export interface GraphNodeWithRevision {
  node: MemoryGraphNode;
  revision: MemoryGraphRevision;
}

export interface GraphStoreMetadata {
  project: string;
  schemaVersion: MemoryGraphIndex["schemaVersion"];
  indexerVersion: MemoryGraphIndex["indexerVersion"];
  syncedAt: string;
  sourceSpecs: string[];
  counts: { nodes: number; revisions: number; edges: number };
}

export interface GraphVisualizationSnapshot {
  schemaVersion: "refinery.graph-visualization.v1";
  syncedAt: string;
  changeSequence: number;
  counts: GraphStoreMetadata["counts"];
  nodes: GraphVisualizationNode[];
  edges: GraphVisualizationEdge[];
  truncated: { nodes: boolean; edges: boolean };
}

export interface GraphVisualizationNode {
  id: string;
  label: string;
  kind: MemoryGraphNode["kind"];
  scope: string;
  sourceAdapter: string;
  hasUri: boolean;
}

export interface GraphVisualizationEdge {
  id: string;
  source: string;
  target: string;
  kind: MemoryGraphEdge["kind"];
  confidence: number;
}

export interface GraphVisualizationDelta {
  schemaVersion: "refinery.graph-visualization-delta.v1";
  afterSequence: number;
  sequence: number;
  syncedAt: string;
  counts: GraphStoreMetadata["counts"];
  resetRequired: boolean;
  hasMore: boolean;
  nodes: GraphVisualizationNode[];
  edges: GraphVisualizationEdge[];
  removedNodeIds: string[];
  removedEdgeIds: string[];
}

interface LibsqlGraphStoreOptions {
  legacyJsonPath?: string;
}

type SqlRow = Record<string, unknown>;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS graph_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS graph_source_specs (
    spec TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    source_adapter TEXT NOT NULL,
    source_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    project TEXT,
    label TEXT NOT NULL,
    uri TEXT,
    current_revision_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    UNIQUE(source_adapter, source_key)
  );
  CREATE TABLE IF NOT EXISTS graph_revisions (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    indexer_version TEXT NOT NULL,
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL,
    source_modified_at TEXT
  );
  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    source_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_revision_id TEXT NOT NULL REFERENCES graph_revisions(id) ON DELETE CASCADE,
    confidence REAL NOT NULL,
    provenance_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS graph_nodes_source_key_idx
    ON graph_nodes(source_key);
  CREATE INDEX IF NOT EXISTS graph_revisions_node_idx
    ON graph_revisions(node_id);
  CREATE INDEX IF NOT EXISTS graph_edges_source_idx
    ON graph_edges(source_node_id, kind, confidence, id);
  CREATE INDEX IF NOT EXISTS graph_edges_target_idx
    ON graph_edges(target_node_id, kind, confidence, id);
  CREATE INDEX IF NOT EXISTS graph_edges_revision_idx
    ON graph_edges(source_revision_id);
`;

const CHANGE_JOURNAL_SQL = `
  CREATE TABLE IF NOT EXISTS graph_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at TEXT NOT NULL,
    delta_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS graph_changes_synced_at_idx
    ON graph_changes(synced_at, sequence);
`;

const SEARCH_INDEX_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS graph_search USING fts5(
    node_id UNINDEXED,
    label,
    content,
    metadata,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO graph_search(node_id, label, content, metadata)
  SELECT n.id, n.label, r.content, n.metadata_json
  FROM graph_nodes n
  JOIN graph_revisions r ON r.id = n.current_revision_id;
`;

const EMPTY_DELTA: GraphSyncDelta = {
  createdNodeIds: [],
  updatedNodeIds: [],
  removedNodeIds: [],
  createdRevisionIds: [],
  removedRevisionIds: [],
  createdEdgeIds: [],
  updatedEdgeIds: [],
  removedEdgeIds: [],
};

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "was", "were", "with", "we", "you", "your",
]);

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new Error(`${label} is not stored as text`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function changed<T>(previous: T | undefined, current: T): boolean {
  return previous === undefined || json(previous) !== json(current);
}

function deriveDelta(previous: MemoryGraphIndex | null, current: MemoryGraphIndex): GraphSyncDelta {
  const previousNodes = new Map(previous?.nodes.map((node) => [node.id, node]) ?? []);
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const previousRevisionIds = new Set(previous?.revisions.map((revision) => revision.id) ?? []);
  const currentRevisionIds = new Set(current.revisions.map((revision) => revision.id));
  const previousEdges = new Map(previous?.edges.map((edge) => [edge.id, edge]) ?? []);
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));
  return {
    createdNodeIds: [...currentNodes.keys()].filter((id) => !previousNodes.has(id)).sort(),
    updatedNodeIds: [...currentNodes.entries()]
      .filter(([id, node]) => previousNodes.has(id) && changed(previousNodes.get(id), node))
      .map(([id]) => id)
      .sort(),
    removedNodeIds: [...previousNodes.keys()].filter((id) => !currentNodes.has(id)).sort(),
    createdRevisionIds: [...currentRevisionIds].filter((id) => !previousRevisionIds.has(id)).sort(),
    removedRevisionIds: [...previousRevisionIds].filter((id) => !currentRevisionIds.has(id)).sort(),
    createdEdgeIds: [...currentEdges.keys()].filter((id) => !previousEdges.has(id)).sort(),
    updatedEdgeIds: [...currentEdges.entries()]
      .filter(([id, edge]) => previousEdges.has(id) && changed(previousEdges.get(id), edge))
      .map(([id]) => id)
      .sort(),
    removedEdgeIds: [...previousEdges.keys()].filter((id) => !currentEdges.has(id)).sort(),
  };
}

function normalizedDelta(value: Partial<GraphSyncDelta>): GraphSyncDelta {
  const ids = (key: keyof GraphSyncDelta, optional = false): string[] => {
    const candidate = value[key];
    if (candidate === undefined && optional) return [];
    if (!Array.isArray(candidate) || candidate.some((id) => typeof id !== "string")) {
      throw new Error(`graph change ${key} is not a string array`);
    }
    return [...candidate].sort();
  };
  return {
    createdNodeIds: ids("createdNodeIds"),
    updatedNodeIds: ids("updatedNodeIds"),
    removedNodeIds: ids("removedNodeIds"),
    createdRevisionIds: ids("createdRevisionIds"),
    removedRevisionIds: ids("removedRevisionIds"),
    createdEdgeIds: ids("createdEdgeIds"),
    updatedEdgeIds: ids("updatedEdgeIds", true),
    removedEdgeIds: ids("removedEdgeIds"),
  };
}

function visualNode(row: SqlRow): GraphVisualizationNode {
  return {
    id: asString(row.id, "visual node id"),
    label: asString(row.label, "visual node label"),
    kind: asString(row.kind, "visual node kind") as MemoryGraphNode["kind"],
    scope: asString(row.scope, "visual node scope"),
    sourceAdapter: asString(row.source_adapter, "visual node source adapter"),
    hasUri: row.uri !== null,
  };
}

function visualEdge(row: SqlRow): GraphVisualizationEdge {
  return {
    id: asString(row.id, "visual edge id"),
    source: asString(row.source_node_id, "visual edge source"),
    target: asString(row.target_node_id, "visual edge target"),
    kind: asString(row.kind, "visual edge kind") as MemoryGraphEdge["kind"],
    confidence: asNumber(row.confidence, "visual edge confidence"),
  };
}

function chunks<T>(values: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not text`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : asString(value, label);
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error(`${label} is not numeric`);
  return Number(value);
}

export class LibsqlGraphStore implements GraphStore {
  readonly location: string;
  readonly legacyJsonPath: string | null;
  #database: Database.Database | null = null;
  #legacyImported = false;

  constructor(location: string, options: LibsqlGraphStoreOptions = {}) {
    this.location = location === ":memory:" ? location : path.resolve(location);
    this.legacyJsonPath = options.legacyJsonPath ? path.resolve(options.legacyJsonPath) : null;
  }

  close(): void {
    if (!this.#database) return;
    this.#database.close();
    this.#database = null;
    this.#secureFiles();
  }

  #secureFiles(): void {
    if (this.location === ":memory:") return;
    fs.chmodSync(path.dirname(this.location), 0o700);
    for (const candidate of [this.location, `${this.location}-wal`, `${this.location}-shm`]) {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    }
  }

  #open(): Database.Database {
    if (this.#database) return this.#database;
    if (this.location !== ":memory:") {
      fs.mkdirSync(path.dirname(this.location), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(this.location), 0o700);
    }
    const database = new Database(this.location, { timeout: 5_000 });
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("busy_timeout = 5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS graph_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const currentRow = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM graph_migrations").get() as SqlRow;
    const currentVersion = asNumber(currentRow.version, "migration version");
    if (currentVersion > graphDatabaseSchemaVersion) {
      database.close();
      throw new RefineryError(
        "GRAPH_SCHEMA_UNSUPPORTED",
        `Graph database schema ${currentVersion} is newer than supported schema ${graphDatabaseSchemaVersion}. Upgrade Refinery before opening it.`,
        { phase: "graph-migration", details: { graphPath: this.location, currentVersion, supportedVersion: graphDatabaseSchemaVersion } },
      );
    }
    const migrations = [
      { version: 1, sql: SCHEMA_SQL },
      { version: 2, sql: CHANGE_JOURNAL_SQL },
      { version: 3, sql: SEARCH_INDEX_SQL },
    ];
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare("INSERT INTO graph_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      }).immediate();
    }
    this.#database = database;
    this.#secureFiles();
    return database;
  }

  #hasGraph(database: Database.Database): boolean {
    return database.prepare("SELECT 1 AS present FROM graph_meta WHERE key = 'project'").get() !== undefined;
  }

  #importLegacyIfNeeded(): void {
    const database = this.#open();
    if (this.#hasGraph(database) || !this.legacyJsonPath || !fs.existsSync(this.legacyJsonPath)) return;
    const legacy = new JsonGraphStore(this.legacyJsonPath).read();
    if (!legacy) return;
    this.write(legacy, null);
    database.prepare(
      "INSERT OR REPLACE INTO graph_meta(key, value) VALUES ('legacy_imported', 'true')",
    ).run();
    this.#legacyImported = true;
  }

  read(): MemoryGraphIndex | null {
    try {
      if (
        this.location !== ":memory:"
        && !this.#database
        && !fs.existsSync(this.location)
        && (!this.legacyJsonPath || !fs.existsSync(this.legacyJsonPath))
      ) return null;
      this.#importLegacyIfNeeded();
      const database = this.#open();
      const metaRows = database.prepare("SELECT key, value FROM graph_meta").all() as SqlRow[];
      const meta = new Map(metaRows.map((row) => [asString(row.key, "meta key"), asString(row.value, "meta value")]));
      const project = meta.get("project");
      if (!project) return null;
      const nodes = (database.prepare("SELECT * FROM graph_nodes ORDER BY id").all() as SqlRow[]).map((row): MemoryGraphNode => ({
        id: asString(row.id, "node id"),
        sourceAdapter: asString(row.source_adapter, "node source adapter"),
        sourceKey: asString(row.source_key, "node source key"),
        kind: asString(row.kind, "node kind") as MemoryGraphNode["kind"],
        scope: asString(row.scope, "node scope"),
        project: nullableString(row.project, "node project"),
        label: asString(row.label, "node label"),
        uri: nullableString(row.uri, "node uri"),
        currentRevisionId: asString(row.current_revision_id, "current revision id"),
        metadata: parseJson<Record<string, unknown>>(row.metadata_json, "node metadata"),
      }));
      const revisions = (database.prepare("SELECT * FROM graph_revisions ORDER BY id").all() as SqlRow[]).map((row): MemoryGraphRevision => ({
        id: asString(row.id, "revision id"),
        nodeId: asString(row.node_id, "revision node id"),
        contentHash: asString(row.content_hash, "revision content hash"),
        indexerVersion: asString(row.indexer_version, "revision indexer version") as MemoryGraphRevision["indexerVersion"],
        content: asString(row.content, "revision content"),
        charCount: asNumber(row.char_count, "revision char count"),
        indexedAt: asString(row.indexed_at, "revision indexed at"),
        sourceModifiedAt: nullableString(row.source_modified_at, "revision source modified at"),
      }));
      const edges = (database.prepare("SELECT * FROM graph_edges ORDER BY id").all() as SqlRow[]).map((row): MemoryGraphEdge => ({
        id: asString(row.id, "edge id"),
        sourceNodeId: asString(row.source_node_id, "edge source node id"),
        targetNodeId: asString(row.target_node_id, "edge target node id"),
        kind: asString(row.kind, "edge kind") as MemoryGraphEdge["kind"],
        sourceRevisionId: asString(row.source_revision_id, "edge source revision id"),
        confidence: asNumber(row.confidence, "edge confidence"),
        provenance: parseJson<MemoryGraphEdge["provenance"]>(row.provenance_json, "edge provenance"),
      }));
      const sourceSpecs = (database.prepare("SELECT spec FROM graph_source_specs ORDER BY spec").all() as SqlRow[])
        .map((row) => asString(row.spec, "source spec"));
      return {
        schemaVersion: (meta.get("schema_version") ?? memoryGraphSchemaVersion) as MemoryGraphIndex["schemaVersion"],
        indexerVersion: (meta.get("indexer_version") ?? memoryGraphIndexerVersion) as MemoryGraphIndex["indexerVersion"],
        project,
        sourceSpecs,
        syncedAt: meta.get("synced_at") ?? "",
        nodes,
        revisions,
        edges,
      };
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not read Refinery graph database at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location } },
      );
    }
  }

  write(index: MemoryGraphIndex, previous: MemoryGraphIndex | null = null, delta?: GraphSyncDelta): void {
    try {
      const database = this.#open();
      const before = previous ?? (this.#hasGraph(database) ? this.read() : null);
      const previousNodes = new Map(before?.nodes.map((node) => [node.id, node]) ?? []);
      const previousRevisions = new Map(before?.revisions.map((revision) => [revision.id, revision]) ?? []);
      const previousEdges = new Map(before?.edges.map((edge) => [edge.id, edge]) ?? []);
      const currentNodes = new Map(index.nodes.map((node) => [node.id, node]));
      const currentRevisions = new Map(index.revisions.map((revision) => [revision.id, revision]));
      const currentNodeIds = new Set(index.nodes.map((node) => node.id));
      const currentRevisionIds = new Set(index.revisions.map((revision) => revision.id));
      const currentEdgeIds = new Set(index.edges.map((edge) => edge.id));
      const recordedDelta = delta ?? deriveDelta(before, index);
      const transaction = database.transaction(() => {
        const deleteEdge = database.prepare("DELETE FROM graph_edges WHERE id = ?");
        for (const id of previousEdges.keys()) if (!currentEdgeIds.has(id)) deleteEdge.run(id);
        const deleteNode = database.prepare("DELETE FROM graph_nodes WHERE id = ?");
        for (const id of previousNodes.keys()) if (!currentNodeIds.has(id)) deleteNode.run(id);

        const upsertNode = database.prepare(`
          INSERT INTO graph_nodes(
            id, source_adapter, source_key, kind, scope, project, label, uri,
            current_revision_id, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_adapter=excluded.source_adapter, source_key=excluded.source_key,
            kind=excluded.kind, scope=excluded.scope, project=excluded.project,
            label=excluded.label, uri=excluded.uri,
            current_revision_id=excluded.current_revision_id,
            metadata_json=excluded.metadata_json
        `);
        for (const node of index.nodes) {
          if (!changed(previousNodes.get(node.id), node)) continue;
          upsertNode.run(
            node.id, node.sourceAdapter, node.sourceKey, node.kind, node.scope,
            node.project, node.label, node.uri, node.currentRevisionId, json(node.metadata),
          );
        }

        const insertRevision = database.prepare(`
          INSERT OR REPLACE INTO graph_revisions(
            id, node_id, content_hash, indexer_version, content, char_count,
            indexed_at, source_modified_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const revision of index.revisions) {
          if (!changed(previousRevisions.get(revision.id), revision)) continue;
          insertRevision.run(
            revision.id, revision.nodeId, revision.contentHash,
            revision.indexerVersion, revision.content, revision.charCount,
            revision.indexedAt, revision.sourceModifiedAt,
          );
        }

        const changedSearchNodeIds = new Set([
          ...recordedDelta.createdNodeIds,
          ...recordedDelta.updatedNodeIds,
          ...recordedDelta.createdRevisionIds
            .map((revisionId) => currentRevisions.get(revisionId)?.nodeId)
            .filter((nodeId): nodeId is string => Boolean(nodeId)),
        ]);
        const deleteSearch = database.prepare("DELETE FROM graph_search WHERE node_id = ?");
        for (const nodeId of [...recordedDelta.removedNodeIds, ...changedSearchNodeIds]) deleteSearch.run(nodeId);
        const insertSearch = database.prepare(
          "INSERT INTO graph_search(node_id, label, content, metadata) VALUES (?, ?, ?, ?)",
        );
        for (const nodeId of [...changedSearchNodeIds].sort()) {
          const node = currentNodes.get(nodeId);
          const revision = node ? currentRevisions.get(node.currentRevisionId) : undefined;
          if (!node || !revision) continue;
          insertSearch.run(node.id, node.label, revision.content, json(node.metadata));
        }

        const deleteRevision = database.prepare("DELETE FROM graph_revisions WHERE id = ?");
        for (const id of previousRevisions.keys()) if (!currentRevisionIds.has(id)) deleteRevision.run(id);

        const upsertEdge = database.prepare(`
          INSERT INTO graph_edges(
            id, source_node_id, target_node_id, kind, source_revision_id,
            confidence, provenance_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_node_id=excluded.source_node_id,
            target_node_id=excluded.target_node_id,
            kind=excluded.kind,
            source_revision_id=excluded.source_revision_id,
            confidence=excluded.confidence,
            provenance_json=excluded.provenance_json
        `);
        for (const edge of index.edges) {
          if (!changed(previousEdges.get(edge.id), edge)) continue;
          upsertEdge.run(
            edge.id, edge.sourceNodeId, edge.targetNodeId, edge.kind,
            edge.sourceRevisionId, edge.confidence, json(edge.provenance),
          );
        }

        database.prepare("DELETE FROM graph_source_specs").run();
        const insertSpec = database.prepare("INSERT INTO graph_source_specs(spec) VALUES (?)");
        for (const spec of index.sourceSpecs) insertSpec.run(spec);
        const setMeta = database.prepare("INSERT OR REPLACE INTO graph_meta(key, value) VALUES (?, ?)");
        for (const [key, value] of [
          ["schema_version", index.schemaVersion],
          ["indexer_version", index.indexerVersion],
          ["project", index.project],
          ["synced_at", index.syncedAt],
        ] as const) setMeta.run(key, value);
        database.prepare("INSERT INTO graph_changes(synced_at, delta_json) VALUES (?, ?)")
          .run(index.syncedAt, json(recordedDelta));
        database.prepare(`
          DELETE FROM graph_changes
          WHERE sequence <= COALESCE((SELECT MAX(sequence) - 1000 FROM graph_changes), 0)
        `).run();
        const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
        if (foreignKeyFailures.length > 0) throw new Error("graph database foreign-key integrity check failed");
      });
      transaction.immediate();
      this.#secureFiles();
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_STORE_WRITE_FAILED",
        `Could not write Refinery graph database at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location } },
      );
    }
  }

  diagnostics(): GraphDatabaseDiagnostics {
    try {
      this.#importLegacyIfNeeded();
      const database = this.#open();
      const row = database.prepare("SELECT MAX(version) AS version FROM graph_migrations").get() as SqlRow;
      const imported = database.prepare("SELECT value FROM graph_meta WHERE key = 'legacy_imported'").get() as SqlRow | undefined;
      const change = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM graph_changes").get() as SqlRow;
      return {
        schemaVersion: asNumber(row.version, "migration version"),
        legacyImported: this.#legacyImported || imported?.value === "true",
        changeSequence: asNumber(change.sequence, "change sequence"),
      };
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not inspect Refinery graph database at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location } },
      );
    }
  }

  readChanges(options: { afterSequence?: number; limit?: number } = {}): GraphChangeEvent[] {
    try {
      const database = this.#open();
      const afterSequence = Math.max(0, Math.floor(options.afterSequence ?? 0));
      const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 100)));
      const rows = database.prepare(`
        SELECT sequence, synced_at, delta_json
        FROM graph_changes
        WHERE sequence > ?
        ORDER BY sequence
        LIMIT ?
      `).all(afterSequence, limit) as SqlRow[];
      return rows.map((row) => ({
        sequence: asNumber(row.sequence, "change sequence"),
        syncedAt: asString(row.synced_at, "change synced at"),
        delta: normalizedDelta(parseJson<Partial<GraphSyncDelta>>(row.delta_json, "change delta") ?? EMPTY_DELTA),
      }));
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not read Refinery graph changes at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location } },
      );
    }
  }

  findCurrentNode(identifier: string): GraphNodeWithRevision | null {
    try {
      const database = this.#open();
      const row = database.prepare(`
        SELECT * FROM graph_nodes
        WHERE id = ? OR source_key = ?
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
        LIMIT 1
      `).get(identifier, identifier, identifier) as SqlRow | undefined;
      if (!row) return null;
      const node: MemoryGraphNode = {
        id: asString(row.id, "node id"),
        sourceAdapter: asString(row.source_adapter, "node source adapter"),
        sourceKey: asString(row.source_key, "node source key"),
        kind: asString(row.kind, "node kind") as MemoryGraphNode["kind"],
        scope: asString(row.scope, "node scope"),
        project: nullableString(row.project, "node project"),
        label: asString(row.label, "node label"),
        uri: nullableString(row.uri, "node uri"),
        currentRevisionId: asString(row.current_revision_id, "current revision id"),
        metadata: parseJson<Record<string, unknown>>(row.metadata_json, "node metadata"),
      };
      const revisionRow = database.prepare("SELECT * FROM graph_revisions WHERE id = ?").get(node.currentRevisionId) as SqlRow | undefined;
      if (!revisionRow) {
        throw new Error(`current revision ${node.currentRevisionId} for graph node ${node.id} is missing`);
      }
      const revision: MemoryGraphRevision = {
        id: asString(revisionRow.id, "revision id"),
        nodeId: asString(revisionRow.node_id, "revision node id"),
        contentHash: asString(revisionRow.content_hash, "revision content hash"),
        indexerVersion: asString(revisionRow.indexer_version, "revision indexer version") as MemoryGraphRevision["indexerVersion"],
        content: asString(revisionRow.content, "revision content"),
        charCount: asNumber(revisionRow.char_count, "revision char count"),
        indexedAt: asString(revisionRow.indexed_at, "revision indexed at"),
        sourceModifiedAt: nullableString(revisionRow.source_modified_at, "revision source modified at"),
      };
      return { node, revision };
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not query Refinery graph node at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location, identifier } },
      );
    }
  }

  findFirstEligibleNode(projectInput: string, scope: string): GraphNodeWithRevision | null {
    try {
      const database = this.#open();
      const scopeSql = scope === "global"
        ? "scope = 'global'"
        : "(scope = 'global' OR project = ?)";
      const parameters = scope === "global" ? [] : [path.resolve(projectInput)];
      const row = database.prepare(`
        SELECT id FROM graph_nodes
        WHERE kind IN ('memory', 'session', 'skill', 'source_document')
          AND ${scopeSql}
        ORDER BY id
        LIMIT 1
      `).get(...parameters) as SqlRow | undefined;
      return row ? this.findCurrentNode(asString(row.id, "fallback node id")) : null;
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not query a fallback Refinery graph node at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-search", details: { graphPath: this.location } },
      );
    }
  }

  readAdjacentEdges(options: {
    nodeId: string;
    direction?: "both" | "incoming" | "outgoing";
    edgeKinds: MemoryGraphEdge["kind"][];
    minConfidence: number;
    limit: number;
  }): { edges: MemoryGraphEdge[]; truncated: boolean } {
    try {
      if (options.edgeKinds.length === 0 || options.limit <= 0) return { edges: [], truncated: false };
      const database = this.#open();
      const direction = options.direction ?? "both";
      const kinds = [...new Set(options.edgeKinds)].sort();
      const placeholders = kinds.map(() => "?").join(", ");
      const boundedLimit = Math.max(1, Math.min(3_001, Math.floor(options.limit))) + 1;
      let sql: string;
      let parameters: unknown[];
      if (direction === "both") {
        sql = `
          SELECT * FROM (
            SELECT * FROM graph_edges
            WHERE source_node_id = ? AND kind IN (${placeholders}) AND confidence >= ?
            UNION
            SELECT * FROM graph_edges
            WHERE target_node_id = ? AND kind IN (${placeholders}) AND confidence >= ?
          ) ORDER BY id LIMIT ?
        `;
        parameters = [options.nodeId, ...kinds, options.minConfidence, options.nodeId, ...kinds, options.minConfidence, boundedLimit];
      } else {
        const column = direction === "incoming" ? "target_node_id" : "source_node_id";
        sql = `SELECT * FROM graph_edges WHERE ${column} = ? AND kind IN (${placeholders}) AND confidence >= ? ORDER BY id LIMIT ?`;
        parameters = [options.nodeId, ...kinds, options.minConfidence, boundedLimit];
      }
      const rows = database.prepare(sql).all(...parameters) as SqlRow[];
      const truncated = rows.length >= boundedLimit;
      const selected = truncated ? rows.slice(0, boundedLimit - 1) : rows;
      return {
        truncated,
        edges: selected.map((row): MemoryGraphEdge => ({
          id: asString(row.id, "edge id"),
          sourceNodeId: asString(row.source_node_id, "edge source node id"),
          targetNodeId: asString(row.target_node_id, "edge target node id"),
          kind: asString(row.kind, "edge kind") as MemoryGraphEdge["kind"],
          sourceRevisionId: asString(row.source_revision_id, "edge source revision id"),
          confidence: asNumber(row.confidence, "edge confidence"),
          provenance: parseJson<MemoryGraphEdge["provenance"]>(row.provenance_json, "edge provenance"),
        })),
      };
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not query Refinery graph adjacency at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location, nodeId: options.nodeId } },
      );
    }
  }

  searchNodeIds(options: {
    request: string;
    project: string;
    scope: string;
    limit: number;
  }): string[] {
    try {
      const tokens = [...new Set(
        options.request.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)
          ?.filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token)) ?? [],
      )].sort();
      if (tokens.length === 0) return [];
      const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
      const database = this.#open();
      const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit)));
      const scopeSql = options.scope === "global"
        ? "n.scope = 'global'"
        : "(n.scope = 'global' OR n.project = ?)";
      const parameters = options.scope === "global"
        ? [query, limit]
        : [query, path.resolve(options.project), limit];
      const rows = database.prepare(`
        SELECT n.id AS node_id,
          bm25(graph_search, 0.0, 6.0, 2.0, 1.0) AS rank
        FROM graph_search
        JOIN graph_nodes n ON n.id = graph_search.node_id
        WHERE graph_search MATCH ?
          AND n.kind IN ('memory', 'session', 'skill', 'source_document')
          AND ${scopeSql}
        ORDER BY rank, n.id
        LIMIT ?
      `).all(...parameters) as SqlRow[];
      return rows.map((row) => asString(row.node_id, "search node id"));
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not search Refinery graph at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-search", details: { graphPath: this.location } },
      );
    }
  }

  readMetadata(): GraphStoreMetadata | null {
    try {
      if (
        this.location !== ":memory:"
        && !this.#database
        && !fs.existsSync(this.location)
        && (!this.legacyJsonPath || !fs.existsSync(this.legacyJsonPath))
      ) return null;
      this.#importLegacyIfNeeded();
      const database = this.#open();
      const metaRows = database.prepare("SELECT key, value FROM graph_meta").all() as SqlRow[];
      const meta = new Map(metaRows.map((row) => [asString(row.key, "meta key"), asString(row.value, "meta value")]));
      const project = meta.get("project");
      if (!project) return null;
      const count = (table: string): number => {
        const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as SqlRow;
        return asNumber(row.count, `${table} count`);
      };
      return {
        project,
        schemaVersion: (meta.get("schema_version") ?? memoryGraphSchemaVersion) as MemoryGraphIndex["schemaVersion"],
        indexerVersion: (meta.get("indexer_version") ?? memoryGraphIndexerVersion) as MemoryGraphIndex["indexerVersion"],
        syncedAt: meta.get("synced_at") ?? "",
        sourceSpecs: (database.prepare("SELECT spec FROM graph_source_specs ORDER BY spec").all() as SqlRow[])
          .map((row) => asString(row.spec, "source spec")),
        counts: {
          nodes: count("graph_nodes"),
          revisions: count("graph_revisions"),
          edges: count("graph_edges"),
        },
      };
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not query Refinery graph metadata at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-store", details: { graphPath: this.location } },
      );
    }
  }

  readVisualizationSnapshot(options: { maxNodes: number; maxEdges: number }): GraphVisualizationSnapshot | null {
    try {
      const metadata = this.readMetadata();
      if (!metadata) return null;
      const database = this.#open();
      const maxNodes = Math.max(1, Math.min(50_000, Math.floor(options.maxNodes)));
      const maxEdges = Math.max(0, Math.min(200_000, Math.floor(options.maxEdges)));
      const nodeRows = database.prepare(`
        SELECT id, label, kind, scope, source_adapter, uri
        FROM graph_nodes
        ORDER BY id
        LIMIT ?
      `).all(maxNodes) as SqlRow[];
      const edgeRows = maxEdges === 0 ? [] : database.prepare(`
        WITH selected(id) AS MATERIALIZED (
          SELECT id FROM graph_nodes ORDER BY id LIMIT ?
        )
        SELECT e.id, e.source_node_id, e.target_node_id, e.kind, e.confidence
        FROM graph_edges e
        JOIN selected source ON source.id = e.source_node_id
        JOIN selected target ON target.id = e.target_node_id
        ORDER BY e.id
        LIMIT ?
      `).all(maxNodes, maxEdges) as SqlRow[];
      return {
        schemaVersion: "refinery.graph-visualization.v1",
        syncedAt: metadata.syncedAt,
        changeSequence: this.diagnostics().changeSequence,
        counts: metadata.counts,
        nodes: nodeRows.map(visualNode),
        edges: edgeRows.map(visualEdge),
        truncated: {
          nodes: metadata.counts.nodes > nodeRows.length,
          edges: metadata.counts.edges > edgeRows.length,
        },
      };
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not build Refinery graph visualization at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-visualization", details: { graphPath: this.location } },
      );
    }
  }

  readVisualizationDelta(options: {
    afterSequence: number;
    maxEvents?: number;
    maxNodeChanges?: number;
    maxEdgeChanges?: number;
  }): GraphVisualizationDelta {
    try {
      const metadata = this.readMetadata();
      if (!metadata) {
        throw new RefineryError("GRAPH_INDEX_NOT_FOUND", "Memory graph index does not exist. Run graph sync first.", { phase: "graph-visualization" });
      }
      const database = this.#open();
      const afterSequence = Math.max(0, Math.floor(options.afterSequence));
      const maxEvents = Math.max(1, Math.min(100, Math.floor(options.maxEvents ?? 50)));
      const maxNodeChanges = Math.max(1, Math.min(5_000, Math.floor(options.maxNodeChanges ?? 5_000)));
      const maxEdgeChanges = Math.max(0, Math.min(20_000, Math.floor(options.maxEdgeChanges ?? 20_000)));
      const bounds = database.prepare(`
        SELECT COALESCE(MIN(sequence), 0) AS earliest, COALESCE(MAX(sequence), 0) AS latest
        FROM graph_changes
      `).get() as SqlRow;
      const earliest = asNumber(bounds.earliest, "earliest change sequence");
      const latest = asNumber(bounds.latest, "latest change sequence");
      const resetRequired = afterSequence > latest || (earliest > 0 && afterSequence < earliest - 1);
      if (resetRequired || afterSequence === latest) {
        return {
          schemaVersion: "refinery.graph-visualization-delta.v1",
          afterSequence,
          sequence: latest,
          syncedAt: metadata.syncedAt,
          counts: metadata.counts,
          resetRequired,
          hasMore: false,
          nodes: [],
          edges: [],
          removedNodeIds: [],
          removedEdgeIds: [],
        };
      }

      const events = this.readChanges({ afterSequence, limit: maxEvents });
      const changedNodeIds = new Set<string>();
      const removedNodeIds = new Set<string>();
      const changedEdgeIds = new Set<string>();
      const removedEdgeIds = new Set<string>();
      for (const event of events) {
        for (const id of [...event.delta.createdNodeIds, ...event.delta.updatedNodeIds]) {
          removedNodeIds.delete(id);
          changedNodeIds.add(id);
        }
        for (const id of event.delta.removedNodeIds) {
          changedNodeIds.delete(id);
          removedNodeIds.add(id);
        }
        for (const id of [...event.delta.createdEdgeIds, ...event.delta.updatedEdgeIds]) {
          removedEdgeIds.delete(id);
          changedEdgeIds.add(id);
        }
        for (const id of event.delta.removedEdgeIds) {
          changedEdgeIds.delete(id);
          removedEdgeIds.add(id);
        }
      }

      if (changedNodeIds.size + removedNodeIds.size > maxNodeChanges
        || changedEdgeIds.size + removedEdgeIds.size > maxEdgeChanges) {
        return {
          schemaVersion: "refinery.graph-visualization-delta.v1",
          afterSequence,
          sequence: latest,
          syncedAt: metadata.syncedAt,
          counts: metadata.counts,
          resetRequired: true,
          hasMore: false,
          nodes: [],
          edges: [],
          removedNodeIds: [],
          removedEdgeIds: [],
        };
      }

      const nodes: GraphVisualizationNode[] = [];
      for (const ids of chunks([...changedNodeIds].sort())) {
        const placeholders = ids.map(() => "?").join(", ");
        const rows = database.prepare(`
          SELECT id, label, kind, scope, source_adapter, uri
          FROM graph_nodes WHERE id IN (${placeholders}) ORDER BY id
        `).all(...ids) as SqlRow[];
        nodes.push(...rows.map(visualNode));
      }
      const edges: GraphVisualizationEdge[] = [];
      for (const ids of chunks([...changedEdgeIds].sort())) {
        const placeholders = ids.map(() => "?").join(", ");
        const rows = database.prepare(`
          SELECT id, source_node_id, target_node_id, kind, confidence
          FROM graph_edges WHERE id IN (${placeholders}) ORDER BY id
        `).all(...ids) as SqlRow[];
        edges.push(...rows.map(visualEdge));
      }
      const sequence = events.at(-1)?.sequence ?? afterSequence;
      return {
        schemaVersion: "refinery.graph-visualization-delta.v1",
        afterSequence,
        sequence,
        syncedAt: events.at(-1)?.syncedAt ?? metadata.syncedAt,
        counts: metadata.counts,
        resetRequired: false,
        hasMore: sequence < latest,
        nodes,
        edges,
        removedNodeIds: [...removedNodeIds].sort(),
        removedEdgeIds: [...removedEdgeIds].sort(),
      };
    } catch (error) {
      if (error instanceof RefineryError) throw error;
      throw new RefineryError(
        "GRAPH_INDEX_INVALID",
        `Could not build Refinery graph visualization delta at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "graph-visualization", details: { graphPath: this.location } },
      );
    }
  }
}
