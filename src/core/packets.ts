import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  listCodexActiveMemories,
  listCodexMemorySourceDocuments,
  resolveCodexMemoryHome,
} from "../sources/codex-memories.ts";
import { RefineryError } from "./errors.ts";
import {
  reviewPacketSchemaVersion,
  sourceSpecKinds,
  targetSurfaces,
  type ActiveMemory,
  type ReviewPacket,
  type ReviewPacketLimits,
  type SourceDocument,
  type SourceSet,
  type SourceSpec,
  type SourceSpecKind,
  type TargetSurface,
} from "./types.ts";

const DEFAULT_SOURCE_LIMIT = 3;
const DEFAULT_SOURCE_CHAR_LIMIT = 6000;
const DEFAULT_DOCUMENT_CHAR_LIMIT = 8000;
const DEFAULT_ACTIVE_MEMORY_LIMIT = 50;
const LOADABLE_FILE_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);

export interface BuildReviewPacketOptions {
  sourceSpecs: SourceSpec[];
  targets: TargetSurface[];
  project: string;
  scope: string;
  intent: string;
  request: string | null;
  memoryHome?: string;
  sourceLimit?: number;
  sourceCharLimit?: number;
  documentCharLimit?: number;
  activeMemoryLimit?: number;
  now?: Date;
}

export interface SourceInspectResult {
  ok: true;
  command: "sources inspect";
  sources: Array<{
    id: string;
    spec: SourceSpec;
    label: string;
    role: string;
    counts: {
      documents: number;
      activeMemories: number;
    };
    sampleDocuments: Array<{
      id: string;
      role: string;
      uri: string;
      textChars: number;
      metadata: Record<string, unknown>;
    }>;
    metadata: Record<string, unknown>;
  }>;
  counts: {
    sourceSets: number;
    documents: number;
    activeMemories: number;
  };
  warnings: string[];
}

interface LoadedSourceSet {
  sourceSet: SourceSet;
  documents: SourceDocument[];
  activeMemories: ActiveMemory[];
  warnings: string[];
}

interface SourceLoadContext {
  project: string;
  scope: string;
  memoryHome?: string;
  limits: ReviewPacketLimits;
  now: Date;
}

function hashId(prefix: string, parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return `${prefix}:${hash.digest("hex").slice(0, 16)}`;
}

function compactText(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function parseParams(rawParams: string | undefined): Record<string, string> {
  if (!rawParams) return {};
  const params = new URLSearchParams(rawParams);
  return Object.fromEntries(Array.from(params.entries()).filter(([key]) => key.trim()));
}

export function parseSourceSpec(raw: string): SourceSpec {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new RefineryError("INVALID_SOURCE_SPEC", "--source must not be empty.", { phase: "args" });
  }
  const queryIndex = trimmed.indexOf("?");
  const head = queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed;
  const params = parseParams(queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : undefined);
  if (head === "codex:memories" || head === "codex:sessions" || head === "codex:skills") {
    return { raw: trimmed, kind: head, value: null, params };
  }
  if (head.startsWith("file:")) {
    return { raw: trimmed, kind: "file", value: head.slice("file:".length), params };
  }
  if (head.startsWith("glob:")) {
    return { raw: trimmed, kind: "glob", value: head.slice("glob:".length), params };
  }
  throw new RefineryError(
    "INVALID_SOURCE_SPEC",
    `Unsupported source spec: ${raw}. Use one of ${sourceSpecKinds.join(", ")}.`,
    { phase: "args", details: { source: raw } },
  );
}

export function parseSourceSpecs(values: unknown, fallback: string[] = ["codex:memories"]): SourceSpec[] {
  const rawValues = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : typeof values === "string"
      ? [values]
      : fallback;
  return rawValues.map(parseSourceSpec);
}

export function parseTargetSurface(raw: string): TargetSurface {
  const trimmed = raw.trim();
  if (targetSurfaces.includes(trimmed as TargetSurface)) return trimmed as TargetSurface;
  throw new RefineryError(
    "INVALID_TARGET",
    `Unsupported target surface: ${raw}. Use one of ${targetSurfaces.join(", ")}.`,
    { phase: "args", details: { target: raw } },
  );
}

export function parseTargetSurfaces(values: unknown, fallback: string[] = ["codex:memories"]): TargetSurface[] {
  const rawValues = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : typeof values === "string"
      ? [values]
      : fallback;
  const parsed = rawValues.map(parseTargetSurface);
  return Array.from(new Set(parsed));
}

