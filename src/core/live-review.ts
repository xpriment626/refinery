import fs from "node:fs";
import path from "node:path";
import { loadModelConfig, type ModelConfig } from "../env.ts";
import { createMastraModelCaller, mastraRuntimeMetadata } from "../runtimes/mastra/runtime.ts";
import {
  memoryMaintenanceActions,
  refineryReviewSchemaVersion,
  type ActiveMemory,
  type MemoryMaintenanceAction,
  type MemoryProposal,
  type MemoryStoreAdapter,
  type SourceEvidence,
} from "./adapter.ts";
import {
  applyErrorContext,
  asRefineryError,
  RefineryError,
} from "./errors.ts";
import {
  captureSpecialist,
  distillationSpecialist,
  relationshipReviewSpecialist,
  relevanceSpecialist,
  schemaSpecialist,
} from "./specialists/index.ts";
import type { LocalSpecialist, ModelCaller } from "./specialists/types.ts";
import {
  deliverReviewSink,
  writeReviewFailureStatus,
  type ReviewRejected,
  type ReviewRunResult,
  type ReviewSinkOptions,
  type ReviewSinkResult,
} from "./review.ts";
import { writeReviewArtifactManifest } from "./artifacts.ts";

const specialistOrder = ["capture", "distillation", "schema", "relevance", "relationship-review"];

export interface LiveReviewRunOptions {
  adapter: MemoryStoreAdapter;
  scope: string;
  runId: string;
  outputDir: string;
  model?: ModelConfig;
  callModel?: ModelCaller;
  sourceLimit?: number;
  sourceCharLimit?: number;
  sink?: ReviewSinkOptions;
}

export interface CaptureCandidate {
  claim: string;
  source_refs: unknown[];
  why_future_useful: string;
}

export interface CaptureOutput {
  candidates: CaptureCandidate[];
}

export interface DistilledMemory {
  body: string;
  source_refs: unknown[];
  rationale: string;
}

export interface DistillationOutput {
  distilled: DistilledMemory[];
}

export interface TypedCandidate {
  body: string;
  memory_type: string;
  primary_type: string;
  secondary_type: string | null;
  type_confidence: number;
  type_rationale: string;
  ambiguities: string[];
  durability: "durable" | "ttl" | "ephemeral";
  ttl: string | null;
  proposed_scope: string;
  action: MemoryMaintenanceAction;
  target_memory_id: string | number | null;
  source_refs: unknown[];
}

export interface SchemaOutput {
  typed: TypedCandidate[];
}

export interface RelevanceProposal {
  memory_type: string;
  proposed_scope: string;
  body: string;
  confidence: number;
  rationale: string;
  source_refs: unknown[];
  action: MemoryMaintenanceAction;
  target_memory_id: string | number | null;
}

export interface RejectedCandidate {
  body?: string;
  reason: string;
}

export interface RelevanceOutput {
  proposals: RelevanceProposal[];
  rejected: RejectedCandidate[];
}

export interface RelationshipFinding {
  body: string;
  relation: "novel" | "duplicate" | "refinement" | "contradiction" | "supersession" | "too_weak";
  target_memory_id: string | number | null;
  confidence: number;
  rationale: string;
  source_refs: unknown[];
  memory_refs: { memory_id: string | number; provenance_kind: string | null }[];
}

export interface RelationshipReviewOutput {
  findings: RelationshipFinding[];
}

export interface LiveReviewRunResult extends ReviewRunResult {
  mode: "live";
  model: Omit<ModelConfig, "apiKey"> & { apiKeyPresent: boolean };
  relationshipReview: RelationshipReviewOutput;
  sink?: ReviewSinkResult;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("Model response did not contain a JSON object.");
  return JSON.parse(candidate.slice(first, last + 1)) as unknown;
}

function redactModel(config: ModelConfig): Omit<ModelConfig, "apiKey"> & {
  apiKeyPresent: boolean;
} {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKeyPresent: Boolean(config.apiKey),
  };
}

function compactText(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 3).trimEnd() + "...";
}

