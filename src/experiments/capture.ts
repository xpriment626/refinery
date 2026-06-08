import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RefineryPaths } from "../config.ts";
import { resolvePaths } from "../config.ts";
import { openDb } from "../db.ts";
import { loadModelConfig, type ModelConfig } from "../env.ts";
import { createMastraModelCaller, mastraRuntimeMetadata } from "../mastra/runtime.ts";
import { captureSpecialist } from "../specialists/capture.ts";

export type ExperimentPaths = RefineryPaths;

export interface SourceChunk {
  index: number;
  role: "user" | "assistant";
  timestamp: string | null;
  text: string;
}

export interface SessionSlice {
  source: {
    id: number;
    session_id: string | null;
    source_path: string;
    raw_blob: string;
  };
  chunks: SourceChunk[];
}

export interface CaptureCandidate {
  claim: string;
  source_refs: unknown[];
  why_future_useful: string;
}

export interface CaptureOutput {
  candidates: CaptureCandidate[];
}

export interface CaptureExperimentResult {
  runId: string;
  runDir: string;
  parsed: CaptureOutput;
}

export type ModelCaller = (request: {
  model: ModelConfig;
  system: string;
  user: string;
}) => Promise<string>;

interface SourceRow {
  id: number;
  session_id: string | null;
  source_path: string;
  raw_blob: string;
}

export interface SliceOptions {
  sourceId?: number;
  maxTurns?: number;
  maxChars?: number;
}

export interface RunCaptureExperimentOptions extends SliceOptions {
  runId?: string;
  model?: ModelConfig;
  callModel?: ModelCaller;
}

function withDb<T>(paths: ExperimentPaths, fn: (db: DatabaseSync) => T): T {
  const db = openDb(paths);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const typed = part as { type?: unknown; text?: unknown };
        if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function clampText(text: string, remaining: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= remaining) return clean;
  return clean.slice(0, Math.max(0, remaining - 3)) + "...";
}

function readChunks(rawBlob: string, maxTurns: number, maxChars: number): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let usedChars = 0;
  let index = 0;

  for (const line of fs.readFileSync(rawBlob, "utf8").split("\n")) {
    if (chunks.length >= maxTurns || usedChars >= maxChars) break;
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as {
      type?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = clampText(textFromContent(entry.message?.content), maxChars - usedChars);
    if (!text) continue;
    chunks.push({
      index,
      role,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
      text,
    });
    usedChars += text.length;
    index++;
  }

  return chunks;
}

export function selectDeterministicSessionSlice(
  paths: ExperimentPaths,
  options: SliceOptions = {},
): SessionSlice {
  const maxTurns = options.maxTurns ?? 8;
  const maxChars = options.maxChars ?? 6000;
  const source = withDb(paths, (db) => {
    if (options.sourceId !== undefined) {
      return db
        .prepare(
          `SELECT id, session_id, source_path, raw_blob
           FROM source
           WHERE id = ? AND kind = 'claude-code-session'`,
        )
        .get(options.sourceId) as SourceRow | undefined;
    }
    return db
      .prepare(
        `SELECT id, session_id, source_path, raw_blob
         FROM source
         WHERE kind = 'claude-code-session'
         ORDER BY source_path
         LIMIT 1`,
      )
      .get() as SourceRow | undefined;
  });

  if (!source) throw new Error("No imported Claude Code session source found.");
  const chunks = readChunks(source.raw_blob, maxTurns, maxChars);
  if (chunks.length === 0) throw new Error(`No readable message chunks found in source#${source.id}.`);
  return { source, chunks };
}

export function buildCapturePrompt(slice: SessionSlice): { system: string; user: string } {
  const sourceChunks = slice.chunks
    .map(
      (chunk) =>
        `<chunk index="${chunk.index}" role="${chunk.role}" timestamp="${chunk.timestamp ?? ""}">\n${chunk.text}\n</chunk>`,
    )
    .join("\n\n");
  return {
    system: [
      captureSpecialist.prompt,
      "",
      "Return only JSON matching this shape:",
      `{"candidates":[{"claim":"...","source_refs":[{"source_id":${slice.source.id},"session_id":"${slice.source.session_id ?? ""}","chunk_index":0}],"why_future_useful":"..."}]}`,
      "For this smoke test, return exactly one concise candidate. Keep each string under 220 characters.",
      "Do not wrap the answer in prose. Do not invent evidence outside the provided chunks.",
    ].join("\n"),
    user: [
      "Capture candidate durable memories from this deterministic session slice.",
      "",
      `Source: source#${slice.source.id} session=${slice.source.session_id ?? ""}`,
      sourceChunks,
    ].join("\n"),
  };
}

