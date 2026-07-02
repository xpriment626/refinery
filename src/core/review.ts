import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refineryReviewSchemaVersion, type MemoryProposal } from "./adapter.ts";
import { serializeRefineryError, RefineryError } from "./errors.ts";
import { writeReviewArtifactManifest, type ReviewRunMode } from "./artifacts.ts";
import { type ReviewIntent } from "./intents.ts";

const DEFAULT_SINK_TIMEOUT_MS = 10_000;
const MAX_SINK_RESPONSE_TEXT_CHARS = 4000;

export interface ReviewSinkOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ReviewSinkResult {
  url: string;
  ok: boolean;
  status: number;
  deliveredAt: string;
  responseText: string;
}

export interface ReviewRejected {
  sourceId: string;
  reason: string;
}

export interface ReviewRunResult {
  ok: true;
  schemaVersion: typeof refineryReviewSchemaVersion;
  command: "review";
  adapter: { name: string };
  scope: string;
  dryRun: true;
  runId: string;
  runDir: string;
  counts: {
    sources: number;
    activeMemories: number;
    proposals: number;
    rejected: number;
    claims?: number;
    challenges?: number;
    deliberationMoves?: number;
  };
  proposals: MemoryProposal[];
  rejected: ReviewRejected[];
  metadata: ReviewRunMetadata;
  sink?: ReviewSinkResult;
}

export interface ReviewRunMetadata {
  schemaVersion: typeof refineryReviewSchemaVersion;
  runId: string;
  adapter: string;
  scope: string;
  dryRun: true;
  mode: ReviewRunMode;
  createdAt: string;
  writesAttempted: false;
  sinkUrl: string | null;
  runtime: Record<string, unknown>;
  specialistOrder: string[];
  sourceLimit: number | null;
  sourceCharLimit: number | null;
  intent: ReviewIntent;
  request: string | null;
  model?: Record<string, unknown>;
}

export interface ReviewFailureStatus {
  ok: false;
  schemaVersion: typeof refineryReviewSchemaVersion;
  command: "review";
  status: "failed";
  runId: string;
  runDir: string;
  adapter: string | null;
  scope: string;
  mode: ReviewRunMode;
  failedStep: string | null;
  rawOutputPath: string | null;
  createdAt: string;
  failedAt: string;
  error: Record<string, unknown>;
  intent?: ReviewIntent;
  request?: string | null;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function writeReviewFailureStatus(args: {
  runDir: string;
  runId: string;
  adapterName?: string | null;
  scope: string;
  mode: ReviewRunMode;
  createdAt: string;
  error: RefineryError;
  intent?: ReviewIntent;
  request?: string | null;
}): ReviewFailureStatus {
  const status: ReviewFailureStatus = {
    ok: false,
    schemaVersion: refineryReviewSchemaVersion,
    command: "review",
    status: "failed",
    runId: args.runId,
    runDir: args.runDir,
    adapter: args.adapterName ?? null,
    scope: args.scope,
    mode: args.mode,
    failedStep: args.error.failedStep ?? null,
    rawOutputPath: args.error.rawOutputPath ?? null,
    createdAt: args.createdAt,
    failedAt: new Date().toISOString(),
    error: serializeRefineryError(args.error),
    ...(args.intent ? { intent: args.intent } : {}),
    ...(args.request !== undefined ? { request: args.request } : {}),
  };
  writeJson(path.join(args.runDir, "status.json"), status);
  writeJson(path.join(args.runDir, "review.json"), status);
  writeReviewArtifactManifest({
    runDir: args.runDir,
    runId: args.runId,
    adapterName: args.adapterName ?? null,
    scope: args.scope,
    mode: args.mode,
    status: "failed",
    createdAt: args.createdAt,
    failedAt: status.failedAt,
    failedStep: status.failedStep,
    rawOutputPath: status.rawOutputPath,
    error: status.error,
    intent: args.intent,
    request: args.request,
  });
  return status;
}

export async function deliverReviewSink(
  sink: ReviewSinkOptions,
  result: Omit<ReviewRunResult, "sink">,
): Promise<ReviewSinkResult> {
  const parsedUrl = new URL(sink.url);
  if (parsedUrl.protocol === "file:") {
    const target = fileURLToPath(parsedUrl);
    writeJson(target, result);
    return {
      url: sink.url,
      ok: true,
      status: 0,
      deliveredAt: new Date().toISOString(),
      responseText: target,
    };
  }

  const timeoutMs = sink.timeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(sink.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sink.headers ?? {}),
      },
      body: JSON.stringify(result),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RefineryError(
        "SINK_CALLBACK_TIMEOUT",
        `Review sink callback timed out after ${timeoutMs}ms.`,
        { phase: "sink" },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const responseText = (await response.text()).slice(0, MAX_SINK_RESPONSE_TEXT_CHARS);
  const sinkResult = {
    url: sink.url,
    ok: response.ok,
    status: response.status,
    deliveredAt: new Date().toISOString(),
    responseText,
  };
  if (!response.ok) {
    throw new RefineryError(
      "SINK_CALLBACK_FAILED",
      `Review sink callback failed with status ${response.status}: ${responseText}`,
      { phase: "sink", status: response.status },
    );
  }
  return sinkResult;
}