function sourceRefs(source: SourceEvidence): unknown[] {
  if (source.refs && source.refs.length > 0) return source.refs;
  return [{ source_id: source.id, source_path: source.path ?? null, kind: source.kind }];
}

function normalizeId(value: string | number | null): string | null {
  if (value === null) return null;
  return typeof value === "number" ? `memory:${value}` : value;
}

function parseAction(value: unknown, legacyValue: unknown, label: string): MemoryMaintenanceAction {
  const action = value ?? legacyValue;
  if (!memoryMaintenanceActions.includes(action as MemoryMaintenanceAction)) {
    throw new Error(`${label} has invalid action.`);
  }
  return action as MemoryMaintenanceAction;
}

function parseCapture(raw: string): CaptureOutput {
  const parsed = extractJson(raw) as { candidates?: unknown[] };
  if (!Array.isArray(parsed.candidates)) throw new Error("Capture output must contain candidates array.");
  return {
    candidates: parsed.candidates.map((candidate, index) => {
      if (!candidate || typeof candidate !== "object") throw new Error(`Candidate ${index} must be an object.`);
      const c = candidate as Partial<CaptureCandidate>;
      if (typeof c.claim !== "string" || !c.claim.trim()) throw new Error(`Candidate ${index} missing claim.`);
      if (!Array.isArray(c.source_refs)) throw new Error(`Candidate ${index} missing source_refs array.`);
      if (typeof c.why_future_useful !== "string" || !c.why_future_useful.trim()) {
        throw new Error(`Candidate ${index} missing why_future_useful.`);
      }
      return { claim: c.claim, source_refs: c.source_refs, why_future_useful: c.why_future_useful };
    }),
  };
}

function parseDistillation(raw: string): DistillationOutput {
  const parsed = extractJson(raw) as { distilled?: unknown[] };
  if (!Array.isArray(parsed.distilled)) throw new Error("Distillation output must contain distilled array.");
  return {
    distilled: parsed.distilled.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Distilled item ${index} must be an object.`);
      const d = item as Partial<DistilledMemory>;
      if (typeof d.body !== "string" || !d.body.trim()) throw new Error(`Distilled item ${index} missing body.`);
      if (!Array.isArray(d.source_refs)) throw new Error(`Distilled item ${index} missing source_refs array.`);
      if (typeof d.rationale !== "string" || !d.rationale.trim()) {
        throw new Error(`Distilled item ${index} missing rationale.`);
      }
      return { body: d.body, source_refs: d.source_refs, rationale: d.rationale };
    }),
  };
}

function parseSchema(raw: string): SchemaOutput {
  const parsed = extractJson(raw) as { typed?: unknown[] };
  if (!Array.isArray(parsed.typed)) throw new Error("Schema output must contain typed array.");
  return {
    typed: parsed.typed.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Typed item ${index} must be an object.`);
      const t = item as Partial<TypedCandidate>;
      if (typeof t.body !== "string" || !t.body.trim()) throw new Error(`Typed item ${index} missing body.`);
      if (typeof t.memory_type !== "string" || !t.memory_type.trim()) throw new Error(`Typed item ${index} missing memory_type.`);
      if (typeof t.primary_type !== "string" || !t.primary_type.trim()) throw new Error(`Typed item ${index} missing primary_type.`);
      if (t.secondary_type !== null && typeof t.secondary_type !== "string") {
        throw new Error(`Typed item ${index} secondary_type must be string or null.`);
      }
      if (typeof t.type_confidence !== "number" || t.type_confidence < 0 || t.type_confidence > 1) {
        throw new Error(`Typed item ${index} type_confidence must be 0..1.`);
      }
      if (typeof t.type_rationale !== "string" || !t.type_rationale.trim()) {
        throw new Error(`Typed item ${index} missing type_rationale.`);
      }
      if (!Array.isArray(t.ambiguities)) throw new Error(`Typed item ${index} missing ambiguities array.`);
      if (t.durability !== "durable" && t.durability !== "ttl" && t.durability !== "ephemeral") {
        throw new Error(`Typed item ${index} has invalid durability.`);
      }
      if (t.ttl !== null && typeof t.ttl !== "string") throw new Error(`Typed item ${index} ttl must be string or null.`);
      if (typeof t.proposed_scope !== "string" || !t.proposed_scope.trim()) {
        throw new Error(`Typed item ${index} missing proposed_scope.`);
      }
      const action = parseAction(t.action, (t as { mutation_op?: unknown }).mutation_op, `Typed item ${index}`);
      if (t.target_memory_id !== null && typeof t.target_memory_id !== "string" && typeof t.target_memory_id !== "number") {
        throw new Error(`Typed item ${index} target_memory_id must be string, number, or null.`);
      }
      if (!Array.isArray(t.source_refs)) throw new Error(`Typed item ${index} missing source_refs array.`);
      return {
        body: t.body,
        memory_type: t.memory_type,
        primary_type: t.primary_type,
        secondary_type: t.secondary_type,
        type_confidence: t.type_confidence,
        type_rationale: t.type_rationale,
        ambiguities: t.ambiguities,
        durability: t.durability,
        ttl: t.ttl,
        proposed_scope: t.proposed_scope,
        action,
        target_memory_id: t.target_memory_id,
        source_refs: t.source_refs,
      };
    }),
  };
}