function sourceSetFor(spec: SourceSpec, index: number, role: string, metadata: Record<string, unknown> = {}): SourceSet {
  return {
    id: hashId("source-set", [String(index), spec.raw]),
    spec,
    label: spec.raw,
    role,
    metadata,
  };
}

function sourceDocument(args: {
  sourceSet: string;
  role: string;
  uri: string;
  text: string;
  metadata?: Record<string, unknown>;
  maxChars: number;
}): SourceDocument {
  return {
    id: hashId("source-doc", [args.sourceSet, args.uri, args.text]),
    sourceSet: args.sourceSet,
    role: args.role,
    uri: args.uri,
    text: compactText(args.text, args.maxChars),
    metadata: args.metadata ?? {},
  };
}

function sourceRefs(doc: SourceDocument): unknown[] {
  return [{
    source_id: doc.id,
    source_set: doc.sourceSet,
    source_uri: doc.uri,
    role: doc.role,
  }];
}

export function toSourceChunks(documents: SourceDocument[], charLimit: number): unknown[] {
  let remaining = charLimit;
  return documents
    .map((doc) => {
      const text = compactText(doc.text, Math.max(0, remaining));
      remaining -= text.length;
      return {
        id: doc.id,
        sourceSet: doc.sourceSet,
        role: doc.role,
        uri: doc.uri,
        text,
        refs: sourceRefs(doc),
        metadata: doc.metadata,
      };
    })
    .filter((chunk) => chunk.text.length > 0);
}

export function activeMemoryHints(memories: ActiveMemory[], limit: number): unknown[] {
  return memories.slice(0, limit).map((memory) => ({
    id: memory.id,
    type: memory.type,
    scope: memory.scope,
    body: compactText(memory.body, 360),
    provenance: memory.provenance ?? null,
  }));
}

function limitItems<T>(items: T[], limit: number): T[] {
  return items.slice(0, Math.max(1, limit));
}

async function loadCodexMemories(spec: SourceSpec, index: number, context: SourceLoadContext): Promise<LoadedSourceSet> {
  const memoryHome = resolveCodexMemoryHome(spec.params.home ?? context.memoryHome);
  const sourceSet = sourceSetFor(spec, index, "codex-memories", { memoryHome });
  const sources = listCodexMemorySourceDocuments({ memoryHome, limit: context.limits.sourceLimit });
  const activeMemories = listCodexActiveMemories({ memoryHome, limit: context.limits.activeMemoryLimit });
  return {
    sourceSet,
    activeMemories,
    warnings: [],
    documents: sources.map((source) => sourceDocument({
      sourceSet: sourceSet.id,
      role: source.role,
      uri: pathToFileURL(source.absPath).href,
      text: source.text,
      metadata: {
        ...(source.metadata ?? {}),
        refs: source.refs ?? [],
      },
      maxChars: context.limits.documentCharLimit,
    })),
  };
}

function codexHome(): string {
  return path.join(os.homedir(), ".codex");
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out.sort();
}

