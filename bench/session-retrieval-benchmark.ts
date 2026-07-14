import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";
import { listCodexActiveMemories, resolveCodexMemoryHome } from "../src/sources/codex-memories.ts";
import {
  searchSessionResponsibilityUnits,
  type SessionUnitSearchResult,
} from "../src/sources/codex-session-catalogue.ts";

export interface RetrievalHoldout {
  id: string;
  query: string;
  targetSessionId: string;
  label: "real-provenance" | "fixture";
}

export interface RetrievalEvaluation {
  holdouts: number;
  recoveredAt10: number;
  recallAt10: number;
  durableLearningRecovered: number;
  validCitations: number;
  citationValidity: number;
  duplicateResultRate: number;
  results: Array<{
    holdoutId: string;
    label: RetrievalHoldout["label"];
    recovered: boolean;
    durableLearningRecovered: boolean;
    targetRank: number | null;
    evidenceTokenOverlap: number;
    citationValid: boolean;
    retrievedUnitIds: string[];
  }>;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "was", "were", "with", "we", "you", "your",
]);

function stableHash(parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)
    ?.filter((token) => token.length >= 3 && !STOP_WORDS.has(token)) ?? []);
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  return [...leftTokens].filter((token) => rightTokens.has(token)).length;
}

function citationValid(result: SessionUnitSearchResult): boolean {
  const provenance = result.metadata.provenance;
  const unitId = result.metadata.unitId;
  const sessionId = result.metadata.sessionId;
  return unitId === result.unitId
    && sessionId === result.sessionId
    && (!provenance || (typeof provenance === "object" && !Array.isArray(provenance)));
}

export function evaluateRetrievalHoldouts(args: {
  holdouts: RetrievalHoldout[];
  retrieve: (query: string, limit: number) => SessionUnitSearchResult[];
}): RetrievalEvaluation {
  const results = args.holdouts.map((holdout) => {
    const retrieved = args.retrieve(holdout.query, 10);
    const targetIndex = retrieved.findIndex((result) => result.sessionId === holdout.targetSessionId);
    const target = targetIndex >= 0 ? retrieved[targetIndex] : null;
    const overlap = target ? tokenOverlap(holdout.query, target.text) : 0;
    const allCitationsValid = retrieved.every(citationValid);
    return {
      holdoutId: holdout.id,
      label: holdout.label,
      recovered: target !== null,
      durableLearningRecovered: target !== null && overlap >= 2,
      targetRank: targetIndex >= 0 ? targetIndex + 1 : null,
      evidenceTokenOverlap: overlap,
      citationValid: allCitationsValid,
      retrievedUnitIds: retrieved.map((result) => result.unitId),
    };
  });
  const resultIds = results.flatMap((result) => result.retrievedUnitIds);
  const duplicates = results.reduce((count, result) => (
    count + result.retrievedUnitIds.length - new Set(result.retrievedUnitIds).size
  ), 0);
  const recoveredAt10 = results.filter((result) => result.recovered).length;
  const durableLearningRecovered = results.filter((result) => result.durableLearningRecovered).length;
  const validCitations = results.filter((result) => result.citationValid).length;
  return {
    holdouts: results.length,
    recoveredAt10,
    recallAt10: results.length > 0 ? recoveredAt10 / results.length : 0,
    durableLearningRecovered,
    validCitations,
    citationValidity: results.length > 0 ? validCitations / results.length : 0,
    duplicateResultRate: resultIds.length > 0 ? duplicates / resultIds.length : 0,
    results,
  };
}

function withinRoot(candidate: unknown, root: string): boolean {
  if (typeof candidate !== "string") return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function queryWithoutSilverLabel(body: string): string {
  return body
    .replace(/\([^)]*\bthread_id=[^)]*\)/gi, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, " ")
    .replace(/\/Users\/[^\s,;)]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function catalogueSessionCounts(cataloguePath: string): Map<string, number> {
  const database = new Database(cataloguePath, { readonly: true });
  try {
    const rows = database.prepare("SELECT session_id, COUNT(*) AS count FROM session_units GROUP BY session_id").all() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row.session_id), Number(row.count)]));
  } finally {
    database.close();
  }
}

function corpusIdentity(cataloguePath: string, memoryIds: string[]): { hash: string; files: number; units: number; sessions: number } {
  const database = new Database(cataloguePath, { readonly: true });
  try {
    const files = database.prepare("SELECT identity, size_bytes, mtime_ns, scan_mode FROM session_files ORDER BY file_path").all() as Array<Record<string, unknown>>;
    const count = database.prepare("SELECT COUNT(*) AS units, COUNT(DISTINCT session_id) AS sessions FROM session_units").get() as Record<string, unknown>;
    return {
      hash: stableHash([
        JSON.stringify(files.map((row) => [row.identity, row.size_bytes, row.mtime_ns, row.scan_mode])),
        JSON.stringify([...memoryIds].sort()),
      ]),
      files: files.length,
      units: Number(count.units),
      sessions: Number(count.sessions),
    };
  } finally {
    database.close();
  }
}