function parseRelevance(raw: string): RelevanceOutput {
  const parsed = extractJson(raw) as { proposals?: unknown[]; rejected?: unknown[] };
  if (!Array.isArray(parsed.proposals) || !Array.isArray(parsed.rejected)) {
    throw new Error("Relevance output must contain proposals and rejected arrays.");
  }
  return {
    proposals: parsed.proposals.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Proposal ${index} must be an object.`);
      const p = item as Partial<RelevanceProposal>;
      if (typeof p.memory_type !== "string" || !p.memory_type.trim()) throw new Error(`Proposal ${index} missing memory_type.`);
      if (typeof p.proposed_scope !== "string" || !p.proposed_scope.trim()) {
        throw new Error(`Proposal ${index} missing proposed_scope.`);
      }
      if (typeof p.body !== "string" || !p.body.trim()) throw new Error(`Proposal ${index} missing body.`);
      if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) {
        throw new Error(`Proposal ${index} confidence must be 0..1.`);
      }
      if (typeof p.rationale !== "string" || !p.rationale.trim()) throw new Error(`Proposal ${index} missing rationale.`);
      if (!Array.isArray(p.source_refs)) throw new Error(`Proposal ${index} missing source_refs array.`);
      const action = parseAction(p.action, (p as { mutation_op?: unknown }).mutation_op, `Proposal ${index}`);
      if (p.target_memory_id !== null && typeof p.target_memory_id !== "string" && typeof p.target_memory_id !== "number") {
        throw new Error(`Proposal ${index} target_memory_id must be string, number, or null.`);
      }
      return {
        memory_type: p.memory_type,
        proposed_scope: p.proposed_scope,
        body: p.body,
        confidence: p.confidence,
        rationale: p.rationale,
        source_refs: p.source_refs,
        action,
        target_memory_id: p.target_memory_id,
      };
    }),
    rejected: parsed.rejected.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Rejected item ${index} must be an object.`);
      const r = item as Partial<RejectedCandidate>;
      if (typeof r.reason !== "string" || !r.reason.trim()) throw new Error(`Rejected item ${index} missing reason.`);
      return { body: typeof r.body === "string" ? r.body : undefined, reason: r.reason };
    }),
  };
}