function findSessionFiles(sessionsDir = path.join(codexHome(), "sessions")): string[] {
  return walkFiles(sessionsDir).filter((file) => path.basename(file).startsWith("rollout-") && file.endsWith(".jsonl"));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseSessionFile(filePath: string): {
  sessionId: string;
  cwd: string | null;
  timestamp: string | null;
  text: string;
  metadata: Record<string, unknown>;
} | null {
  const userPrompts: string[] = [];
  const assistantFinals: string[] = [];
  const assistantSummaries: string[] = [];
  const toolCalls: string[] = [];
  const eventSummaries: string[] = [];
  const toolCounts: Record<string, number> = {};
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd: string | null = null;
  let timestamp: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string") {
      firstTimestamp ??= entry.timestamp;
      lastTimestamp = entry.timestamp;
    }
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") continue;
    if (entry.type === "session_meta") {
      if (typeof payload.id === "string") sessionId = payload.id;
      else if (typeof payload.session_id === "string") sessionId = payload.session_id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.timestamp === "string") timestamp = payload.timestamp;
      continue;
    }
    if (entry.type === "turn_context") {
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      continue;
    }
    if (entry.type === "event_msg") {
      if (payload.type === "user_message" && typeof payload.message === "string") {
        userPrompts.push(compactText(payload.message, 1200));
      } else if (payload.type === "agent_message" && typeof payload.message === "string") {
        eventSummaries.push(compactText(payload.message, 300));
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    if (payload.type === "message") {
      const text = compactText(textFromContent(payload.content), 1400);
      if (!text) continue;
      if (payload.role === "user") userPrompts.push(text);
      if (payload.role === "assistant" && payload.phase !== "commentary") assistantFinals.push(text);
      continue;
    }
    if (payload.type === "reasoning" && Array.isArray(payload.summary)) {
      const summary = payload.summary.map((item) => typeof item === "string" ? item : "").filter(Boolean).join(" ");
      if (summary) assistantSummaries.push(compactText(summary, 500));
      continue;
    }
    if (payload.type === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      let detail = "";
      if (typeof payload.arguments === "string" && payload.arguments.trim()) {
        try {
          const parsed = JSON.parse(payload.arguments) as Record<string, unknown>;
          if (typeof parsed.cmd === "string") detail = ` cmd=${compactText(parsed.cmd, 180)}`;
          else if (typeof parsed.query === "string") detail = ` query=${compactText(parsed.query, 120)}`;
        } catch {
          detail = ` args=${compactText(payload.arguments, 120)}`;
        }
      }
      toolCalls.push(`${name}${detail}`);
    }
  }

  const text = [
    `Codex session: ${sessionId}`,
    cwd ? `cwd: ${cwd}` : null,
    `session_file: ${filePath}`,
    timestamp || firstTimestamp ? `started_at: ${timestamp ?? firstTimestamp}` : null,
    lastTimestamp ? `last_event_at: ${lastTimestamp}` : null,
    "",
    "User prompts:",
    ...limitItems(userPrompts, 8).map((item) => `- ${item}`),
    "",
    "Assistant finals/summaries:",
    ...limitItems([...assistantFinals, ...assistantSummaries], 8).map((item) => `- ${item}`),
    "",
    "Compact tool/action summary:",
    ...Object.entries(toolCounts).map(([name, count]) => `- ${name}: ${count}`),
    ...limitItems(toolCalls, 12).map((item) => `- ${item}`),
    ...limitItems(eventSummaries, 4).map((item) => `- event: ${item}`),
  ].filter((item): item is string => item !== null).join("\n");

  if (!text.trim()) return null;
  return {
    sessionId,
    cwd,
    timestamp: timestamp ?? firstTimestamp,
    text,
    metadata: {
      sessionId,
      cwd,
      timestamp: timestamp ?? firstTimestamp,
      firstTimestamp,
      lastTimestamp,
      filePath,
      userPromptCount: userPrompts.length,
      assistantFinalCount: assistantFinals.length,
      toolCounts,
    },
  };
}

function withinDays(timestamp: string | null, days: number, now: Date): boolean {
  if (!timestamp) return true;
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return true;
  return then.getTime() >= now.getTime() - days * 24 * 60 * 60 * 1000;
}

async function loadCodexSessions(spec: SourceSpec, index: number, context: SourceLoadContext): Promise<LoadedSourceSet> {
  const sessionsDir = spec.params.home ?? path.join(codexHome(), "sessions");
  const projectFilter = spec.params.scope === "global" ? null : path.resolve(spec.params.project ?? context.project);
  const days = spec.params.days ? Number.parseInt(spec.params.days, 10) : null;
  const sourceSet = sourceSetFor(spec, index, "codex-sessions", { sessionsDir, project: projectFilter, days });
  const warnings: string[] = [];
  if (!fs.existsSync(sessionsDir)) {
    return { sourceSet, documents: [], activeMemories: [], warnings: [`Codex sessions directory not found: ${sessionsDir}`] };
  }
  const parsed = findSessionFiles(sessionsDir)
    .map(parseSessionFile)
    .filter((session): session is NonNullable<typeof session> => Boolean(session))
    .filter((session) => !projectFilter || (session.cwd ? path.resolve(session.cwd) === projectFilter : false))
    .filter((session) => !days || withinDays(session.timestamp, days, context.now))
    .sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")));
  const selected = limitItems(parsed, context.limits.sourceLimit);
  return {
    sourceSet,
    activeMemories: [],
    warnings,
    documents: selected.map((session) => sourceDocument({
      sourceSet: sourceSet.id,
      role: "codex-session-summary",
      uri: `${pathToFileURL(String(session.metadata.filePath)).href}#session=${encodeURIComponent(session.sessionId)}`,
      text: session.text,
      metadata: session.metadata,
      maxChars: context.limits.documentCharLimit,
    })),
  };
}

