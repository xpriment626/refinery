import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const sessionIndexerSchemaVersion = "refinery.session-indexer.v1" as const;

export type SessionScanMode = "header" | "scope" | "full";

export interface SessionScopeFilter {
  kind: "exact" | "root" | "global";
  path: string | null;
}

export interface SessionResponsibilityUnit {
  id: string;
  ordinal: number;
  sessionId: string;
  startLine: number;
  endLine: number;
  startTimestamp: string | null;
  endTimestamp: string | null;
  cwdSet: string[];
  phase: string;
  boundaryReasons: string[];
  text: string;
  metadata: Record<string, unknown>;
}

export interface IndexedSessionFile {
  filePath: string;
  scanMode: SessionScanMode;
  sessionId: string;
  sessionMetaCwd: string | null;
  cwdSet: string[];
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  lineCount: number;
  mixedScope: boolean;
  parseFailures: number;
  bytesRead: number;
  scopeBytesRead: number;
  units: SessionResponsibilityUnit[];
}

interface ParsedEntry {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface UnitDraft {
  startLine: number;
  endLine: number;
  startTimestamp: string | null;
  endTimestamp: string | null;
  cwdSet: Set<string>;
  phase: string;
  boundaryReasons: Set<string>;
  userGoals: string[];
  assistantOutcomes: string[];
  toolCounts: Map<string, number>;
  failureSignals: string[];
}

const HEADER_LIMIT_BYTES = 1024 * 1024;
const USER_TEXT_LIMIT = 2_400;
const OUTCOME_TEXT_LIMIT = 2_400;

function compactText(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function stableId(prefix: string, parts: Array<string | number | null>): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(String(part ?? "")).update("\0");
  return `${prefix}:${hash.digest("hex").slice(0, 20)}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : "";
  }).filter(Boolean).join("\n");
}

function isHarnessScaffolding(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("# AGENTS.md instructions for ")
    || trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("<permissions instructions>")
    || trimmed.startsWith("<app-context>");
}

function phaseFor(text: string): string {
  const value = text.toLowerCase();
  if (/\b(debug|diagnos|root cause|why (?:is|does)|failure|error|broken|regression)\b/.test(value)) return "diagnosis";
  if (/\b(implement|build|add|create|refactor|fix|ship|wire|integrat|migrat)\b/.test(value)) return "implementation";
  if (/\b(test|verify|benchmark|measure|prove|sanity check|audit)\b/.test(value)) return "verification";
  if (/\b(research|compare|explore|investigate|understand|analyse|analyze)\b/.test(value)) return "research";
  if (/\b(decide|choose|recommend|plan|design|think through)\b/.test(value)) return "decision";
  return "continuation";
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function cwdMatchesFilter(cwd: string | null, filter: SessionScopeFilter): boolean {
  if (filter.kind === "global") return true;
  if (!cwd || !filter.path) return false;
  return filter.kind === "root" ? within(cwd, filter.path) : path.resolve(cwd) === path.resolve(filter.path);
}

export function cwdSetMatchesFilter(cwds: string[], filter: SessionScopeFilter): boolean {
  return filter.kind === "global" || (cwds.length > 0 && cwds.every((cwd) => cwdMatchesFilter(cwd, filter)));
}

function parseLine(line: string): ParsedEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ParsedEntry : null;
  } catch {
    return null;
  }
}

export async function readSessionHeader(filePath: string): Promise<{
  sessionId: string;
  cwd: string | null;
  timestamp: string | null;
  bytesRead: number;
}> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    let bytesReadTotal = 0;
    let pending = Buffer.alloc(0);
    while (bytesReadTotal < HEADER_LIMIT_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, HEADER_LIMIT_BYTES - bytesReadTotal));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytesReadTotal);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      const newline = pending.indexOf(0x0a);
      if (newline < 0) continue;
      const entry = parseLine(pending.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
      if (entry?.type !== "session_meta" || !entry.payload) {
        throw new Error("Codex session does not start with session_meta");
      }
      const payload = entry.payload;
      return {
        sessionId: typeof payload.id === "string"
          ? payload.id
          : typeof payload.session_id === "string"
            ? payload.session_id
            : path.basename(filePath, ".jsonl"),
        cwd: typeof payload.cwd === "string" ? payload.cwd : null,
        timestamp: typeof payload.timestamp === "string"
          ? payload.timestamp
          : typeof entry.timestamp === "string" ? entry.timestamp : null,
        bytesRead: newline + 1,
      };
    }
    throw new Error(`Codex session header exceeds ${HEADER_LIMIT_BYTES} bytes or is incomplete`);
  } finally {
    await handle.close();
  }
}

function timestampFromPrefix(line: string): string | null {
  const match = line.slice(0, 2_048).match(/"timestamp"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

export async function scanSessionScope(
  filePath: string,
  header?: Awaited<ReturnType<typeof readSessionHeader>>,
): Promise<IndexedSessionFile> {
  const knownHeader = header ?? await readSessionHeader(filePath);
  const stream = fs.createReadStream(filePath);
  const allCwds = new Set<string>(knownHeader.cwd ? [path.resolve(knownHeader.cwd)] : []);
  let firstTimestamp = knownHeader.timestamp;
  let lastTimestamp = knownHeader.timestamp;
  let bytesRead = 0;
  let lineCount = 0;
  let parseFailures = 0;
  let pending = "";
  let discarding = false;

  const inspect = (line: string): void => {
    if (!line.trim()) return;
    lineCount += 1;
    const timestamp = timestampFromPrefix(line);
    firstTimestamp ??= timestamp;
    lastTimestamp = timestamp ?? lastTimestamp;
    const prefix = line.slice(0, 4_096);
    if (!prefix.includes('"type":"turn_context"') && !prefix.includes('"type": "turn_context"')) return;
    const entry = parseLine(line);
    if (!entry?.payload) {
      parseFailures += 1;
      return;
    }
    if (typeof entry.payload.cwd === "string") allCwds.add(path.resolve(entry.payload.cwd));
  };

  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    bytesRead += buffer.length;
    const text = buffer.toString("utf8");
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      const segment = text.slice(offset, end);
      if (!discarding) pending += segment;
      if (!discarding && pending.length > 64 * 1024) {
        // turn_context records are small and identify their type near the start.
        // Discard giant content/compaction records without retaining the line.
        const timestamp = timestampFromPrefix(pending);
        firstTimestamp ??= timestamp;
        lastTimestamp = timestamp ?? lastTimestamp;
        lineCount += 1;
        pending = "";
        discarding = true;
      }
      if (newline >= 0) {
        if (!discarding) inspect(pending.replace(/\r$/, ""));
        pending = "";
        discarding = false;
        offset = newline + 1;
      } else {
        offset = text.length;
      }
    }
  }
  if (discarding) {
    // The oversized final line was already counted when discard mode began.
  } else if (pending) {
    inspect(pending.replace(/\r$/, ""));
  }
  return {
    filePath,
    scanMode: "scope",
    sessionId: knownHeader.sessionId,
    sessionMetaCwd: knownHeader.cwd,
    cwdSet: [...allCwds].sort(),
    firstTimestamp,
    lastTimestamp,
    lineCount,
    mixedScope: false,
    parseFailures,
    bytesRead: 0,
    scopeBytesRead: bytesRead,
    units: [],
  };
}

function newDraft(args: {
  line: number;
  timestamp: string | null;
  cwd: string | null;
  phase?: string;
  reasons?: string[];
}): UnitDraft {
  return {
    startLine: args.line,
    endLine: args.line,
    startTimestamp: args.timestamp,
    endTimestamp: args.timestamp,
    cwdSet: new Set(args.cwd ? [path.resolve(args.cwd)] : []),
    phase: args.phase ?? "continuation",
    boundaryReasons: new Set(args.reasons ?? []),
    userGoals: [],
    assistantOutcomes: [],
    toolCounts: new Map(),
    failureSignals: [],
  };
}

function hasMeaningfulContent(draft: UnitDraft | null): draft is UnitDraft {
  return Boolean(draft && (draft.userGoals.length > 0 || draft.assistantOutcomes.length > 0
    || draft.toolCounts.size > 0 || draft.failureSignals.length > 0));
}

function finalizeDraft(draft: UnitDraft, sessionId: string, ordinal: number): SessionResponsibilityUnit {
  const firstGoal = draft.userGoals[0] ?? "continuation without a retained user goal";
  const id = stableId("session-unit", [sessionId, draft.startTimestamp, draft.startLine, firstGoal]);
  const cwdSet = [...draft.cwdSet].sort();
  const text = [
    `Responsibility unit: ${id}`,
    `session_id: ${sessionId}`,
    `phase: ${draft.phase}`,
    draft.startTimestamp ? `started_at: ${draft.startTimestamp}` : null,
    draft.endTimestamp ? `ended_at: ${draft.endTimestamp}` : null,
    cwdSet.length > 0 ? `cwd_set: ${cwdSet.join(", ")}` : null,
    `boundary_reasons: ${[...draft.boundaryReasons].sort().join(", ") || "continuation"}`,
    "",
    "Goals and decisions:",
    ...draft.userGoals.map((goal) => `- ${goal}`),
    "",
    "Outcomes:",
    ...draft.assistantOutcomes.map((outcome) => `- ${outcome}`),
    "",
    "Actions and consequential signals:",
    ...[...draft.toolCounts].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => `- ${name}: ${count}`),
    ...draft.failureSignals.map((signal) => `- ${signal}`),
  ].filter((value): value is string => value !== null).join("\n");
  return {
    id,
    ordinal,
    sessionId,
    startLine: draft.startLine,
    endLine: draft.endLine,
    startTimestamp: draft.startTimestamp,
    endTimestamp: draft.endTimestamp,
    cwdSet,
    phase: draft.phase,
    boundaryReasons: [...draft.boundaryReasons].sort(),
    text,
    metadata: {
      sessionId,
      threadId: sessionId,
      unitId: id,
      unitOrdinal: ordinal,
      startLine: draft.startLine,
      endLine: draft.endLine,
      startTimestamp: draft.startTimestamp,
      endTimestamp: draft.endTimestamp,
      cwdSet,
      phase: draft.phase,
      boundaryReasons: [...draft.boundaryReasons].sort(),
      userGoalCount: draft.userGoals.length,
      assistantOutcomeCount: draft.assistantOutcomes.length,
      toolCounts: Object.fromEntries(draft.toolCounts),
      failureSignalCount: draft.failureSignals.length,
    },
  };
}

function resultFailureSignal(payload: Record<string, unknown>): string | null {
  const output = typeof payload.output === "string" ? payload.output : "";
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const exitCode = typeof parsed.exit_code === "number" ? parsed.exit_code : null;
    if (exitCode !== null && exitCode !== 0) return `tool result failed with exit code ${exitCode}`;
  } catch {
    // Some harnesses store plain-text tool results. Only retain the failure class, never raw output.
  }
  return /\b(error|failed|failure|exception|timed out|nonzero)\b/i.test(output)
    ? "tool result reported a failure"
    : null;
}

export async function parseSessionStream(filePath: string, header?: Awaited<ReturnType<typeof readSessionHeader>>): Promise<IndexedSessionFile> {
  const knownHeader = header ?? await readSessionHeader(filePath);
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let bytesRead = 0;
  stream.on("data", (chunk: string | Buffer) => { bytesRead += Buffer.byteLength(chunk); });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const units: SessionResponsibilityUnit[] = [];
  const allCwds = new Set<string>(knownHeader.cwd ? [path.resolve(knownHeader.cwd)] : []);
  let currentCwd = knownHeader.cwd;
  let current: UnitDraft | null = null;
  let pendingReasons: string[] = [];
  let previousPhase: string | null = null;
  let firstTimestamp = knownHeader.timestamp;
  let lastTimestamp = knownHeader.timestamp;
  let lineNumber = 0;
  let parseFailures = 0;

  const finalize = (): void => {
    if (hasMeaningfulContent(current)) units.push(finalizeDraft(current, knownHeader.sessionId, units.length));
    current = null;
  };

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    // Compaction payloads can contain an entire replacement history on one enormous line.
    // The boundary is useful; copying or parsing that history is neither safe nor necessary.
    if (/^\s*\{.*"type"\s*:\s*"compacted"/.test(line.slice(0, 512))) {
      finalize();
      pendingReasons = ["compaction"];
      continue;
    }
    if (line.includes('"role":"developer"') || line.includes('"role": "developer"')) continue;
    const entry = parseLine(line);
    if (!entry) {
      parseFailures += 1;
      continue;
    }
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
    firstTimestamp ??= timestamp;
    lastTimestamp = timestamp ?? lastTimestamp;
    const payload = entry.payload;
    if (!payload) continue;
    if (entry.type === "turn_context") {
      if (typeof payload.cwd === "string") {
        currentCwd = payload.cwd;
        allCwds.add(path.resolve(payload.cwd));
        current?.cwdSet.add(path.resolve(payload.cwd));
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") {
      const goal = compactText(textFromContent(payload.content), USER_TEXT_LIMIT);
      if (!goal || isHarnessScaffolding(goal)) continue;
      finalize();
      const phase = phaseFor(goal);
      const reasons = [...pendingReasons, "goal-change"];
      if (previousPhase && previousPhase !== phase) reasons.push(`${previousPhase}-to-${phase}`);
      current = newDraft({ line: lineNumber, timestamp, cwd: currentCwd, phase, reasons });
      current.userGoals.push(goal);
      previousPhase = phase;
      pendingReasons = [];
      continue;
    }
    if (!current) current = newDraft({ line: lineNumber, timestamp, cwd: currentCwd, reasons: pendingReasons });
    current.endLine = lineNumber;
    current.endTimestamp = timestamp ?? current.endTimestamp;
    if (currentCwd) current.cwdSet.add(path.resolve(currentCwd));
    if (payload.type === "message" && payload.role === "assistant" && payload.phase !== "commentary") {
      const outcome = compactText(textFromContent(payload.content), OUTCOME_TEXT_LIMIT);
      if (outcome && current.assistantOutcomes.length < 6) current.assistantOutcomes.push(outcome);
      continue;
    }
    if (payload.type === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      current.toolCounts.set(name, (current.toolCounts.get(name) ?? 0) + 1);
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const signal = resultFailureSignal(payload);
      if (signal && current.failureSignals.length < 4) current.failureSignals.push(signal);
    }
  }
  finalize();
  const cwdSet = [...allCwds].sort();
  return {
    filePath,
    scanMode: "full",
    sessionId: knownHeader.sessionId,
    sessionMetaCwd: knownHeader.cwd,
    cwdSet,
    firstTimestamp,
    lastTimestamp,
    lineCount: lineNumber,
    mixedScope: false,
    parseFailures,
    bytesRead,
    scopeBytesRead: 0,
    units,
  };
}