function redactModel(config: ModelConfig): Omit<ModelConfig, "apiKey"> & { apiKeyPresent: boolean } {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKeyPresent: Boolean(config.apiKey),
  };
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("Model response did not contain a JSON object.");
  return JSON.parse(candidate.slice(first, last + 1)) as unknown;
}

export function parseCaptureOutput(raw: string): CaptureOutput {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { candidates?: unknown }).candidates)) {
    throw new Error("Capture output must contain candidates array.");
  }
  const candidates = (parsed as { candidates: unknown[] }).candidates.map((candidate, i) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Candidate ${i} must be an object.`);
    }
    const c = candidate as Partial<CaptureCandidate>;
    if (typeof c.claim !== "string" || !c.claim.trim()) throw new Error(`Candidate ${i} missing claim.`);
    if (!Array.isArray(c.source_refs)) throw new Error(`Candidate ${i} missing source_refs array.`);
    if (typeof c.why_future_useful !== "string" || !c.why_future_useful.trim()) {
      throw new Error(`Candidate ${i} missing why_future_useful.`);
    }
    return {
      claim: c.claim,
      source_refs: c.source_refs,
      why_future_useful: c.why_future_useful,
    };
  });
  return { candidates };
}

export async function callOpenRouter(request: {
  model: ModelConfig;
  system: string;
  user: string;
}): Promise<string> {
  if (request.model.provider !== "openrouter") {
    throw new Error(`Unsupported model provider: ${request.model.provider}`);
  }
  const res = await fetch(`${request.model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.model.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model.modelName,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      temperature: 0.1,
      max_tokens: 900,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter request failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter response did not include message content.");
  return content;
}

function defaultRunId(): string {
  return `capture-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function writeEval(parsed: CaptureOutput): string {
  const usable = parsed.candidates.filter(
    (candidate) =>
      candidate.claim.trim().length > 20 &&
      candidate.source_refs.length > 0 &&
      candidate.why_future_useful.trim().length > 10,
  );
  return [
    "# Capture Experiment Eval",
    "",
    `- Candidate count: ${parsed.candidates.length}`,
    `- Candidates with source refs: ${parsed.candidates.filter((c) => c.source_refs.length > 0).length}`,
    `- Role boundary: capture-only output; no proposal creation or activation attempted.`,
    `- Usability: ${usable.length > 0 ? "usable candidate memories present" : "no obviously usable candidates"}`,
    "",
    "## Notes",
    "",
    "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
  ].join("\n");
}

export async function runCaptureExperiment(
  paths: ExperimentPaths,
  options: RunCaptureExperimentOptions = {},
): Promise<CaptureExperimentResult> {
  const model = options.model ?? loadModelConfig(path.resolve(import.meta.dirname, "../.."));
  const runId = options.runId ?? defaultRunId();
  const runDir = path.join(paths.home, "experiments", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const slice = selectDeterministicSessionSlice(paths, options);
  const prompt = buildCapturePrompt(slice);
  const input = {
    run_id: runId,
    specialist: captureSpecialist,
    runtime: mastraRuntimeMetadata(captureSpecialist),
    model: redactModel(model),
    source: {
      id: slice.source.id,
      session_id: slice.source.session_id,
      source_path: slice.source.source_path,
    },
    chunks: slice.chunks,
    prompt,
  };

  fs.writeFileSync(path.join(runDir, "input.json"), JSON.stringify(input, null, 2));

  const raw = await (options.callModel ?? createMastraModelCaller(captureSpecialist))({
    model,
    system: prompt.system,
    user: prompt.user,
  });
  fs.writeFileSync(path.join(runDir, "output.raw.md"), raw);

  let parsed: CaptureOutput;
  try {
    parsed = parseCaptureOutput(raw);
  } catch (e) {
    fs.writeFileSync(
      path.join(runDir, "eval.md"),
      [
        "# Capture Experiment Eval",
        "",
        "- Status: parse failed",
        `- Error: ${(e as Error).message}`,
        "- Role boundary: no database writes, proposal creation, or activation attempted.",
        "",
        "This is a throwaway local experiment artifact. It is not written to the canonical Refinery database.",
      ].join("\n"),
    );
    throw e;
  }
  fs.writeFileSync(path.join(runDir, "output.parsed.json"), JSON.stringify(parsed, null, 2));
  fs.writeFileSync(path.join(runDir, "eval.md"), writeEval(parsed));

  return { runId, runDir, parsed };
}

export async function runCaptureExperimentFromCli(): Promise<void> {
  const result = await runCaptureExperiment(resolvePaths());
  console.log(`Capture experiment saved: ${path.relative(process.cwd(), result.runDir)}`);
  console.log(`Candidates parsed: ${result.parsed.candidates.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCaptureExperimentFromCli().catch((e) => {
    process.stderr.write(`Capture experiment failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