function findSkillFiles(roots: string[]): string[] {
  const files = roots.flatMap((root) => walkFiles(root).filter((file) => path.basename(file) === "SKILL.md"));
  return files
    .filter((file) => !file.includes(`${path.sep}plugins${path.sep}cache${path.sep}`))
    .sort((left, right) => {
      const leftDot = left.split(path.sep).some((part) => part.startsWith("."));
      const rightDot = right.split(path.sep).some((part) => part.startsWith("."));
      if (leftDot !== rightDot) return leftDot ? 1 : -1;
      return left.localeCompare(right);
    });
}

function defaultSkillRoots(): string[] {
  return [
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
}

async function loadCodexSkills(spec: SourceSpec, index: number, context: SourceLoadContext): Promise<LoadedSourceSet> {
  const roots = spec.params.home ? spec.params.home.split(",").map((root) => path.resolve(root)) : defaultSkillRoots();
  const sourceSet = sourceSetFor(spec, index, "codex-skills", {
    roots,
    pluginCacheIncluded: false,
  });
  const files = limitItems(findSkillFiles(roots), context.limits.sourceLimit);
  return {
    sourceSet,
    activeMemories: [],
    warnings: [],
    documents: files.map((file) => sourceDocument({
      sourceSet: sourceSet.id,
      role: "codex-skill",
      uri: pathToFileURL(file).href,
      text: fs.readFileSync(file, "utf8"),
      metadata: {
        path: file,
        skillName: path.basename(path.dirname(file)),
      },
      maxChars: context.limits.documentCharLimit,
    })),
  };
}

function resolveFileSpecPath(spec: SourceSpec): string {
  if (!spec.value) {
    throw new RefineryError("INVALID_SOURCE_SPEC", "file/glob source specs require a path.", { phase: "args" });
  }
  return path.resolve(spec.value);
}

function loadTextFile(filePath: string): string {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new RefineryError("SOURCE_NOT_FOUND", `Source file not found: ${filePath}`, {
      phase: "source",
      details: { filePath },
    });
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!LOADABLE_FILE_EXTENSIONS.has(ext)) {
    throw new RefineryError("SOURCE_UNSUPPORTED_FILE", `Source file extension is not supported: ${filePath}`, {
      phase: "source",
      details: { filePath, supported: Array.from(LOADABLE_FILE_EXTENSIONS) },
    });
  }
  return fs.readFileSync(filePath, "utf8");
}

async function loadFileSource(spec: SourceSpec, index: number, context: SourceLoadContext): Promise<LoadedSourceSet> {
  const filePath = resolveFileSpecPath(spec);
  const sourceSet = sourceSetFor(spec, index, "file", { path: filePath });
  return {
    sourceSet,
    activeMemories: [],
    warnings: [],
    documents: [sourceDocument({
      sourceSet: sourceSet.id,
      role: `file-${path.extname(filePath).replace(".", "") || "text"}`,
      uri: pathToFileURL(filePath).href,
      text: loadTextFile(filePath),
      metadata: {
        path: filePath,
        size: fs.statSync(filePath).size,
      },
      maxChars: context.limits.documentCharLimit,
    })],
  };
}

function globRoot(pattern: string): string {
  const wildcard = pattern.search(/[*?[\]]/);
  if (wildcard < 0) return path.dirname(pattern);
  const prefix = pattern.slice(0, wildcard);
  const slash = prefix.lastIndexOf(path.sep);
  return slash > 0 ? prefix.slice(0, slash) : path.parse(pattern).root;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.split(path.sep).join("/");
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }
  out += "$";
  return new RegExp(out);
}

