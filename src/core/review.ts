import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ActiveMemory,
  type MemoryProposal,
  type MemoryStoreAdapter,
  type SourceEvidence,
  refineryReviewSchemaVersion,
} from "./adapter.ts";
import {
  applyErrorContext,
  asRefineryError,
  RefineryError,
  serializeRefineryError,
} from "./errors.ts";
import { writeReviewArtifactManifest, type ReviewRunMode } from "./artifacts.ts";

const DEFAULT_SINK_TIMEOUT_MS = 10_000;
const MAX_SINK_RESPONSE_TEXT_CHARS = 4000;

export interface ReviewRunOptions {
  adapter: MemoryStoreAdapter;
  scope: string;
  runId: string;
  outputDir: string;
  sink?: ReviewSinkOptions;
}

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

export interface RelationshipFinding {
  proposalId: string;
  relation: "novel" | "duplicate" | "refinement" | "contradiction" | "supersession" | "too_weak";
  targetMemoryId: string | null;
  confidence: number;
  rationale: string;
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
  });
  return status;
}

function compactText(text: string, max = 420): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 3).trimEnd() + "...";
}

function sourceRefs(source: SourceEvidence): unknown[] {
  if (source.refs && source.refs.length > 0) return source.refs;
  return [{ source_id: source.id, source_path: source.path ?? null, kind: source.kind }];
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function classifyRelationship(
  proposal: MemoryProposal,
  memories: ActiveMemory[],
): RelationshipFinding {
  const proposalBody = normalizeForCompare(proposal.body);
  const exact = memories.find((memory) => normalizeForCompare(memory.body) === proposalBody);
  if (exact) {
    return {
      proposalId: proposal.id,
      relation: "duplicate",
      targetMemoryId: exact.id,
      confidence: 0.92,
      rationale: "Proposal body exactly matches an active memory after normalization.",
    };
  }

  const overlapping = memories.find((memory) => {
    const memoryBody = normalizeForCompare(memory.body);
    return proposalBody.includes(memoryBody) || memoryBody.includes(proposalBody);
  });
  if (overlapping) {
    return {
      proposalId: proposal.id,
      relation: "refinement",
      targetMemoryId: overlapping.id,
      confidence: 0.72,
      rationale: "Proposal and active memory materially overlap but are not exact duplicates.",
    };
  }

  return {
    proposalId: proposal.id,
    relation: "novel",
    targetMemoryId: null,
    confidence: 0.68,
    rationale: "No active memory materially overlaps this proposal in the adapter snapshot.",
  };
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

export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const runDir = path.join(options.outputDir, options.runId);
  const createdAt = new Date().toISOString();
  fs.mkdirSync(runDir, { recursive: true });
  try {
    const scopeInput = { scope: options.scope };
    const [sources, activeMemories] = await Promise.all([
      options.adapter.listSourceEvidence(scopeInput),
      options.adapter.listActiveMemories(scopeInput),
    ]);

  writeJson(path.join(runDir, "input.json"), {
    adapter: options.adapter.name,
    scope: options.scope,
    sources,
    activeMemories,
  });

  const capture = {
    candidates: sources
      .map((source) => ({
        source_id: source.id,
        claim: compactText(source.text),
        source_refs: sourceRefs(source),
        why_future_useful: "Candidate came from adapter-provided source evidence.",
      }))
      .filter((candidate) => candidate.claim.length > 0),
  };
  writeJson(path.join(runDir, "steps/capture/output.parsed.json"), capture);

  const distillation = {
    distilled: capture.candidates.map((candidate, index) => ({
      id: `distilled:${index + 1}`,
      body: candidate.claim,
      source_refs: candidate.source_refs,
      rationale: "Deterministic CLI scaffold preserved the source claim as an atomic body.",
    })),
  };
  writeJson(path.join(runDir, "steps/distillation/output.parsed.json"), distillation);

  const schema = {
    typed: distillation.distilled.map((item) => ({
      ...item,
      memory_type: "semantic",
      primary_type: "semantic",
      secondary_type: null,
      type_confidence: 0.55,
      type_rationale: "The CLI scaffold cannot infer a narrower type without a model pass.",
      ambiguities: ["deterministic_scaffold"],
      durability: "durable",
      ttl: null,
      proposed_scope: options.scope,
      action: "create",
      target_memory_id: null,
    })),
  };
  writeJson(path.join(runDir, "steps/schema/output.parsed.json"), schema);

  const rejected: ReviewRejected[] = [];
  const proposals: MemoryProposal[] = schema.typed.map((item, index) => ({
    schemaVersion: refineryReviewSchemaVersion,
    id: `proposal:${options.runId}:${index + 1}`,
    action: "create",
    lifecycle: "proposed",
    memoryType: item.memory_type,
    scope: item.proposed_scope,
    body: item.body,
    confidence: 0.55,
    rationale: "Dry-run proposal emitted by the deterministic CLI review scaffold.",
    sourceRefs: item.source_refs,
    targetMemoryId: null,
  }));
  const relevance = { proposals, rejected };
  writeJson(path.join(runDir, "steps/relevance/output.parsed.json"), relevance);

  const relationshipReview = {
    findings: proposals.map((proposal) => classifyRelationship(proposal, activeMemories)),
  };
  writeJson(path.join(runDir, "steps/relationship-review/output.parsed.json"), relationshipReview);
  writeJson(path.join(runDir, "proposals.json"), proposals);
  writeJson(path.join(runDir, "rejected.json"), rejected);

  const result: ReviewRunResult = {
    ok: true,
    schemaVersion: refineryReviewSchemaVersion,
    command: "review",
    adapter: { name: options.adapter.name },
    scope: options.scope,
    dryRun: true,
    runId: options.runId,
    runDir,
    counts: {
      sources: sources.length,
      activeMemories: activeMemories.length,
      proposals: proposals.length,
      rejected: rejected.length,
    },
    proposals,
    rejected,
    metadata: {
      schemaVersion: refineryReviewSchemaVersion,
      runId: options.runId,
      adapter: options.adapter.name,
      scope: options.scope,
      dryRun: true,
      mode: "deterministic",
      createdAt,
      writesAttempted: false,
      sinkUrl: options.sink?.url ?? null,
      runtime: { adapter: "deterministic" },
      specialistOrder: ["capture", "distillation", "schema", "relevance", "relationship-review"],
      sourceLimit: null,
      sourceCharLimit: null,
    },
  };

  writeJson(path.join(runDir, "metadata.json"), result.metadata);
  writeJson(path.join(runDir, "review.json"), result);
  writeReviewArtifactManifest({
    runDir,
    runId: options.runId,
    adapterName: options.adapter.name,
    scope: options.scope,
    mode: "deterministic",
    status: "succeeded",
    createdAt,
    counts: result.counts,
    metadata: result.metadata,
  });
  if (!options.sink) return result;

  const sink = await deliverReviewSink(options.sink, result);
  const resultWithSink = { ...result, sink };
  writeJson(path.join(runDir, "sink.json"), sink);
  writeJson(path.join(runDir, "review.json"), resultWithSink);
  writeReviewArtifactManifest({
    runDir,
    runId: options.runId,
    adapterName: options.adapter.name,
    scope: options.scope,
    mode: "deterministic",
    status: "succeeded",
    createdAt,
    counts: result.counts,
    metadata: result.metadata,
  });
  return resultWithSink;
} catch (error) {
  const refineryError = applyErrorContext(asRefineryError(error, { code: "REVIEW_FAILED" }), {
    phase: "deterministic",
    runId: options.runId,
    runDir,
  });
  writeReviewFailureStatus({
    runDir,
    runId: options.runId,
    adapterName: options.adapter.name,
    scope: options.scope,
    mode: "deterministic",
    createdAt,
    error: refineryError,
  });
  throw refineryError;
}
}