function parseRelationshipReview(raw: string): RelationshipReviewOutput {
  const parsed = extractJson(raw) as { findings?: unknown[] };
  if (!Array.isArray(parsed.findings)) throw new Error("Relationship Review output must contain findings array.");
  return {
    findings: parsed.findings.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Finding ${index} must be an object.`);
      const f = item as Partial<RelationshipFinding>;
      if (typeof f.body !== "string" || !f.body.trim()) throw new Error(`Finding ${index} missing body.`);
      if (!["novel", "duplicate", "refinement", "contradiction", "supersession", "too_weak"].includes(String(f.relation))) {
        throw new Error(`Finding ${index} has invalid relation.`);
      }
      if (f.target_memory_id !== null && typeof f.target_memory_id !== "string" && typeof f.target_memory_id !== "number") {
        throw new Error(`Finding ${index} target_memory_id must be string, number, or null.`);
      }
      if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
        throw new Error(`Finding ${index} confidence must be 0..1.`);
      }
      if (typeof f.rationale !== "string" || !f.rationale.trim()) throw new Error(`Finding ${index} missing rationale.`);
      if (!Array.isArray(f.source_refs)) throw new Error(`Finding ${index} missing source_refs array.`);
      if (!Array.isArray(f.memory_refs)) throw new Error(`Finding ${index} missing memory_refs array.`);
      const memoryRefs = f.memory_refs.map((memoryRef) => {
        if (typeof memoryRef === "string" || typeof memoryRef === "number") {
          return { memory_id: typeof memoryRef === "number" ? `memory:${memoryRef}` : memoryRef, provenance_kind: null };
        }
        if (memoryRef && typeof memoryRef === "object") {
          const ref = memoryRef as { memory_id?: unknown; provenance_kind?: unknown };
          if (typeof ref.memory_id !== "string" && typeof ref.memory_id !== "number") {
            throw new Error(`Finding ${index} memory_ref missing memory_id.`);
          }
          return {
            memory_id: typeof ref.memory_id === "number" ? `memory:${ref.memory_id}` : ref.memory_id,
            provenance_kind: typeof ref.provenance_kind === "string" ? ref.provenance_kind : null,
          };
        }
        throw new Error(`Finding ${index} memory_ref must be an object, string, or number.`);
      });
      return { ...(f as RelationshipFinding), memory_refs: memoryRefs };
    }),
  };
}

function buildPrompt(args: {
  specialist: LocalSpecialist;
  shape: string;
  instruction: string;
  payload: unknown;
}): { system: string; user: string } {
  return {
    system: [
      args.specialist.prompt,
      "",
      "Return only JSON matching this shape:",
      args.shape,
      args.instruction,
      "Do not wrap the answer in prose. Do not activate, approve, or write memory.",
    ].join("\n"),
    user: [
      "Process this Refinery live review payload using your specialist contract.",
      "",
      JSON.stringify(args.payload, null, 2),
    ].join("\n"),
  };
}

async function runStep<T>(args: {
  runDir: string;
  stepName: string;
  specialist: LocalSpecialist;
  model: ModelConfig;
  prompt: { system: string; user: string };
  inputPayload: unknown;
  parse: (raw: string) => T;
  callModel?: ModelCaller;
}): Promise<T> {
  const stepDir = path.join(args.runDir, "steps", args.stepName);
  const rawOutputPath = path.join(stepDir, "output.raw.md");
  fs.mkdirSync(stepDir, { recursive: true });
  writeJson(path.join(stepDir, "input.json"), {
    step: args.stepName,
    specialist: args.specialist,
    runtime: mastraRuntimeMetadata(args.specialist),
    model: redactModel(args.model),
    input: args.inputPayload,
    prompt: args.prompt,
  });
  let raw: string;
  try {
    raw = await (args.callModel ?? createMastraModelCaller(args.specialist))({
      model: args.model,
      system: args.prompt.system,
      user: args.prompt.user,
      specialist: args.specialist,
    });
  } catch (error) {
    throw new RefineryError(
      "MODEL_CALL_FAILED",
      error instanceof Error ? error.message : String(error),
      { phase: "live", runDir: args.runDir, failedStep: args.stepName },
    );
  }
  fs.writeFileSync(rawOutputPath, raw);
  let parsed: T;
  try {
    parsed = args.parse(raw);
  } catch (error) {
    throw new RefineryError(
      "MODEL_OUTPUT_INVALID",
      error instanceof Error ? error.message : String(error),
      {
        phase: "live",
        runDir: args.runDir,
        failedStep: args.stepName,
        rawOutputPath,
      },
    );
  }
  writeJson(path.join(stepDir, "output.parsed.json"), parsed);
  return parsed;
}

function toSourceChunks(sources: SourceEvidence[], charLimit: number): unknown[] {
  let remaining = charLimit;
  return sources
    .map((source) => {
      const text = compactText(source.text, Math.max(0, remaining));
      remaining -= text.length;
      return {
        id: source.id,
        kind: source.kind,
        path: source.path ?? null,
        text,
        refs: sourceRefs(source),
      };
    })
    .filter((source) => typeof source.text === "string" && source.text.length > 0);
}

function memoryHints(memories: ActiveMemory[], limit = 10): unknown[] {
  return memories.slice(0, limit).map((memory) => ({
    id: memory.id,
    type: memory.type,
    scope: memory.scope,
    body: compactText(memory.body, 260),
    provenance: memory.provenance ?? null,
  }));
}

function activeMemoryCandidates(memories: ActiveMemory[], relevance: RelevanceOutput): unknown[] {
  return relevance.proposals.map((proposal, proposalIndex) => ({
    proposal_index: proposalIndex,
    proposal_body: proposal.body,
    memories: memoryHints(memories, 5),
  }));
}

function toMemoryProposal(runId: string, proposal: RelevanceProposal, index: number): MemoryProposal {
  return {
    schemaVersion: refineryReviewSchemaVersion,
    id: `proposal:${runId}:${index + 1}`,
    action: proposal.action,
    lifecycle: "proposed",
    memoryType: proposal.memory_type,
    scope: proposal.proposed_scope,
    body: proposal.body,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
    sourceRefs: proposal.source_refs,
    targetMemoryId: normalizeId(proposal.target_memory_id),
  };
}

export async function runLiveReview(options: LiveReviewRunOptions): Promise<LiveReviewRunResult> {
  const runDir = path.join(options.outputDir, options.runId);
  const createdAt = new Date().toISOString();
  const model = options.model ?? loadModelConfig();
  const sourceLimit = Math.max(1, Math.min(options.sourceLimit ?? 3, 10));
  const sourceCharLimit = Math.max(500, Math.min(options.sourceCharLimit ?? 6000, 24000));
  fs.mkdirSync(runDir, { recursive: true });
  try {
  const [sources, activeMemories] = await Promise.all([
    options.adapter.listSourceEvidence({ scope: options.scope, limit: sourceLimit }),
    options.adapter.listActiveMemories({ scope: options.scope, limit: 50 }),
  ]);
  const sourceChunks = toSourceChunks(sources, sourceCharLimit);
  const activeMemoryHints = memoryHints(activeMemories, 10);

  writeJson(path.join(runDir, "input.json"), {
    adapter: options.adapter.name,
    scope: options.scope,
    mode: "live",
    sourceLimit,
    sourceCharLimit,
    sources,
    activeMemories,
  });

  const capturePayload = { source_chunks: sourceChunks, active_memory_hints: activeMemoryHints };
  const capture = await runStep({
    runDir,
    stepName: "capture",
    specialist: captureSpecialist,
    model,
    inputPayload: capturePayload,
    prompt: buildPrompt({
      specialist: captureSpecialist,
      shape: `{"candidates":[{"claim":"...","source_refs":[],"why_future_useful":"..."}]}`,
      instruction: "Return exactly one durable candidate for this smoke run. Keep the claim concise and evidence-bound.",
      payload: capturePayload,
    }),
    parse: parseCapture,
    callModel: options.callModel,
  });

  const distillationPayload = { candidates: capture.candidates };
  const distillation = await runStep({
    runDir,
    stepName: "distillation",
    specialist: distillationSpecialist,
    model,
    inputPayload: distillationPayload,
    prompt: buildPrompt({
      specialist: distillationSpecialist,
      shape: `{"distilled":[{"body":"...","source_refs":[],"rationale":"..."}]}`,
      instruction: "Rewrite each candidate into an atomic, self-contained memory body.",
      payload: distillationPayload,
    }),
    parse: parseDistillation,
    callModel: options.callModel,
  });

  const schemaPayload = {
    distilled: distillation.distilled,
    active_memory_hints: activeMemoryHints,
  };
  const schema = await runStep({
    runDir,
    stepName: "schema",
    specialist: schemaSpecialist,
    model,
    inputPayload: schemaPayload,
    prompt: buildPrompt({
      specialist: schemaSpecialist,
      shape: `{"typed":[{"body":"...","memory_type":"procedural","primary_type":"procedural","secondary_type":null,"type_confidence":0.8,"type_rationale":"...","ambiguities":[],"durability":"durable","ttl":null,"proposed_scope":"project","action":"create","target_memory_id":null,"source_refs":[]}]}`,
      instruction: "Use project scope for this slice. Set memory_type equal to primary_type.",
      payload: schemaPayload,
    }),
    parse: parseSchema,
    callModel: options.callModel,
  });

  const relevancePayload = { typed: schema.typed };
  const relevance = await runStep({
    runDir,
    stepName: "relevance",
    specialist: relevanceSpecialist,
    model,
    inputPayload: relevancePayload,
    prompt: buildPrompt({
      specialist: relevanceSpecialist,
      shape: `{"proposals":[{"memory_type":"procedural","proposed_scope":"project","body":"...","confidence":0.8,"rationale":"...","source_refs":[],"action":"create","target_memory_id":null}],"rejected":[]}`,
      instruction: "Emit proposal-shaped records only for durable future-useful candidates.",
      payload: relevancePayload,
    }),
    parse: parseRelevance,
    callModel: options.callModel,
  });

  const relationshipPayload = {
    relevance,
    active_memory_candidates: activeMemoryCandidates(activeMemories, relevance),
  };
  const relationshipReview = await runStep({
    runDir,
    stepName: "relationship-review",
    specialist: relationshipReviewSpecialist,
    model,
    inputPayload: relationshipPayload,
    prompt: buildPrompt({
      specialist: relationshipReviewSpecialist,
      shape: `{"findings":[{"body":"...","relation":"novel","target_memory_id":null,"confidence":0.8,"rationale":"...","source_refs":[],"memory_refs":[{"memory_id":"memory:1","provenance_kind":"fixture"}]}]}`,
      instruction: "Classify each proposal exactly once against active-memory candidates. memory_refs must be objects, never bare strings.",
      payload: relationshipPayload,
    }),
    parse: parseRelationshipReview,
    callModel: options.callModel,
  });

  const proposals = relevance.proposals.map((proposal, index) => toMemoryProposal(options.runId, proposal, index));
  const rejected: ReviewRejected[] = relevance.rejected.map((item, index) => ({
    sourceId: `rejected:${options.runId}:${index + 1}`,
    reason: item.reason,
  }));
  writeJson(path.join(runDir, "proposals.json"), proposals);
  writeJson(path.join(runDir, "rejected.json"), rejected);

  const result: LiveReviewRunResult = {
    ok: true,
    schemaVersion: refineryReviewSchemaVersion,
    command: "review",
    mode: "live",
    adapter: { name: options.adapter.name },
    scope: options.scope,
    dryRun: true,
    runId: options.runId,
    runDir,
    model: redactModel(model),
    relationshipReview,
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
      mode: "live",
      model: redactModel(model),
      createdAt,
      writesAttempted: false,
      sinkUrl: options.sink?.url ?? null,
      runtime: { adapter: "mastra" },
      specialistOrder,
      sourceLimit,
      sourceCharLimit,
    },
  };

  writeJson(path.join(runDir, "metadata.json"), result.metadata);
  writeJson(path.join(runDir, "review.json"), result);
  writeReviewArtifactManifest({
    runDir,
    runId: options.runId,
    adapterName: options.adapter.name,
    scope: options.scope,
    mode: "live",
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
    mode: "live",
    status: "succeeded",
    createdAt,
    counts: result.counts,
    metadata: result.metadata,
  });
  return resultWithSink;
} catch (error) {
  const refineryError = applyErrorContext(asRefineryError(error, { code: "LIVE_REVIEW_FAILED" }), {
    phase: "live",
    runId: options.runId,
    runDir,
  });
  writeReviewFailureStatus({
    runDir,
    runId: options.runId,
    adapterName: options.adapter.name,
    scope: options.scope,
    mode: "live",
    createdAt,
    error: refineryError,
  });
  throw refineryError;
}
}