async function loadGlobSource(spec: SourceSpec, index: number, context: SourceLoadContext): Promise<LoadedSourceSet> {
  const pattern = resolveFileSpecPath(spec);
  const root = globRoot(pattern);
  const sourceSet = sourceSetFor(spec, index, "glob", { pattern, root });
  if (!fs.existsSync(root)) {
    return { sourceSet, documents: [], activeMemories: [], warnings: [`Glob root not found: ${root}`] };
  }
  const matcher = globToRegex(pattern);
  const files = walkFiles(root)
    .filter((file) => LOADABLE_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .filter((file) => matcher.test(file.split(path.sep).join("/")));
  return {
    sourceSet,
    activeMemories: [],
    warnings: [],
    documents: limitItems(files, context.limits.sourceLimit).map((file) => sourceDocument({
      sourceSet: sourceSet.id,
      role: `file-${path.extname(file).replace(".", "") || "text"}`,
      uri: pathToFileURL(file).href,
      text: loadTextFile(file),
      metadata: {
        path: file,
        size: fs.statSync(file).size,
      },
      maxChars: context.limits.documentCharLimit,
    })),
  };
}

async function loadSourceSet(spec: SourceSpec, index: number, context: SourceLoadContext): Promise<LoadedSourceSet> {
  switch (spec.kind) {
    case "codex:memories":
      return loadCodexMemories(spec, index, context);
    case "codex:sessions":
      return loadCodexSessions(spec, index, context);
    case "codex:skills":
      return loadCodexSkills(spec, index, context);
    case "file":
      return loadFileSource(spec, index, context);
    case "glob":
      return loadGlobSource(spec, index, context);
  }
}

function uniqueActiveMemories(memories: ActiveMemory[]): ActiveMemory[] {
  const byId = new Map<string, ActiveMemory>();
  for (const memory of memories) if (!byId.has(memory.id)) byId.set(memory.id, memory);
  return Array.from(byId.values());
}

export async function buildReviewPacket(options: BuildReviewPacketOptions): Promise<ReviewPacket> {
  const limits: ReviewPacketLimits = {
    sourceLimit: Math.max(1, Math.min(options.sourceLimit ?? DEFAULT_SOURCE_LIMIT, 50)),
    sourceCharLimit: Math.max(500, Math.min(options.sourceCharLimit ?? DEFAULT_SOURCE_CHAR_LIMIT, 60_000)),
    documentCharLimit: Math.max(500, Math.min(options.documentCharLimit ?? DEFAULT_DOCUMENT_CHAR_LIMIT, 24_000)),
    activeMemoryLimit: Math.max(1, Math.min(options.activeMemoryLimit ?? DEFAULT_ACTIVE_MEMORY_LIMIT, 200)),
  };
  const context: SourceLoadContext = {
    project: options.project,
    scope: options.scope,
    memoryHome: options.memoryHome,
    limits,
    now: options.now ?? new Date(),
  };
  const loaded = await Promise.all(options.sourceSpecs.map((spec, index) => loadSourceSet(spec, index, context)));
  const sourceSets = loaded.map((set) => set.sourceSet);
  const documents = loaded.flatMap((set) => set.documents);
  const activeMemories = uniqueActiveMemories(loaded.flatMap((set) => set.activeMemories));
  const derivedViews = {
    source_chunks: toSourceChunks(documents, limits.sourceCharLimit),
    active_memory_hints: activeMemoryHints(activeMemories, limits.activeMemoryLimit),
  };
  return {
    schemaVersion: reviewPacketSchemaVersion,
    type: "refinery-review-packet",
    sourceSets,
    documents,
    targets: options.targets,
    objective: {
      intent: options.intent,
      request: options.request,
      project: options.project,
      scope: options.scope,
    },
    limits,
    derivedViews,
    counts: {
      sourceSets: sourceSets.length,
      documents: documents.length,
      activeMemoryHints: derivedViews.active_memory_hints.length,
      sourceChunks: derivedViews.source_chunks.length,
    },
    warnings: loaded.flatMap((set) => set.warnings),
  };
}

export async function inspectSources(options: Omit<BuildReviewPacketOptions, "targets" | "intent" | "request">): Promise<SourceInspectResult> {
  const packet = await buildReviewPacket({
    ...options,
    targets: ["codex:memories"],
    intent: "source-inspect",
    request: null,
  });
  return {
    ok: true,
    command: "sources inspect",
    sources: packet.sourceSets.map((sourceSet) => {
      const documents = packet.documents.filter((doc) => doc.sourceSet === sourceSet.id);
      return {
        id: sourceSet.id,
        spec: sourceSet.spec,
        label: sourceSet.label,
        role: sourceSet.role,
        counts: {
          documents: documents.length,
          activeMemories: sourceSet.spec.kind === "codex:memories" ? packet.counts.activeMemoryHints : 0,
        },
        sampleDocuments: documents.slice(0, 5).map((doc) => ({
          id: doc.id,
          role: doc.role,
          uri: doc.uri,
          textChars: doc.text.length,
          metadata: doc.metadata,
        })),
        metadata: sourceSet.metadata,
      };
    }),
    counts: {
      sourceSets: packet.counts.sourceSets,
      documents: packet.counts.documents,
      activeMemories: packet.counts.activeMemoryHints,
    },
    warnings: packet.warnings,
  };
}