function selectRealHoldouts(args: {
  cataloguePath: string;
  memoryHome: string;
  root: string;
  limit: number;
}): { holdouts: RetrievalHoldout[]; eligibleMemories: number; eligibleThreads: number } {
  const sessionCounts = catalogueSessionCounts(args.cataloguePath);
  const eligible = listCodexActiveMemories({ memoryHome: args.memoryHome }).filter((memory) => {
    const threadId = memory.provenance?.threadId;
    const projectPath = memory.provenance?.projectPath;
    const query = queryWithoutSilverLabel(memory.body);
    return typeof threadId === "string" && sessionCounts.has(threadId) && withinRoot(projectPath, args.root)
      && tokens(query).size >= 3;
  });
  const byThread = new Map<string, typeof eligible>();
  for (const memory of eligible) {
    const threadId = String(memory.provenance?.threadId);
    byThread.set(threadId, [...(byThread.get(threadId) ?? []), memory]);
  }
  for (const memories of byThread.values()) memories.sort((left, right) => left.id.localeCompare(right.id));
  const holdouts: RetrievalHoldout[] = [];
  const threadIds = [...byThread.keys()].sort();
  for (let round = 0; holdouts.length < args.limit; round += 1) {
    let added = false;
    for (const threadId of threadIds) {
      const memory = byThread.get(threadId)?.[round];
      if (!memory || holdouts.length >= args.limit) continue;
      holdouts.push({
        id: `holdout:${stableHash([memory.id]).slice(0, 16)}`,
        query: queryWithoutSilverLabel(memory.body),
        targetSessionId: threadId,
        label: "real-provenance",
      });
      added = true;
    }
    if (!added) break;
  }
  return { holdouts, eligibleMemories: eligible.length, eligibleThreads: byThread.size };
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith("--") && value && !value.startsWith("--")) {
      parsed[key.slice(2)] = value;
      index += 1;
    }
  }
  return parsed;
}

export function runRealRetrievalBenchmark(args: {
  cataloguePath: string;
  memoryHome?: string;
  root: string;
  holdoutLimit?: number;
}): Record<string, unknown> {
  const started = performance.now();
  const cataloguePath = path.resolve(args.cataloguePath);
  const memoryHome = resolveCodexMemoryHome(args.memoryHome);
  const selected = selectRealHoldouts({
    cataloguePath,
    memoryHome,
    root: args.root,
    limit: Math.max(1, Math.min(100, args.holdoutLimit ?? 20)),
  });
  const evaluation = evaluateRetrievalHoldouts({
    holdouts: selected.holdouts,
    retrieve: (query, limit) => searchSessionResponsibilityUnits({
      cataloguePath,
      request: query,
      limit,
      root: args.root,
    }),
  });
  const negativeQueries = selected.holdouts.map((holdout) => `zznegative${stableHash([holdout.id]).slice(0, 24)}`);
  const negativeFalsePositives = negativeQueries.filter((query) => searchSessionResponsibilityUnits({
    cataloguePath,
    request: query,
    limit: 10,
    root: args.root,
  }).length > 0).length;
  const identity = corpusIdentity(cataloguePath, selected.holdouts.map((holdout) => holdout.id));
  return {
    schemaVersion: "refinery.session-retrieval-benchmark.v1",
    generatedAt: new Date().toISOString(),
    corpus: {
      identity: identity.hash,
      files: identity.files,
      sessions: identity.sessions,
      responsibilityUnits: identity.units,
      scopeRootHash: stableHash([path.resolve(args.root)]).slice(0, 20),
      eligibleMemories: selected.eligibleMemories,
      eligibleThreads: selected.eligibleThreads,
      holdoutShortage: Math.max(0, (args.holdoutLimit ?? 20) - selected.holdouts.length),
    },
    evaluation,
    negativeControls: {
      count: negativeQueries.length,
      falsePositives: negativeFalsePositives,
    },
    usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0 },
    latencyMs: Number((performance.now() - started).toFixed(3)),
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const values = parseArgs(process.argv.slice(2));
  if (!values.catalogue || !values.root) {
    throw new Error("Usage: node bench/session-retrieval-benchmark.ts --catalogue <db> --root <dir> [--memory-home <dir>] [--holdouts <n>] [--output <json>]");
  }
  const result = runRealRetrievalBenchmark({
    cataloguePath: values.catalogue,
    memoryHome: values["memory-home"],
    root: values.root,
    holdoutLimit: values.holdouts ? Number.parseInt(values.holdouts, 10) : undefined,
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.resolve(values.output), json, { mode: 0o600 });
  } else {
    process.stdout.write(json);
  }
}
