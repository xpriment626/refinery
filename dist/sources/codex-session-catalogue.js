import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";
import { RefineryError } from "../core/errors.js";
import { resolveRefineryPaths } from "../core/paths.js";
import { cwdMatchesFilter, cwdSetMatchesFilter, sessionIndexerSchemaVersion, } from "./codex-session-parser.js";
export const sessionCatalogueSchemaVersion = 3;
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS session_catalogue_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_files (
    file_path TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ns TEXT NOT NULL,
    scan_mode TEXT NOT NULL CHECK(scan_mode IN ('header', 'scope', 'full')),
    content_indexed INTEGER NOT NULL DEFAULT 0,
    unit_count INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL,
    session_meta_cwd TEXT,
    cwd_json TEXT NOT NULL,
    first_timestamp TEXT,
    last_timestamp TEXT,
    line_count INTEGER NOT NULL,
    mixed_scope INTEGER NOT NULL,
    parse_failures INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_files_identity_idx
    ON session_files(identity, size_bytes, mtime_ns);
  CREATE INDEX IF NOT EXISTS session_files_session_idx
    ON session_files(session_id, last_timestamp);
  CREATE TABLE IF NOT EXISTS session_units (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL REFERENCES session_files(file_path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_timestamp TEXT,
    end_timestamp TEXT,
    cwd_json TEXT NOT NULL,
    phase TEXT NOT NULL,
    boundary_json TEXT NOT NULL,
    text TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    UNIQUE(file_path, ordinal)
  );
  CREATE INDEX IF NOT EXISTS session_units_recency_idx
    ON session_units(end_timestamp, start_timestamp, session_id, ordinal);
`;
const SEARCH_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS session_unit_search USING fts5(
    unit_id UNINDEXED,
    file_path UNINDEXED,
    session_id UNINDEXED,
    text,
    metadata,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS session_units_search_insert
  AFTER INSERT ON session_units BEGIN
    INSERT INTO session_unit_search(unit_id, file_path, session_id, text, metadata)
    VALUES (new.id, new.file_path, new.session_id, new.text, new.metadata_json);
  END;
  CREATE TRIGGER IF NOT EXISTS session_units_search_delete
  AFTER DELETE ON session_units BEGIN
    DELETE FROM session_unit_search WHERE unit_id = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS session_units_search_update
  AFTER UPDATE ON session_units BEGIN
    DELETE FROM session_unit_search WHERE unit_id = old.id;
    INSERT INTO session_unit_search(unit_id, file_path, session_id, text, metadata)
    VALUES (new.id, new.file_path, new.session_id, new.text, new.metadata_json);
  END;
`;
const SEARCH_STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
    "or", "that", "the", "this", "to", "was", "were", "with", "we", "you", "your",
]);
function hash(prefix, parts) {
    const digest = crypto.createHash("sha256");
    for (const part of parts)
        digest.update(part).update("\0");
    return `${prefix}:${digest.digest("hex").slice(0, 16)}`;
}
function compactText(text, max) {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}
function sourceSetFor(spec, index, metadata) {
    return {
        id: hash("source-set", [String(index), spec.raw]),
        spec,
        label: spec.raw,
        role: "codex-sessions",
        metadata,
    };
}
function walkSessionFiles(root) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
        return [];
    const files = [];
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
                pending.push(absolute);
            else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl"))
                files.push(absolute);
        }
    }
    return files.sort();
}
function fingerprints(root) {
    return walkSessionFiles(root).map((filePath) => {
        const stat = fs.statSync(filePath, { bigint: true });
        return {
            filePath,
            identity: `${stat.dev}:${stat.ino}`,
            sizeBytes: Number(stat.size),
            mtimeNs: String(stat.mtimeNs),
        };
    });
}
function filterFor(spec, project, scope) {
    if (spec.params.root)
        return { kind: "root", path: path.resolve(spec.params.root) };
    if (spec.params.scope === "global" || scope === "global")
        return { kind: "global", path: null };
    return { kind: "exact", path: path.resolve(spec.params.project ?? project) };
}
function withinDays(timestamp, days, now) {
    if (!days || !timestamp)
        return true;
    const then = new Date(timestamp).getTime();
    return Number.isNaN(then) || then >= now.getTime() - days * 24 * 60 * 60 * 1_000;
}
function secureDatabaseFiles(location) {
    if (process.platform === "win32")
        return;
    fs.chmodSync(path.dirname(location), 0o700);
    for (const candidate of [location, `${location}-wal`, `${location}-shm`]) {
        if (fs.existsSync(candidate))
            fs.chmodSync(candidate, 0o600);
    }
}
function openCatalogue(location) {
    fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32")
        fs.chmodSync(path.dirname(location), 0o700);
    const database = new Database(location, { timeout: 5_000 });
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("busy_timeout = 5000");
    database.exec(`
    CREATE TABLE IF NOT EXISTS session_catalogue_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
    const currentRow = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM session_catalogue_migrations").get();
    const currentVersion = asNumber(currentRow.version, "session catalogue migration version");
    if (currentVersion > sessionCatalogueSchemaVersion) {
        database.close();
        throw new RefineryError("SESSION_CATALOGUE_SCHEMA_UNSUPPORTED", `Session catalogue schema ${currentVersion} is newer than supported schema ${sessionCatalogueSchemaVersion}. Upgrade Refinery before opening it.`, { phase: "session-catalogue-migration", details: { cataloguePath: location, currentVersion, supportedVersion: sessionCatalogueSchemaVersion } });
    }
    database.exec(SCHEMA_SQL);
    database.prepare("INSERT OR IGNORE INTO session_catalogue_migrations(version, applied_at) VALUES (1, ?)")
        .run(new Date().toISOString());
    const searchMigration = database.prepare("SELECT 1 AS present FROM session_catalogue_migrations WHERE version = 2").get();
    if (!searchMigration) {
        database.transaction(() => {
            database.exec(SEARCH_SCHEMA_SQL);
            database.exec(`
        INSERT INTO session_unit_search(unit_id, file_path, session_id, text, metadata)
        SELECT id, file_path, session_id, text, metadata_json FROM session_units
      `);
            database.prepare("INSERT INTO session_catalogue_migrations(version, applied_at) VALUES (2, ?)")
                .run(new Date().toISOString());
        }).immediate();
    }
    else {
        database.exec(SEARCH_SCHEMA_SQL);
    }
    const completenessMigration = database.prepare("SELECT 1 AS present FROM session_catalogue_migrations WHERE version = 3").get();
    if (!completenessMigration) {
        database.transaction(() => {
            const columns = new Set(database.prepare("PRAGMA table_info(session_files)").all()
                .map((row) => asString(row.name, "session file column")));
            if (!columns.has("content_indexed")) {
                database.exec("ALTER TABLE session_files ADD COLUMN content_indexed INTEGER NOT NULL DEFAULT 0");
            }
            if (!columns.has("unit_count")) {
                database.exec("ALTER TABLE session_files ADD COLUMN unit_count INTEGER NOT NULL DEFAULT 0");
            }
            database.exec(`
        UPDATE session_files
        SET unit_count = (
          SELECT COUNT(*) FROM session_units WHERE session_units.file_path = session_files.file_path
        )
      `);
            database.prepare("INSERT INTO session_catalogue_migrations(version, applied_at) VALUES (3, ?)")
                .run(new Date().toISOString());
        }).immediate();
    }
    secureDatabaseFiles(location);
    return database;
}
export function searchSessionResponsibilityUnits(args) {
    const tokens = [...new Set(args.request.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)
            ?.filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token)) ?? [])].sort();
    if (tokens.length === 0)
        return [];
    const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    const requestedLimit = Math.max(1, Math.min(1_000, Math.floor(args.limit ?? 10)));
    const database = openCatalogue(path.resolve(args.cataloguePath));
    try {
        const rows = database.prepare(`
      SELECT
        u.id, u.session_id, u.text, u.metadata_json, f.cwd_json,
        bm25(session_unit_search, 0.0, 0.0, 0.0, 6.0, 1.0) AS rank
      FROM session_unit_search
      JOIN session_units u ON u.id = session_unit_search.unit_id
      JOIN session_files f ON f.file_path = u.file_path
      WHERE session_unit_search MATCH ?
      ORDER BY rank, u.id
      LIMIT ?
    `).all(query, Math.max(requestedLimit, Math.min(5_000, requestedLimit * 20)));
        return rows.filter((row) => {
            if (!args.root)
                return true;
            return cwdSetMatchesFilter(parseJson(row.cwd_json, "search cwd set"), {
                kind: "root",
                path: path.resolve(args.root),
            });
        }).slice(0, requestedLimit).map((row) => ({
            unitId: asString(row.id, "search unit id"),
            sessionId: asString(row.session_id, "search session id"),
            rank: asNumber(row.rank, "search rank"),
            text: asString(row.text, "search text"),
            metadata: parseJson(row.metadata_json, "search metadata"),
        }));
    }
    finally {
        database.close();
        secureDatabaseFiles(path.resolve(args.cataloguePath));
    }
}
function asString(value, label) {
    if (typeof value !== "string")
        throw new Error(`${label} is not text`);
    return value;
}
function asNumber(value, label) {
    if (typeof value !== "number" && typeof value !== "bigint")
        throw new Error(`${label} is not numeric`);
    return Number(value);
}
function nullableString(value, label) {
    return value === null ? null : asString(value, label);
}
function parseJson(value, label) {
    return JSON.parse(asString(value, label));
}
function fileRow(row) {
    const scanMode = asString(row.scan_mode, "scan mode");
    if (scanMode !== "header" && scanMode !== "scope" && scanMode !== "full")
        throw new Error("invalid session scan mode");
    return {
        filePath: asString(row.file_path, "file path"),
        identity: asString(row.identity, "identity"),
        sizeBytes: asNumber(row.size_bytes, "size"),
        mtimeNs: asString(row.mtime_ns, "mtime"),
        scanMode,
        contentIndexed: asNumber(row.content_indexed, "content indexed") === 1,
        unitCount: asNumber(row.unit_count, "unit count"),
        sessionId: asString(row.session_id, "session id"),
        sessionMetaCwd: nullableString(row.session_meta_cwd, "session cwd"),
        cwdSet: parseJson(row.cwd_json, "cwd set"),
        firstTimestamp: nullableString(row.first_timestamp, "first timestamp"),
        lastTimestamp: nullableString(row.last_timestamp, "last timestamp"),
        lineCount: asNumber(row.line_count, "line count"),
        mixedScope: asNumber(row.mixed_scope, "mixed scope") === 1,
        parseFailures: asNumber(row.parse_failures, "parse failures"),
    };
}
function sameFingerprint(left, right) {
    return left.identity === right.identity && left.sizeBytes === right.sizeBytes && left.mtimeNs === right.mtimeNs;
}
function sanitizedChildEnvironment() {
    const allowed = ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"];
    return Object.fromEntries([
        ...allowed.map((key) => [key, process.env[key]])
            .filter((entry) => typeof entry[1] === "string"),
        ["NODE_NO_WARNINGS", "1"],
    ]);
}
function validateIndexedFiles(value, requested) {
    if (!Array.isArray(value) || value.length !== requested.size)
        throw new Error("session indexer returned the wrong file count");
    const seen = new Set();
    for (const item of value) {
        if (!item || typeof item !== "object")
            throw new Error("session indexer returned a non-object file");
        const record = item;
        if (typeof record.filePath !== "string" || !requested.has(record.filePath) || seen.has(record.filePath)
            || !["header", "scope", "full"].includes(String(record.scanMode)) || !Array.isArray(record.units)) {
            throw new Error("session indexer returned an invalid file identity");
        }
        if (record.units.length > 100_000)
            throw new Error("session indexer returned too many units");
        for (const unit of record.units) {
            if (!unit || typeof unit !== "object" || typeof unit.text !== "string"
                || unit.text.length > 32_000) {
                throw new Error("session indexer returned an invalid responsibility unit");
            }
        }
        seen.add(record.filePath);
    }
    return value;
}
async function runReadOnlyIndexer(args) {
    if (args.files.length === 0)
        return { files: [], permissionModel: true };
    const requestId = crypto.randomUUID();
    const extension = path.extname(fileURLToPath(import.meta.url));
    const entryPath = path.resolve(import.meta.dirname, `session-indexer-process${extension}`);
    const runtimeRoot = path.resolve(import.meta.dirname, "..");
    const request = {
        schemaVersion: sessionIndexerSchemaVersion,
        requestId,
        filter: args.filter,
        files: args.files,
    };
    const requested = new Set(args.files.map((file) => file.filePath));
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            "--permission",
            `--allow-fs-read=${runtimeRoot}`,
            `--allow-fs-read=${path.resolve(args.sessionsDir)}`,
            entryPath,
        ], {
            cwd: process.cwd(),
            env: sanitizedChildEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let settled = false;
        const finish = (error, result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new RefineryError("SESSION_INDEX_TIMEOUT", "Read-only session indexer timed out.", {
                phase: "session-index",
                details: { timeoutMs: args.timeoutMs ?? 300_000, requestedFiles: args.files.length },
            }));
        }, args.timeoutMs ?? 300_000);
        child.on("error", (error) => finish(new RefineryError("SESSION_INDEX_START_FAILED", `Could not start read-only session indexer: ${error.message}`, { phase: "session-index" })));
        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > 256 * 1024 * 1024) {
                child.kill("SIGKILL");
                finish(new RefineryError("SESSION_INDEX_RESPONSE_TOO_LARGE", "Read-only session indexer exceeded 256MB.", { phase: "session-index" }));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            if (Buffer.concat(stderr).length < 64 * 1024)
                stderr.push(chunk);
        });
        child.on("close", (code, signal) => {
            if (settled)
                return;
            let response;
            try {
                response = JSON.parse(Buffer.concat(stdout).toString("utf8"));
            }
            catch (error) {
                finish(new RefineryError("SESSION_INDEX_PROTOCOL_ERROR", "Read-only session indexer returned invalid JSON.", {
                    phase: "session-index",
                    details: { code, signal, stderr: Buffer.concat(stderr).toString("utf8").slice(0, 2_000) },
                }));
                return;
            }
            if (response.schemaVersion !== sessionIndexerSchemaVersion || response.requestId !== requestId
                || !response.ok || !response.files || !response.isolation) {
                finish(new RefineryError("SESSION_INDEX_FAILED", response.error ?? "Read-only session indexer failed.", {
                    phase: "session-index",
                    details: { code, signal, stderr: Buffer.concat(stderr).toString("utf8").slice(0, 2_000) },
                }));
                return;
            }
            try {
                finish(undefined, {
                    files: validateIndexedFiles(response.files, requested),
                    permissionModel: response.isolation.permissionModel,
                });
            }
            catch (error) {
                finish(new RefineryError("SESSION_INDEX_PROTOCOL_ERROR", error instanceof Error ? error.message : String(error), {
                    phase: "session-index",
                }));
            }
        });
        child.stdin.end(`${JSON.stringify(request)}\n`);
    });
}
function replaceIndexedFiles(database, indexed, fingerprintsByPath) {
    const removeUnits = database.prepare("DELETE FROM session_units WHERE file_path = ?");
    const upsertFile = database.prepare(`
    INSERT INTO session_files(
      file_path, identity, size_bytes, mtime_ns, scan_mode, content_indexed, unit_count,
      session_id, session_meta_cwd, cwd_json, first_timestamp, last_timestamp, line_count,
      mixed_scope, parse_failures, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      identity = excluded.identity,
      size_bytes = excluded.size_bytes,
      mtime_ns = excluded.mtime_ns,
      scan_mode = excluded.scan_mode,
      content_indexed = excluded.content_indexed,
      unit_count = excluded.unit_count,
      session_id = excluded.session_id,
      session_meta_cwd = excluded.session_meta_cwd,
      cwd_json = excluded.cwd_json,
      first_timestamp = excluded.first_timestamp,
      last_timestamp = excluded.last_timestamp,
      line_count = excluded.line_count,
      mixed_scope = excluded.mixed_scope,
      parse_failures = excluded.parse_failures,
      indexed_at = excluded.indexed_at
  `);
    const insertUnit = database.prepare(`
    INSERT INTO session_units(
      id, file_path, ordinal, session_id, start_line, end_line, start_timestamp,
      end_timestamp, cwd_json, phase, boundary_json, text, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    database.transaction(() => {
        for (const file of indexed) {
            const fingerprint = fingerprintsByPath.get(file.filePath);
            if (!fingerprint)
                throw new Error(`missing fingerprint for ${file.filePath}`);
            removeUnits.run(file.filePath);
            upsertFile.run(file.filePath, fingerprint.identity, fingerprint.sizeBytes, fingerprint.mtimeNs, file.scanMode, file.scanMode === "full" ? 1 : 0, file.units.length, file.sessionId, file.sessionMetaCwd, JSON.stringify(file.cwdSet), file.firstTimestamp, file.lastTimestamp, file.lineCount, file.mixedScope ? 1 : 0, file.parseFailures, new Date().toISOString());
            for (const unit of file.units) {
                insertUnit.run(unit.id, file.filePath, unit.ordinal, unit.sessionId, unit.startLine, unit.endLine, unit.startTimestamp, unit.endTimestamp, JSON.stringify(unit.cwdSet), unit.phase, JSON.stringify(unit.boundaryReasons), unit.text, JSON.stringify(unit.metadata));
            }
        }
    }).immediate();
}
function removeMissingFiles(database, candidates) {
    const stored = database.prepare("SELECT file_path FROM session_files").all();
    const remove = database.prepare("DELETE FROM session_files WHERE file_path = ?");
    database.transaction(() => {
        for (const row of stored) {
            const filePath = asString(row.file_path, "stored file path");
            if (!candidates.has(filePath))
                remove.run(filePath);
        }
    }).immediate();
}
function unitFromRow(row) {
    return {
        id: asString(row.id, "unit id"),
        ordinal: asNumber(row.ordinal, "unit ordinal"),
        sessionId: asString(row.session_id, "unit session id"),
        startLine: asNumber(row.start_line, "start line"),
        endLine: asNumber(row.end_line, "end line"),
        startTimestamp: nullableString(row.start_timestamp, "start timestamp"),
        endTimestamp: nullableString(row.end_timestamp, "end timestamp"),
        cwdSet: parseJson(row.unit_cwd_json, "unit cwd set"),
        phase: asString(row.phase, "unit phase"),
        boundaryReasons: parseJson(row.boundary_json, "unit boundaries"),
        text: asString(row.text, "unit text"),
        metadata: parseJson(row.metadata_json, "unit metadata"),
        file: fileRow(row),
    };
}
export async function loadCodexSessionsFromCatalogue(args) {
    const sessionsDir = resolveCodexSessionsDir(args.spec.params.home);
    const scopeFilter = filterFor(args.spec, args.project, args.scope);
    const days = args.spec.params.days ? Number.parseInt(args.spec.params.days, 10) : null;
    if (days !== null && (!Number.isFinite(days) || days < 1)) {
        throw new RefineryError("INVALID_SOURCE_SPEC", "codex:sessions days must be a positive integer.", { phase: "args" });
    }
    const baseDiagnostics = {
        schemaVersion: "refinery.session-catalogue-diagnostics.v1",
        candidateFiles: 0,
        cacheHits: 0,
        changedFiles: 0,
        requestedFiles: 0,
        headerScans: 0,
        scopeScans: 0,
        fullScans: 0,
        excludedBeforeContentRead: 0,
        mixedScopeRejected: 0,
        unchangedContentReads: 0,
        contentBytesRead: 0,
        scopeBytesRead: 0,
        selectedUnits: 0,
        parseFailures: 0,
    };
    if (!fs.existsSync(sessionsDir)) {
        const sourceSet = sourceSetFor(args.spec, args.index, { catalogue: baseDiagnostics });
        return {
            sourceSet,
            documents: [],
            warnings: [`Codex sessions directory not found: ${sessionsDir}`],
            diagnostics: baseDiagnostics,
            isolation: { processSeparated: true, permissionModel: true },
        };
    }
    const cataloguePath = resolveRefineryPaths({ cwd: args.project, home: args.home }).sessionCataloguePath;
    const database = openCatalogue(cataloguePath);
    try {
        const candidates = fingerprints(sessionsDir);
        const byPath = new Map(candidates.map((candidate) => [candidate.filePath, candidate]));
        const cached = new Map(database.prepare("SELECT * FROM session_files").all()
            .map((row) => fileRow(row)).map((row) => [row.filePath, row]));
        const requests = [];
        const diagnostics = { ...baseDiagnostics, candidateFiles: candidates.length };
        for (const candidate of candidates) {
            const previous = cached.get(candidate.filePath);
            if (!previous || !sameFingerprint(previous, candidate)) {
                requests.push({ filePath: candidate.filePath, mode: "probe", unchanged: false });
                diagnostics.changedFiles += 1;
                continue;
            }
            if (previous.scanMode === "full" && previous.contentIndexed) {
                diagnostics.cacheHits += 1;
                if (!cwdSetMatchesFilter(previous.cwdSet, scopeFilter)) {
                    if (cwdMatchesFilter(previous.sessionMetaCwd, scopeFilter))
                        diagnostics.mixedScopeRejected += 1;
                    else
                        diagnostics.excludedBeforeContentRead += 1;
                }
                continue;
            }
            if (previous.scanMode === "header" && !cwdMatchesFilter(previous.sessionMetaCwd, scopeFilter)) {
                diagnostics.cacheHits += 1;
                diagnostics.excludedBeforeContentRead += 1;
                continue;
            }
            if (previous.scanMode === "scope" && !cwdSetMatchesFilter(previous.cwdSet, scopeFilter)) {
                diagnostics.cacheHits += 1;
                diagnostics.mixedScopeRejected += 1;
                continue;
            }
            requests.push({ filePath: candidate.filePath, mode: "full", unchanged: true });
        }
        diagnostics.requestedFiles = requests.length;
        const indexed = await runReadOnlyIndexer({
            sessionsDir,
            filter: scopeFilter,
            files: requests.map(({ filePath, mode }) => ({ filePath, mode })),
        });
        const unchangedRequested = new Set(requests.filter((request) => request.unchanged).map((request) => request.filePath));
        for (const file of indexed.files) {
            diagnostics.parseFailures += file.parseFailures;
            diagnostics.scopeBytesRead += file.scopeBytesRead;
            diagnostics.contentBytesRead += file.bytesRead;
            if (file.scanMode === "header") {
                diagnostics.headerScans += 1;
                diagnostics.excludedBeforeContentRead += 1;
            }
            else if (file.scanMode === "scope") {
                diagnostics.scopeScans += 1;
                diagnostics.mixedScopeRejected += 1;
            }
            else {
                diagnostics.fullScans += 1;
                if (unchangedRequested.has(file.filePath))
                    diagnostics.unchangedContentReads += 1;
            }
        }
        replaceIndexedFiles(database, indexed.files, byPath);
        removeMissingFiles(database, new Set(byPath.keys()));
        const rows = database.prepare(`
      SELECT
        u.id, u.ordinal, u.session_id, u.start_line, u.end_line, u.start_timestamp,
        u.end_timestamp, u.cwd_json AS unit_cwd_json, u.phase, u.boundary_json,
        u.text, u.metadata_json,
        f.file_path, f.identity, f.size_bytes, f.mtime_ns, f.scan_mode,
        f.content_indexed, f.unit_count,
        f.session_id AS file_session_id, f.session_meta_cwd, f.cwd_json,
        f.first_timestamp, f.last_timestamp, f.line_count, f.mixed_scope, f.parse_failures
      FROM session_units u
      JOIN session_files f ON f.file_path = u.file_path
      WHERE f.scan_mode = 'full'
      ORDER BY COALESCE(u.end_timestamp, u.start_timestamp, f.last_timestamp, '') DESC,
        u.session_id, u.ordinal
    `).all();
        const selected = rows.map(unitFromRow)
            .filter((unit) => cwdSetMatchesFilter(unit.file.cwdSet, scopeFilter))
            .filter((unit) => withinDays(unit.endTimestamp ?? unit.startTimestamp ?? unit.file.lastTimestamp, days, args.now))
            .slice(0, Math.max(1, args.limits.sourceLimit));
        diagnostics.selectedUnits = selected.length;
        const scopePathHash = scopeFilter.path ? hash("path", [scopeFilter.path]) : null;
        const sourceSet = sourceSetFor(args.spec, args.index, {
            segmentation: "responsibility-unit",
            scopeKind: scopeFilter.kind,
            scopePathHash,
            days,
            catalogue: diagnostics,
        });
        const documents = selected.map((unit) => {
            const text = compactText(unit.text, args.limits.documentCharLimit);
            return {
                id: hash("source-doc", [sourceSet.id, unit.id, text]),
                sourceSet: sourceSet.id,
                role: "codex-session-responsibility-unit",
                uri: `codex-session://${encodeURIComponent(unit.sessionId)}/responsibility/${encodeURIComponent(unit.id)}`,
                text,
                metadata: {
                    ...unit.metadata,
                    sourceTextChars: unit.text.length,
                    selectedTextChars: text.length,
                    truncated: text.length < unit.text.replace(/\s+/g, " ").trim().length,
                    sourceIdentity: hash("session-source", [unit.file.identity]),
                    sourceSizeBytes: unit.file.sizeBytes,
                    sourceModifiedNs: unit.file.mtimeNs,
                    provenance: {
                        threadId: unit.sessionId,
                        unitId: unit.id,
                        lineStart: unit.startLine,
                        lineEnd: unit.endLine,
                        timestampStart: unit.startTimestamp,
                        timestampEnd: unit.endTimestamp,
                    },
                },
            };
        });
        return {
            sourceSet,
            documents,
            warnings: diagnostics.parseFailures > 0
                ? [`Skipped ${diagnostics.parseFailures} malformed session records while indexing selected sessions.`]
                : [],
            diagnostics,
            isolation: { processSeparated: true, permissionModel: indexed.permissionModel },
        };
    }
    finally {
        database.close();
        secureDatabaseFiles(cataloguePath);
    }
}
import { resolveCodexSessionsDir } from "../core/codex-paths.js";
//# sourceMappingURL=codex-session-catalogue.js.map