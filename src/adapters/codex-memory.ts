import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActiveMemory, MemoryStoreAdapter, SourceEvidence } from "../core/adapter.ts";
import { RefineryError } from "../core/errors.ts";

export interface CodexMemoryAdapterOptions {
  memoryHome?: string;
}

interface CodexMarkdownDocument {
  relPath: string;
  absPath: string;
  text: string;
  originKind: CodexOriginKind;
  sourceKind: string;
  metadata: Record<string, unknown>;
}

type CodexOriginKind = "memory-index" | "memory-summary" | "rollout-summary" | "ad-hoc-note" | "raw-memory" | "workspace-diff" | "other";

export function resolveCodexMemoryHome(memoryHome?: string): string {
  return path.resolve(memoryHome ?? path.join(os.homedir(), ".codex", "memories"));
}

function hashId(prefix: string, parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return `${prefix}:${hash.digest("hex").slice(0, 16)}`;
}

function compactText(text: string, max = 4000): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3).trimEnd()}...`;
}

function assertSafeMemoryHome(memoryHome: string): void {
  if (path.basename(memoryHome) !== "memories") {
    throw new RefineryError(
      "CODEX_MEMORY_HOME_UNSAFE",
      "memoryHome must point to a directory named memories, such as ~/.codex/memories.",
      { phase: "adapter", details: { memoryHome } },
    );
  }
}

function ensureMemoryHome(memoryHome: string): void {
  if (!fs.existsSync(memoryHome) || !fs.statSync(memoryHome).isDirectory()) {
    throw new RefineryError(
      "CODEX_MEMORY_HOME_NOT_FOUND",
      `Codex memory home does not exist: ${memoryHome}`,
      { phase: "adapter", details: { memoryHome } },
    );
  }
}

function readIfExists(memoryHome: string, relPath: string): CodexMarkdownDocument | null {
  const absPath = path.join(memoryHome, relPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
  return toDocument(memoryHome, absPath);
}

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(abs));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out.sort();
}

function originKindForRelPath(relPath: string): CodexOriginKind {
  if (relPath === "MEMORY.md") return "memory-index";
  if (relPath === "memory_summary.md") return "memory-summary";
  if (relPath === "raw_memories.md") return "raw-memory";
  if (relPath === "phase2_workspace_diff.md") return "workspace-diff";
  if (relPath.startsWith("rollout_summaries/")) return "rollout-summary";
  if (relPath.startsWith("extensions/ad_hoc/")) return "ad-hoc-note";
  return "other";
}

function sourceKindForOrigin(originKind: CodexOriginKind): string {
  switch (originKind) {
    case "memory-index":
      return "codex-memory-index";
    case "memory-summary":
      return "codex-memory-summary";
    case "rollout-summary":
      return "codex-rollout-summary";
    case "ad-hoc-note":
      return "codex-ad-hoc-note";
    case "raw-memory":
      return "codex-raw-memory";
    case "workspace-diff":
      return "codex-workspace-diff";
    case "other":
      return "codex-memory-document";
  }
}

function firstMetadataValue(text: string, field: string): string | null {
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function parseRolloutListMetadata(text: string): Record<string, unknown> {
  const match = text.match(/\(([^)]*thread_id=[^)]+)\)/);
  if (!match) return {};
  const body = match[1];
  const metadata: Record<string, unknown> = {};
  for (const part of body.split(/,\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "thread_id") metadata.threadId = value;
    else if (key === "updated_at") metadata.updatedAt = value;
    else if (key === "rollout_path") metadata.rolloutPath = value;
    else if (key === "cwd") metadata.cwd = value;
    else metadata[key] = value;
  }
  return metadata;
}

function metadataFor(relPath: string, text: string, originKind: CodexOriginKind): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    originKind,
    relPath,
  };
  if (originKind === "rollout-summary") {
    metadata.threadId = firstMetadataValue(text, "thread_id");
    metadata.updatedAt = firstMetadataValue(text, "updated_at");
    metadata.rolloutPath = firstMetadataValue(text, "rollout_path");
    metadata.cwd = firstMetadataValue(text, "cwd");
  }
  Object.assign(metadata, parseRolloutListMetadata(text));
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined));
}

function toDocument(memoryHome: string, absPath: string): CodexMarkdownDocument {
  const relPath = path.relative(memoryHome, absPath).split(path.sep).join("/");
  const text = fs.readFileSync(absPath, "utf8");
  const originKind = originKindForRelPath(relPath);
  return {
    relPath,
    absPath,
    text,
    originKind,
    sourceKind: sourceKindForOrigin(originKind),
    metadata: metadataFor(relPath, text, originKind),
  };
}

function loadDocuments(memoryHome: string): CodexMarkdownDocument[] {
  assertSafeMemoryHome(memoryHome);
  ensureMemoryHome(memoryHome);
  const docs: CodexMarkdownDocument[] = [];
  for (const relPath of ["MEMORY.md", "memory_summary.md", "raw_memories.md", "phase2_workspace_diff.md"]) {
    const doc = readIfExists(memoryHome, relPath);
    if (doc) docs.push(doc);
  }
  for (const abs of walkMarkdown(path.join(memoryHome, "rollout_summaries"))) docs.push(toDocument(memoryHome, abs));
  for (const abs of walkMarkdown(path.join(memoryHome, "extensions/ad_hoc"))) docs.push(toDocument(memoryHome, abs));
  return docs;
}

function documentToSource(doc: CodexMarkdownDocument): SourceEvidence {
  return {
    id: hashId("codex-source", [doc.relPath, doc.text]),
    kind: doc.sourceKind,
    path: doc.relPath,
    text: compactText(doc.text, 8000),
    refs: [{ source_path: doc.relPath, origin_kind: doc.originKind }],
    metadata: doc.metadata,
  };
}

function headingForLine(lines: string[], lineIndex: number): string | null {
  for (let i = lineIndex; i >= 0; i -= 1) {
    const match = lines[i].match(/^#{1,6}\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function inferMemoryType(originKind: CodexOriginKind, heading: string | null, body: string): string {
  const text = `${heading ?? ""} ${body}`.toLowerCase();
  if (text.includes("preference") || text.includes("when the user") || text.includes("should ")) return "operational";
  if (text.includes("failure") || text.includes("fix:") || text.includes("symptom:")) return "procedural";
  if (originKind === "ad-hoc-note") return "semantic";
  return "semantic";
}

function documentToMemories(doc: CodexMarkdownDocument): ActiveMemory[] {
  const lines = doc.text.split(/\r?\n/);
  const records: ActiveMemory[] = [];
  lines.forEach((line, index) => {
    const bullet = line.match(/^\s*-\s+(.+)$/);
    if (!bullet) return;
    const body = bullet[1].trim();
    if (!body) return;
    const heading = headingForLine(lines, index);
    records.push({
      id: hashId("codex-memory", [doc.relPath, String(index + 1), body]),
      type: inferMemoryType(doc.originKind, heading, body),
      scope: "project",
      status: "active",
      body,
      confidence: null,
      provenance: {
        originKind: doc.originKind,
        sourcePath: doc.relPath,
        heading,
        line: index + 1,
        threadId: typeof doc.metadata.threadId === "string" ? doc.metadata.threadId : null,
        updatedAt: typeof doc.metadata.updatedAt === "string" ? doc.metadata.updatedAt : null,
      },
    });
  });
  if (records.length === 0 && doc.originKind === "ad-hoc-note" && doc.text.trim()) {
    records.push({
      id: hashId("codex-memory", [doc.relPath, doc.text]),
      type: "semantic",
      scope: "project",
      status: "active",
      body: compactText(doc.text, 1600),
      confidence: null,
      provenance: {
        originKind: doc.originKind,
        sourcePath: doc.relPath,
        heading: null,
        line: 1,
      },
    });
  }
  return records;
}

function filterByQuery<T extends { body?: string; text?: string; path?: string | null }>(items: T[], query: string): T[] {
  const q = query.toLowerCase();
  return items.filter((item) =>
    [item.body, item.text, item.path].some((value) => typeof value === "string" && value.toLowerCase().includes(q))
  );
}

function limitItems<T>(items: T[], limit?: number): T[] {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items;
}

export function createCodexMemoryAdapter(options: CodexMemoryAdapterOptions = {}): MemoryStoreAdapter {
  const memoryHome = resolveCodexMemoryHome(options.memoryHome);
  assertSafeMemoryHome(memoryHome);

  const readSources = () => loadDocuments(memoryHome).map(documentToSource);
  const readMemories = () => loadDocuments(memoryHome).flatMap(documentToMemories);

  return {
    name: "codex-memory",
    async listSourceEvidence(input) {
      return limitItems(readSources(), input.limit);
    },
    async searchSourceEvidence(input) {
      return limitItems(filterByQuery(readSources(), input.query), input.limit);
    },
    async getSourceEvidence(input) {
      return readSources().find((source) => source.id === input.id) ?? null;
    },
    async listActiveMemories(input) {
      return limitItems(readMemories(), input.limit);
    },
    async searchActiveMemories(input) {
      return limitItems(filterByQuery(readMemories(), input.query), input.limit);
    },
    async getActiveMemory(input) {
      return readMemories().find((memory) => memory.id === input.id) ?? null;
    },
  };
}
