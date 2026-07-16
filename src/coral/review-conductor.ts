import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  allMessages,
  buildCoralSessionRequest,
  classifyAgentReadiness,
  closeSession,
  createSession,
  getExtended,
  getLocalAgent,
  inspectCoralRuntimeCapabilities,
  puppetCreateThread,
  puppetSendMessage,
  waitForAgentsReady,
  type CoralMessage,
  type ExtendedState,
  type SessionIdentifier,
  type CoralRuntimeCapabilities,
} from "./client.ts";
import {
  coralCloudOpenAiProxyProvider,
  defaultCoralProxyProvider,
  deepSeekProxyProvider,
  refineryCoralAgentGlobForRepo,
  refineryCoralModernAgentGlobForRepo,
  refineryCoralAgentNames,
  refineryCoralAuthKey,
  refineryCoralConfigPath,
  refineryCoralModelDefaults,
  refineryCoralPort,
} from "./definitions.ts";
import { buildCoralCommunicationProjection, defaultReviewTopology, type CoralCommunicationProjection, type ReviewTopology } from "./topology.ts";
import { coralRuntimeJarPath, verifyCoralRuntimeJarPath } from "./runtime.ts";
import {
  createSparseBlackboard,
  routeSparseClaims,
  type SparseBlackboard,
  type SparseTopic,
} from "./sparse-blackboard.ts";
import {
  memoryMaintenanceActions,
  refineryReviewSchemaVersion,
  type MemoryMaintenanceAction,
  type MemoryProposal,
  type ReviewPacket,
  type SkillCandidate,
  type SkillCandidateArtifact,
  type SkillCandidateRejection,
  type SkillCandidateUnresolved,
} from "../core/types.ts";
import { loadLocalEnv, parseModelMaxTokens } from "../env.ts";
import { resolveModelApiKey } from "../core/credentials.ts";
import {
  applyErrorContext,
  asRefineryError,
  RefineryError,
} from "../core/errors.ts";
import { writeReviewArtifactManifest, reviewStepOrder } from "../core/artifacts.ts";
import {
  buildDeliberationArtifacts,
  claimCardsForCritique,
  type DeliberationArtifacts,
  type DeliberationSpecialistMessage,
} from "../core/deliberation.ts";
import {
  deliverReviewSink,
  writeReviewFailureStatus,
  type ReviewRejected,
  type ReviewRunMetadata,
  type ReviewRunResult,
  type ReviewSinkOptions,
  type ReviewSinkResult,
} from "../core/review.ts";
import { defaultReviewIntent, describeReviewIntent, type ReviewIntent } from "../core/intents.ts";
import { resolveModelSelection } from "../core/model-selection.ts";

const DEFAULT_PIPELINE_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_DEBATE_CRITIQUE_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_WAIT_INTERVAL_MS = 1_500;
const MAX_EXCERPT_CHARS = 1200;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

export interface CoralReviewRuntimeOptions {
  apiUrl?: string;
  authKey?: string;
  configPath?: string;
  namespace?: string;
  sessionId?: string;
  threadId?: string;
  startServer?: boolean;
  noTeardown?: boolean;
  coralRuntimeJar?: string;
  coralJar?: string;
  timeoutMs?: number;
  modelName?: string;
  modelBaseUrl?: string;
  reasoningEffort?: string;
  maxTurns?: string;
  llmProxy?: boolean;
  modelProxyProvider?: string;
  topology?: ReviewTopology;
  modelHome?: string;
  modelCwd?: string;
}

export interface CoralReviewRunOptions {
  packet: ReviewPacket;
  runId: string;
  outputDir: string;
  hypothesis?: string;
  sink?: ReviewSinkOptions;
  coral?: CoralReviewRuntimeOptions;
}

interface CoralUsageSummary {
  callCount: number;
  status200Count: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptChars: number;
  usageComplete: boolean;
}

export interface CoralReviewRunResult extends ReviewRunResult {
  mode: "coral";
  sourceSets: ReviewPacket["sourceSets"];
  targets: ReviewPacket["targets"];
  project: string;
  evidenceReview: unknown;
  skillCandidates?: SkillCandidateArtifact;
  coral: {
    namespace: string;
    sessionId: string;
    threadId: string;
    threadIds?: string[];
    agents: string[];
    model?: {
      name: string;
      transport: "direct" | "coral-server-proxy";
      proxyProvider: string | null;
    };
    runtimeCapabilities?: CoralRuntimeCapabilities;
    runtimeProjection?: CoralCommunicationProjection;
    usage?: CoralUsageSummary;
  };
  sink?: ReviewSinkResult;
}

export interface CoralConsoleRunOptions {
  packet: ReviewPacket;
  runId: string;
  coral?: CoralReviewRuntimeOptions;
}

export interface CoralConsoleRunResult {
  ok: true;
  schemaVersion: typeof refineryReviewSchemaVersion;
  command: "console run";
  mode: "coral-console";
  sourceSets: ReviewPacket["sourceSets"];
  targets: ReviewPacket["targets"];
  project: string;
  scope: string;
  dryRun: true;
  archive: false;
  artifactDir: null;
  writesAttempted: false;
  runId: string;
  consoleUrl: string;
  schemaUrl: string;
  counts: {
    sourceSets: number;
    documents: number;
    activeMemoryHints: number;
    seededMessages: number;
  };
  coral: {
    apiUrl: string;
    namespace: string;
    sessionId: string;
    threadId: string;
    threadIds: string[];
    proposalThreadId?: string;
    critiqueThreadId?: string;
    agents: string[];
    topology: ReviewTopology;
    serverMode: "managed" | "attached";
    managedServerStarted: boolean;
    model: {
      name: string;
      transport: "direct" | "coral-server-proxy";
      proxyProvider: string | null;
    };
    runtimeCapabilities: CoralRuntimeCapabilities;
    runtimeProjection: CoralCommunicationProjection;
  };
  seededMessages: Array<{
    id: string;
    threadId: string;
    senderName: string;
    mentionNames: string[];
    textExcerpt: string;
  }>;
  next: string;
}

export interface CoralConsoleRunSession {
  result: CoralConsoleRunResult;
  managedServerStarted: boolean;
  managedProcess: ChildProcessWithoutNullStreams | null;
  close: () => Promise<void>;
}

interface ReviewOutputEnvelope {
  type: "refinery-review-output";
  runId: string;
  step: string;
  status: "succeeded" | "failed";
  output?: Record<string, unknown>;
  rawOutput?: string;
  model?: Record<string, unknown>;
  providerMetadata?: unknown;
  promptVersion?: string;
  prompt?: unknown;
  topology?: ReviewTopology;
  phase?: string;
  error?: Record<string, unknown>;
}

interface SpecialistMessage {
  step: string;
  agent: string;
  status: "succeeded" | "failed";
  messageId: string;
  threadId: string;
  mentionNames: string[];
  textExcerpt: string;
  rawOutput: string | null;
  output: Record<string, unknown> | null;
  model: Record<string, unknown> | null;
  providerMetadata: unknown;
  promptVersion: string | null;
  prompt: unknown;
  topology: ReviewTopology;
  phase: string | null;
  error: Record<string, unknown> | null;
}

interface ReadinessSnapshot {
  at: string;
  agents: Array<{ name: string; readiness: string; status: unknown }>;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function defaultCoralReviewTimeoutMs(topology: ReviewTopology): number {
  return topology === "debate-critique" || topology === "sparse-blackboard"
    ? DEFAULT_DEBATE_CRITIQUE_WAIT_TIMEOUT_MS
    : DEFAULT_PIPELINE_WAIT_TIMEOUT_MS;
}

function compactText(text: string, max = MAX_EXCERPT_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3).trimEnd()}...`;
}

function buildConsoleUrl(apiUrl: string, pathname: string): string {
  try {
    const url = new URL(apiUrl);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${apiUrl.replace(/\/+$/, "")}${pathname}`;
  }
}

function resolveConfiguredModel(coral: CoralReviewRuntimeOptions): {
  provider: "coral";
  baseUrl: string;
  modelName: string;
  reasoningEffort: string;
  maxTokens: number;
  transport: "direct" | "coral-server-proxy";
  proxyProvider: string | null;
} {
  const modelCwd = coral.modelCwd ?? repoRoot;
  const localEnv = loadLocalEnv(modelCwd);
  const readConfig = (name: string): string | undefined => process.env[name] ?? localEnv[name];
  const modelName = resolveModelSelection({
    explicit: coral.modelName,
    home: coral.modelHome,
    cwd: modelCwd,
    env: process.env,
    localEnv,
  }).modelName;
  const llmProxy = coral.llmProxy ?? false;
  return {
    provider: "coral",
    baseUrl: coral.modelBaseUrl ?? readConfig("MODEL_BASE_URL") ?? readConfig("REFINERY_MODEL_BASE_URL") ?? refineryCoralModelDefaults.baseUrl,
    modelName,
    reasoningEffort: coral.reasoningEffort ?? readConfig("REASONING_EFFORT") ?? refineryCoralModelDefaults.reasoningEffort,
    maxTokens: parseModelMaxTokens(readConfig("MODEL_MAX_TOKENS") ?? readConfig("REFINERY_MODEL_MAX_TOKENS")),
    transport: llmProxy ? "coral-server-proxy" : "direct",
    proxyProvider: llmProxy
      ? coral.modelProxyProvider ?? readConfig("REFINERY_MODEL_PROXY_PROVIDER") ?? defaultCoralProxyProvider(modelName)
      : null,
  };
}

export function buildReviewIntake(args: {
  runId: string;
  packet: ReviewPacket;
  intent: ReviewIntent;
  request: string | null;
  topology: ReviewTopology;
  runtimeProjection?: CoralCommunicationProjection;
}): Record<string, unknown> {
  return {
    schemaVersion: refineryReviewSchemaVersion,
    type: "refinery-review-intake",
    runId: args.runId,
    project: args.packet.objective.project,
    sourceSets: args.packet.sourceSets,
    targets: args.packet.targets,
    scope: args.packet.objective.scope,
    intent: args.intent,
    request: args.request,
    intentDescription: describeReviewIntent(args.intent),
    review_packet: args.packet,
    noApply: true,
    dryRun: true,
    topology: args.topology,
    coral_runtime_projection: args.runtimeProjection ?? null,
    phase: args.topology === "sparse-blackboard"
      ? "topic-intake"
      : args.topology === "debate-critique" ? "proposal-intake" : "pipeline",
    sourceLimit: args.packet.limits.sourceLimit,
    sourceCharLimit: args.packet.limits.sourceCharLimit,
    source_chunks: args.packet.derivedViews.source_chunks,
    active_memory_hints: args.packet.derivedViews.active_memory_hints,
    responsibility_plan: args.packet.derivedViews.responsibility_plan ?? null,
    graph_context: args.packet.derivedViews.graph_context ?? [],
    target_surfaces: args.packet.targets,
    source_sets: args.packet.sourceSets,
    proposal_schema: {
      schemaVersion: refineryReviewSchemaVersion,
      lifecycle: "proposed",
      writesAttempted: false,
      actions: memoryMaintenanceActions,
      intentFields: [
        "staleness_reason",
        "forget_reason",
        "update_reason",
        "conflict_reason",
        "scope_reason",
        "replacement_body",
        "ambiguities",
      ],
    },
    instruction: [
      "Coordinate over this intake and emit proposal-shaped outputs only.",
      `Review intent: ${args.intent}. ${describeReviewIntent(args.intent)}`,
      args.request ? `User request: ${args.request}` : "No additional user request.",
      `Target surfaces: ${args.packet.targets.join(", ")}.`,
      "Do not activate, approve, or write memory.",
      args.topology === "sparse-blackboard"
        ? "Use app-owned sparse topic routing: Claim Scout wakes first per awake responsibility unit; every other specialist remains at wait_for_mention until a deterministic routing condition wakes it."
        : args.topology === "debate-critique"
        ? "Use debate/critique topology: proposal work and critique work happen in separate Coral threads before final synthesis."
        : "Use the default pipeline topology.",
    ].join(" "),
  };
}

function parseReviewOutput(text: string): ReviewOutputEnvelope | null {
  try {
    const parsed = JSON.parse(text) as Partial<ReviewOutputEnvelope>;
    const status = parsed?.status === "failed" ? "failed" : "succeeded";
    if (
      parsed?.type !== "refinery-review-output" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.step !== "string" ||
      !reviewStepOrder.includes(parsed.step) ||
      (status === "succeeded" &&
        (!parsed.output || typeof parsed.output !== "object" || Array.isArray(parsed.output))) ||
      (status === "failed" &&
        (!parsed.error || typeof parsed.error !== "object" || Array.isArray(parsed.error)))
    ) {
      return null;
    }
    return {
      ...parsed,
      status,
    } as ReviewOutputEnvelope;
  } catch {
    return null;
  }
}

function collectSpecialistMessages(messages: CoralMessage[], threadIds: string[], runId: string): SpecialistMessage[] {
  const allowedThreadIds = new Set(threadIds);
  return messages
    .filter((message) => allowedThreadIds.has(message.threadId))
    .map((message) => ({ message, envelope: parseReviewOutput(message.text) }))
    .filter((item): item is { message: CoralMessage; envelope: ReviewOutputEnvelope } =>
      item.envelope !== null && item.envelope.runId === runId
    )
    .map(({ message, envelope }) => ({
      step: envelope.step,
      agent: message.senderName,
      status: envelope.status,
      messageId: message.id,
      threadId: message.threadId,
      mentionNames: message.mentionNames ?? [],
      textExcerpt: compactText(message.text),
      rawOutput: typeof envelope.rawOutput === "string" ? envelope.rawOutput : null,
      output: envelope.output ?? null,
      model: envelope.model && typeof envelope.model === "object" && !Array.isArray(envelope.model)
        ? envelope.model
        : null,
      providerMetadata: envelope.providerMetadata ?? null,
      promptVersion: typeof envelope.promptVersion === "string" ? envelope.promptVersion : null,
      prompt: envelope.prompt ?? null,
      topology: envelope.topology ?? defaultReviewTopology,
      phase: typeof envelope.phase === "string" ? envelope.phase : null,
      error: envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
        ? envelope.error
        : null,
    }))
    .sort((left, right) => reviewStepOrder.indexOf(left.step) - reviewStepOrder.indexOf(right.step));
}

function usageNumber(record: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function summarizeCoralUsage(messages: SpecialistMessage[]): CoralUsageSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let usageComplete = messages.length > 0;
  let status200Count = 0;
  let promptChars = 0;
  for (const message of messages) {
    promptChars += message.prompt === null || message.prompt === undefined
      ? 0
      : JSON.stringify(message.prompt).length;
    const metadata = message.providerMetadata && typeof message.providerMetadata === "object" && !Array.isArray(message.providerMetadata)
      ? message.providerMetadata as Record<string, unknown>
      : null;
    if (metadata?.status === 200) status200Count += 1;
    const usage = metadata?.usage && typeof metadata.usage === "object" && !Array.isArray(metadata.usage)
      ? metadata.usage as Record<string, unknown>
      : null;
    if (!usage) {
      usageComplete = false;
      continue;
    }
    const prompt = usageNumber(usage, ["prompt_tokens", "input_tokens"]);
    const completion = usageNumber(usage, ["completion_tokens", "output_tokens"]);
    const total = usageNumber(usage, ["total_tokens"]);
    if (prompt === null || completion === null) {
      usageComplete = false;
      continue;
    }
    promptTokens += prompt;
    completionTokens += completion;
    totalTokens += total ?? prompt + completion;
  }
  return {
    callCount: messages.length,
    status200Count,
    promptTokens: usageComplete ? promptTokens : null,
    completionTokens: usageComplete ? completionTokens : null,
    totalTokens: usageComplete ? totalTokens : null,
    promptChars,
    usageComplete,
  };
}

function debatePriority(message: SpecialistMessage): number {
  if (message.step === "decision-synthesizer" && message.phase === "proposal-synthesis") return 3;
  if (message.phase === "pipeline") return 2;
  if (!message.phase) return 1;
  return 0;
}

function outputMap(messages: SpecialistMessage[], topology: ReviewTopology = defaultReviewTopology): Map<string, SpecialistMessage> {
  const byStep = new Map<string, SpecialistMessage>();
  for (const message of messages) {
    if (message.status !== "succeeded" || !message.output) continue;
    if (topology !== "debate-critique" && !byStep.has(message.step)) {
      byStep.set(message.step, message);
      continue;
    }
    const current = byStep.get(message.step);
    if (!current || debatePriority(message) >= debatePriority(current)) {
      byStep.set(message.step, message);
    }
  }
  return byStep;
}

function normalizeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return `memory:${value}`;
  if (typeof value === "string") return value;
  throw new Error("target_memory_id must be string, number, or null.");
}

function normalizeIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((item) => {
    const normalized = normalizeId(item);
    if (!normalized) throw new Error("target_memory_id array must not contain null values.");
    return normalized;
  });
  const normalized = normalizeId(value);
  return normalized ? [normalized] : [];
}

function parseAction(value: unknown): MemoryMaintenanceAction {
  if (!memoryMaintenanceActions.includes(value as MemoryMaintenanceAction)) {
    throw new Error(`Invalid proposal action: ${String(value)}`);
  }
  return value as MemoryMaintenanceAction;
}

function asRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    return item as Record<string, unknown>;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error(`${field} must be a number from 0 to 1.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in record)) return undefined;
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be string or null when present.`);
  return value;
}

function optionalStringArray(record: Record<string, unknown>, field: string): string[] | undefined {
  if (!(field in record)) return undefined;
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings when present.`);
  }
  return value;
}

function parseDecisionSynthesizerOutput(runId: string, output: Record<string, unknown>): {
  proposals: MemoryProposal[];
  rejected: ReviewRejected[];
  skillCandidates: SkillCandidateArtifact;
} {
  const proposalRows = asRecords(output.proposals, "decision-synthesizer.proposals");
  const rejectedRows = asRecords(output.rejected ?? [], "decision-synthesizer.rejected");
  return {
    proposals: proposalRows.map((row, index) => {
      const targetMemoryIds = normalizeIds(row.target_memory_ids ?? row.target_memory_id);
      return {
        schemaVersion: refineryReviewSchemaVersion,
        id: `proposal:${runId}:${index + 1}`,
        action: parseAction(row.action),
        lifecycle: "proposed",
        intent: typeof row.intent === "string" ? row.intent : undefined,
        memoryType: requiredString(row, "memory_type"),
        scope: requiredString(row, "proposed_scope"),
        body: requiredString(row, "body"),
        confidence: requiredNumber(row, "confidence"),
        rationale: requiredString(row, "rationale"),
        sourceRefs: Array.isArray(row.source_refs) ? row.source_refs : [],
        targetMemoryId: targetMemoryIds[0] ?? null,
        ...(targetMemoryIds.length > 1 ? { targetMemoryIds } : {}),
        ...(optionalString(row, "staleness_reason") !== undefined ? { stalenessReason: optionalString(row, "staleness_reason") } : {}),
        ...(optionalString(row, "forget_reason") !== undefined ? { forgetReason: optionalString(row, "forget_reason") } : {}),
        ...(optionalString(row, "update_reason") !== undefined ? { updateReason: optionalString(row, "update_reason") } : {}),
        ...(optionalString(row, "conflict_reason") !== undefined ? { conflictReason: optionalString(row, "conflict_reason") } : {}),
        ...(optionalString(row, "scope_reason") !== undefined ? { scopeReason: optionalString(row, "scope_reason") } : {}),
        ...(optionalString(row, "replacement_body") !== undefined ? { replacementBody: optionalString(row, "replacement_body") } : {}),
        ...(optionalStringArray(row, "ambiguities") !== undefined ? { ambiguities: optionalStringArray(row, "ambiguities") } : {}),
      };
    }),
    rejected: rejectedRows.map((row, index) => ({
      sourceId: typeof row.source_id === "string" ? row.source_id : `rejected:${runId}:${index + 1}`,
      reason: typeof row.reason === "string" && row.reason.trim()
        ? row.reason
        : typeof row.rationale === "string" && row.rationale.trim()
          ? row.rationale
        : typeof row.type_rationale === "string" && row.type_rationale.trim()
          ? row.type_rationale
          : requiredString(row, "update_reason"),
    })),
    skillCandidates: parseSkillCandidateArtifact(runId, output),
  };
}

function sourceReferenceTokens(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim();
    const embeddedIds = normalized.match(/(?:graph-node|graph-revision|responsibility-unit|source-doc):[A-Za-z0-9._-]+/g) ?? [];
    return [...new Set([normalized, ...embeddedIds])];
  }
  if (!isRecord(value)) return [];
  const identityKeys = [
    "source_id",
    "sourceId",
    "graph_node_id",
    "graphNodeId",
    "source_uri",
    "sourceUri",
    "uri",
  ];
  return identityKeys.flatMap((key) => {
    const candidate = value[key];
    return sourceReferenceTokens(candidate);
  });
}

function isControlMetadataReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.ref_type === "payload_field") return true;
  const ref = typeof value.ref === "string" ? value.ref : "";
  return /^(responsibility_plan|graph_context|coral_runtime_projection|coral_thread_context)(\.|$)/.test(ref);
}

function referencesOverlap(left: unknown, right: unknown): boolean {
  const rightTokens = new Set(sourceReferenceTokens(right));
  return sourceReferenceTokens(left).some((token) => rightTokens.has(token));
}

export function validateCoralDecisionContract(args: {
  sourceChunks: unknown[];
  typedCandidates: unknown[];
  proposals: Array<{ action: string; sourceRefs: unknown[] }>;
}): void {
  if (args.proposals.length === 0) return;
  const typedCandidates = args.typedCandidates.filter(isRecord);
  if (typedCandidates.length === 0) {
    throw new RefineryError(
      "CORAL_DECISION_CONTRACT_VIOLATION",
      "Decision Synthesizer emitted a memory proposal when Proposal Editor emitted no typed candidates.",
      { phase: "coral", details: { reason: "proposal-without-typed-candidate" } },
    );
  }

  const allowedSourceTokens = new Set<string>();
  for (const chunk of args.sourceChunks) {
    if (!isRecord(chunk)) continue;
    for (const token of sourceReferenceTokens(chunk.id)) allowedSourceTokens.add(token);
    for (const token of sourceReferenceTokens(chunk.uri)) allowedSourceTokens.add(token);
    if (Array.isArray(chunk.refs)) {
      for (const ref of chunk.refs) {
        for (const token of sourceReferenceTokens(ref)) allowedSourceTokens.add(token);
      }
    }
  }

  args.proposals.forEach((proposal, proposalIndex) => {
    if (proposal.sourceRefs.length === 0) {
      throw new RefineryError(
        "CORAL_DECISION_CONTRACT_VIOLATION",
        `Decision proposal ${proposalIndex + 1} has no source references.`,
        { phase: "coral", details: { reason: "proposal-without-source-reference", proposalIndex } },
      );
    }
    const inadmissible = proposal.sourceRefs.find((ref) => {
      if (isControlMetadataReference(ref)) return true;
      const tokens = sourceReferenceTokens(ref);
      return tokens.length === 0 || !tokens.some((token) => allowedSourceTokens.has(token));
    });
    if (inadmissible !== undefined) {
      throw new RefineryError(
        "CORAL_DECISION_CONTRACT_VIOLATION",
        `Decision proposal ${proposalIndex + 1} cites control metadata or a reference outside the selected source chunks.`,
        { phase: "coral", details: { reason: "inadmissible-source-reference", proposalIndex } },
      );
    }

    const matchesTypedCandidate = typedCandidates.some((typed) => {
      if (typed.action !== proposal.action) return false;
      const typedRefs = Array.isArray(typed.source_refs) ? typed.source_refs : [];
      return proposal.sourceRefs.every((proposalRef) => typedRefs.some((typedRef) => referencesOverlap(proposalRef, typedRef)));
    });
    if (!matchesTypedCandidate) {
      throw new RefineryError(
        "CORAL_DECISION_CONTRACT_VIOLATION",
        `Decision proposal ${proposalIndex + 1} was not derived from a typed candidate with the same action and evidence.`,
        { phase: "coral", details: { reason: "proposal-not-derived-from-typed-candidate", proposalIndex } },
      );
    }
  });
}

function skillBundle(output: Record<string, unknown>): Record<string, unknown> {
  const camel = output.skillCandidates;
  const snake = output.skill_candidates;
  if (isRecord(camel)) return camel;
  if (isRecord(snake)) return snake;
  return {};
}

function skillRows(output: Record<string, unknown>, camel: string, snake: string): Record<string, unknown>[] {
  const bundle = skillBundle(output);
  const bundled = bundle[camel] ?? bundle[snake];
  const direct = output[`skill${camel[0].toUpperCase()}${camel.slice(1)}`] ?? output[`skill_${snake}`];
  const value = bundled ?? direct ?? [];
  return asRecords(value, `decision-synthesizer.${camel}`);
}

function stringArrayFrom(record: Record<string, unknown>, camel: string, snake: string): string[] {
  const value = record[camel] ?? record[snake];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [];
}

function refsFrom(record: Record<string, unknown>, camel: string, snake: string): unknown[] {
  const value = record[camel] ?? record[snake];
  return Array.isArray(value) ? value : [];
}

function parseSkillCandidateArtifact(runId: string, output: Record<string, unknown>): SkillCandidateArtifact {
  const candidateRows = skillRows(output, "candidates", "candidates");
  const rejectedRows = skillRows(output, "rejected", "rejected");
  const unresolvedRows = skillRows(output, "unresolved", "unresolved");
  return {
    candidates: candidateRows.map((row) => ({
      name: requiredString(row, "name"),
      trigger: requiredString(row, "trigger"),
      evidenceRefs: refsFrom(row, "evidenceRefs", "evidence_refs"),
      existingSkillRefs: refsFrom(row, "existingSkillRefs", "existing_skill_refs"),
      skillMdOutline: stringArrayFrom(row, "skillMdOutline", "skill_md_outline"),
      skillMdDraft: String(row.skillMdDraft ?? row.skill_md_draft ?? row["SKILL.md"] ?? ""),
      rationale: requiredString(row, "rationale"),
      confidence: requiredNumber(row, "confidence"),
    })),
    rejected: rejectedRows.map((row, index): SkillCandidateRejection => ({
      sourceId: typeof row.sourceId === "string"
        ? row.sourceId
        : typeof row.source_id === "string"
          ? row.source_id
          : `skill-rejected:${runId}:${index + 1}`,
      reason: typeof row.reason === "string" && row.reason.trim() ? row.reason : requiredString(row, "rationale"),
    })),
    unresolved: unresolvedRows.map((row, index): SkillCandidateUnresolved => ({
      sourceId: typeof row.sourceId === "string"
        ? row.sourceId
        : typeof row.source_id === "string"
          ? row.source_id
          : `skill-unresolved:${runId}:${index + 1}`,
      question: typeof row.question === "string" && row.question.trim() ? row.question : requiredString(row, "reason"),
      evidenceRefs: refsFrom(row, "evidenceRefs", "evidence_refs"),
    })),
  };
}

export function redactCoralLogText(text: string, secrets: string[] = []): string {
  let redacted = text.replace(/(\/llm-proxy\/)[^/\s"']+/g, "$1__redacted__");
  for (const secret of secrets.filter((value) => value.length >= 8)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.replaceAll(encoded, "[REDACTED]");
  }
  return redacted;
}

function appendLogLines(store: string[], prefix: string, chunk: Buffer, secrets: string[] = []): void {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) store.push(`[${prefix}] ${redactCoralLogText(line, secrets)}`);
  while (store.length > 500) store.shift();
}

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a loopback port for Coral"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function isServerReady(apiUrl: string, authKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/registry`, {
      headers: { Authorization: `Bearer ${authKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(apiUrl: string, authKey: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerReady(apiUrl, authKey)) return true;
    await sleep(1_000);
  }
  return false;
}

function startCoralServer(args: {
  configPath: string;
  coralRuntimeJar?: string;
  coralJar?: string;
  secretEnv?: Record<string, string>;
  logSecrets?: string[];
  logs: string[];
}): ChildProcessWithoutNullStreams {
  const configAbs = path.isAbsolute(args.configPath) ? args.configPath : path.resolve(repoRoot, args.configPath);
  const managedJar = args.coralRuntimeJar ?? coralRuntimeJarPath();
  const selectedJar = args.coralJar ? path.resolve(args.coralJar) : managedJar;
  if (!selectedJar || !fs.existsSync(selectedJar)) {
    throw new RefineryError(
      "CORAL_RUNTIME_NOT_PROVISIONED",
      "The latest-stable Coral Server runtime is not provisioned. Run `refinery setup provision coral --confirm --json` before live review.",
      { phase: "coral-runtime", details: { jarPath: selectedJar } },
    );
  }
  if (!args.coralJar && !verifyCoralRuntimeJarPath(selectedJar)) {
    throw new RefineryError(
      "CORAL_RUNTIME_INTEGRITY_FAILED",
      "The managed Coral Server JAR no longer matches its active release provenance. Re-run `refinery setup provision coral --confirm --json`.",
      { phase: "coral-runtime", details: { jarPath: selectedJar } },
    );
  }
  const command = process.env.REFINERY_JAVA_BIN ?? "java";
  const commandArgs = ["-jar", selectedJar];
  const logSecrets = [refineryCoralAuthKey, ...(args.logSecrets ?? []), ...Object.values(args.secretEnv ?? {})];
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.CORAL_API_KEY;
  delete inheritedEnv.DEEPSEEK_API_KEY;
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: {
      ...inheritedEnv,
      ...args.secretEnv,
      CONFIG_FILE_PATH: configAbs,
      REFINERY_NODE_BIN: process.execPath,
      PATH: process.env.PATH,
    },
  });
  child.stdout.on("data", (chunk: Buffer) => appendLogLines(args.logs, "coral:stdout", chunk, logSecrets));
  child.stderr.on("data", (chunk: Buffer) => appendLogLines(args.logs, "coral:stderr", chunk, logSecrets));
  child.on("exit", (code, signal) => args.logs.push(`[coral:exit] code=${code ?? "null"} signal=${signal ?? "null"}`));
  return child;
}

interface RuntimeCoralConfigOptions {
  modernAgents?: boolean;
  coralCloudProxy?: boolean;
  deepSeekProxy?: boolean;
  port?: number;
  authKey?: string;
}

function defaultRuntimeCoralConfig(options: RuntimeCoralConfigOptions = {}): string {
  const lines = [
    "[network]",
    'bind_address = "127.0.0.1"',
    'external_address = "127.0.0.1"',
    `bind_port = ${options.port ?? refineryCoralPort}`,
    "allow_any_host = false",
    "",
    "[auth]",
    `keys = [${JSON.stringify(options.authKey ?? refineryCoralAuthKey)}]`,
    "",
    "[registry]",
    "include_coral_home_agents = false",
    "include_debug_agents = false",
    "export_debug_agents = false",
    "watch_local_agents = true",
    'local_agent_rescan_timer = "10s"',
    `local_agents = [${JSON.stringify(options.modernAgents
      ? refineryCoralModernAgentGlobForRepo(repoRoot)
      : refineryCoralAgentGlobForRepo(repoRoot))}]`,
    "",
  ];
  if (options.coralCloudProxy) {
    lines.push(
      "[cloud]",
      'api_key = "${CORAL_API_KEY}"',
      "",
    );
  }
  if (options.deepSeekProxy) {
    lines.push(
      "[[llm-proxy.providers]]",
      `name = ${JSON.stringify(deepSeekProxyProvider)}`,
      'format = "OpenAI"',
      'models = ["deepseek-v4-pro"]',
      'api_key = "${DEEPSEEK_API_KEY}"',
      'base_url = "https://api.deepseek.com/"',
      "allow_any_model = false",
      "",
    );
  }
  return lines.join("\n");
}

export function resolveRuntimeCoralConfigPath(
  configPath: string,
  options: RuntimeCoralConfigOptions = {},
): string {
  if (configPath !== refineryCoralConfigPath) {
    return path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath);
  }
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-config-"));
  const runtimeConfigPath = path.join(configDir, "refinery-config.toml");
  if (process.platform !== "win32") fs.chmodSync(configDir, 0o700);
  fs.writeFileSync(runtimeConfigPath, defaultRuntimeCoralConfig(options), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(runtimeConfigPath, 0o600);
  return runtimeConfigPath;
}

export function cleanupRuntimeCoralConfigPath(configPath: string): void {
  const configDir = path.dirname(path.resolve(configPath));
  if (path.dirname(configDir) !== path.resolve(os.tmpdir())) return;
  if (!path.basename(configDir).startsWith("refinery-coral-config-")) return;
  fs.rmSync(configDir, { recursive: true, force: true });
}

function resolveCoralServerSecrets(coral: CoralReviewRuntimeOptions): { coralApiKey: string; deepSeekApiKey: string } {
  const cwd = coral.modelCwd ?? repoRoot;
  const localEnv = loadLocalEnv(cwd);
  const coralApiKey = resolveModelApiKey({ env: process.env, localEnv, home: coral.modelHome, cwd }).apiKey;
  return {
    coralApiKey,
    deepSeekApiKey: process.env.DEEPSEEK_API_KEY ?? localEnv.DEEPSEEK_API_KEY ?? "",
  };
}

export function selectCoralServerSecretEnv(
  model: {
    transport: "direct" | "coral-server-proxy";
    proxyProvider: string | null;
  },
  secrets: { coralApiKey: string; deepSeekApiKey: string },
): Record<string, string> {
  if (model.transport === "direct" || model.proxyProvider === coralCloudOpenAiProxyProvider) {
    return secrets.coralApiKey ? { CORAL_API_KEY: secrets.coralApiKey } : {};
  }
  if (model.proxyProvider === deepSeekProxyProvider) {
    return secrets.deepSeekApiKey ? { DEEPSEEK_API_KEY: secrets.deepSeekApiKey } : {};
  }
  return {};
}

async function stopStartedServer(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function recordReadinessSnapshot(target: ReadinessSnapshot[], snapshot: ExtendedState): void {
  target.push({
    at: new Date().toISOString(),
    agents: snapshot.agents
      .filter((agent) => refineryCoralAgentNames.includes(agent.name))
      .map((agent) => ({
        name: agent.name,
        readiness: classifyAgentReadiness(agent),
        status: agent.status ?? null,
      })),
  });
  if (target.length > 80) target.shift();
}

async function pollReviewOutputs(args: {
  apiUrl: string;
  authKey: string;
  session: SessionIdentifier;
  threadIds: string[];
  runId: string;
  timeoutMs: number;
  readinessSnapshots: ReadinessSnapshot[];
  topology?: ReviewTopology;
  complete?: (messages: SpecialistMessage[]) => boolean;
}): Promise<{ snapshot: ExtendedState | null; specialistMessages: SpecialistMessage[] }> {
  const deadline = Date.now() + args.timeoutMs;
  let lastSnapshot: ExtendedState | null = null;
  let lastMessages: SpecialistMessage[] = [];
  while (Date.now() < deadline) {
    const snapshot = await getExtended({ apiUrl: args.apiUrl, authKey: args.authKey }, args.session);
    lastSnapshot = snapshot;
    recordReadinessSnapshot(args.readinessSnapshots, snapshot);
    lastMessages = collectSpecialistMessages(allMessages(snapshot), args.threadIds, args.runId);
    if (lastMessages.some((message) => message.status === "failed")) {
      return { snapshot, specialistMessages: lastMessages };
    }
    const byStep = outputMap(lastMessages, args.topology);
    const complete = args.complete ?? (() => reviewStepOrder.every((step) => byStep.has(step)));
    if (complete(lastMessages)) {
      return { snapshot, specialistMessages: lastMessages };
    }
    const stopped = snapshot.agents
      .filter((agent) => refineryCoralAgentNames.includes(agent.name))
      .filter((agent) => classifyAgentReadiness(agent) === "stopped");
    if (stopped.length > 0) break;
    await sleep(DEFAULT_WAIT_INTERVAL_MS);
  }
  return { snapshot: lastSnapshot, specialistMessages: lastMessages };
}

function findMessage(args: {
  messages: SpecialistMessage[];
  step: string;
  threadId?: string;
  phase?: string;
}): SpecialistMessage | null {
  return args.messages.find((message) =>
    message.status === "succeeded" &&
    message.output &&
    message.step === args.step &&
    (args.threadId ? message.threadId === args.threadId : true) &&
    (args.phase ? message.phase === args.phase : true)
  ) ?? null;
}

function debateBranchesComplete(messages: SpecialistMessage[], proposalThreadId: string, critiqueThreadId: string): boolean {
  return Boolean(
    findMessage({ messages, step: "claim-scout", threadId: proposalThreadId, phase: "candidate-proposal" }) &&
    findMessage({ messages, step: "memory-cartographer", threadId: proposalThreadId, phase: "memory-cartography" }) &&
    findMessage({ messages, step: "proposal-editor", threadId: proposalThreadId, phase: "typed-proposal" }) &&
    findMessage({ messages, step: "evidence-auditor", threadId: critiqueThreadId, phase: "preflight-critique" })
  );
}

function debateFinalComplete(messages: SpecialistMessage[], proposalThreadId: string, critiqueThreadId: string): boolean {
  return debateBranchesComplete(messages, proposalThreadId, critiqueThreadId) &&
    Boolean(
      findMessage({ messages, step: "decision-synthesizer", threadId: proposalThreadId, phase: "proposal-synthesis" })
    );
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function topicIntake(args: {
  intake: Record<string, unknown>;
  topic: SparseTopic;
  packet: ReviewPacket;
}): Record<string, unknown> {
  const chunks = recordArray(args.packet.derivedViews.source_chunks);
  const selectedIds = new Set(args.topic.sourceChunkIds);
  const selectedChunks = chunks.filter((chunk) => typeof chunk.id === "string" && selectedIds.has(chunk.id));
  const selectedContext = args.packet.graph?.context.filter((context) => (
    context.responsibilityUnitId === args.topic.responsibilityUnitId
  )) ?? [];
  const { review_packet: _reviewPacket, source_chunks: _sourceChunks, graph_context: _graphContext, ...boundedIntake } = args.intake;
  return {
    ...boundedIntake,
    phase: "topic-intake",
    topic: args.topic,
    source_chunks: selectedChunks,
    graph_context: selectedContext,
    context: {
      source_chunks: selectedChunks,
      active_memory_hints: args.packet.derivedViews.active_memory_hints,
      responsibility_plan: args.packet.derivedViews.responsibility_plan ?? null,
      graph_context: selectedContext,
      target_surfaces: args.packet.targets,
      source_sets: args.packet.sourceSets,
      review_intent: args.packet.objective.intent,
      review_request: args.packet.objective.request,
    },
  };
}

async function executeSparseBlackboardReview(args: {
  apiUrl: string;
  authKey: string;
  session: SessionIdentifier;
  runId: string;
  packet: ReviewPacket;
  intake: Record<string, unknown>;
  timeoutMs: number;
  readinessSnapshots: ReadinessSnapshot[];
  suppliedThreadId?: string;
}): Promise<{
  blackboard: SparseBlackboard;
  threadId: string;
  threadIds: string[];
  snapshot: ExtendedState | null;
  messages: SpecialistMessage[];
  threadCreated: boolean;
}> {
  const blackboard = createSparseBlackboard(args.runId, args.packet);
  const awakeTopics = blackboard.topics.filter((topic) => topic.state === "awake");
  const topics = awakeTopics.length > 0 ? awakeTopics : blackboard.topics.slice(0, 1);
  const topicThreads: Array<{ topic: SparseTopic; threadId: string }> = [];
  let threadCreated = false;
  let scoutSnapshot: ExtendedState | null = null;
  let scoutMessages: SpecialistMessage[] = [];
  for (let index = 0; index < topics.length; index += 1) {
    const topic = topics[index]!;
    let threadId: string;
    if (index === 0 && args.suppliedThreadId) {
      threadId = args.suppliedThreadId;
    } else {
      const created = await puppetCreateThread(
        { apiUrl: args.apiUrl, authKey: args.authKey },
        args.session,
        "refinery-claim-scout",
        {
          threadName: `Refinery ${args.runId} topic ${index + 1}`,
          participantNames: refineryCoralAgentNames,
        },
      );
      threadId = created.thread.id;
      threadCreated = true;
    }
    topicThreads.push({ topic, threadId });
    await puppetSendMessage(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      args.session,
      "refinery-evidence-auditor",
      {
        threadId,
        content: JSON.stringify(topicIntake({ intake: args.intake, topic, packet: args.packet })),
        mentions: ["refinery-claim-scout"],
      },
    );
    blackboard.wakeSequence.push(`claim-scout:${topic.id}`);
    blackboard.modelCalls += 1;
    const topicPoll = await pollReviewOutputs({
      apiUrl: args.apiUrl,
      authKey: args.authKey,
      session: args.session,
      threadIds: [threadId],
      runId: args.runId,
      timeoutMs: args.timeoutMs,
      readinessSnapshots: args.readinessSnapshots,
      topology: "sparse-blackboard",
      complete: (messages) => Boolean(findMessage({
        messages,
        step: "claim-scout",
        threadId,
        phase: "topic-claim",
      })),
    });
    scoutSnapshot = topicPoll.snapshot;
    scoutMessages = [...scoutMessages, ...topicPoll.specialistMessages];
    if (topicPoll.specialistMessages.some((message) => message.status === "failed")) break;
  }
  const threadIds = topicThreads.map((topic) => topic.threadId);
  let polled = { snapshot: scoutSnapshot, specialistMessages: scoutMessages };
  const failedScout = polled.specialistMessages.find((message) => message.status === "failed");
  if (failedScout) return {
    blackboard,
    threadId: threadIds[0]!,
    threadIds,
    snapshot: polled.snapshot,
    messages: polled.specialistMessages,
    threadCreated,
  };
  blackboard.claims = topicThreads.flatMap((topic) => {
    const message = findMessage({
      messages: polled.specialistMessages,
      step: "claim-scout",
      threadId: topic.threadId,
      phase: "topic-claim",
    });
    return recordArray(message?.output?.candidates);
  });
  const activeMemories = recordArray(args.packet.derivedViews.active_memory_hints);
  blackboard.routing = routeSparseClaims({ candidates: blackboard.claims, activeMemories }).decision;
  if (blackboard.claims.length === 0) return {
    blackboard,
    threadId: threadIds[0]!,
    threadIds,
    snapshot: polled.snapshot,
    messages: polled.specialistMessages,
    threadCreated,
  };

  const synthesisThread = await puppetCreateThread(
    { apiUrl: args.apiUrl, authKey: args.authKey },
    args.session,
    "refinery-proposal-editor",
    {
      threadName: `Refinery ${args.runId} sparse blackboard`,
      participantNames: refineryCoralAgentNames,
    },
  );
  const synthesisThreadId = synthesisThread.thread.id;
  threadCreated = true;
  threadIds.push(synthesisThreadId);
  const allChunks = args.packet.derivedViews.source_chunks;
  const claimCards = claimCardsForCritique({ runId: args.runId, claimScoutOutput: { candidates: blackboard.claims } });
  const sharedContext = {
    source_chunks: allChunks,
    active_memory_hints: activeMemories,
    claim_candidates: blackboard.claims,
    claim_cards: claimCards,
    responsibility_plan: args.packet.derivedViews.responsibility_plan ?? null,
    graph_context: args.packet.derivedViews.graph_context ?? [],
    target_surfaces: args.packet.targets,
    source_sets: args.packet.sourceSets,
    review_intent: args.packet.objective.intent,
    review_request: args.packet.objective.request,
    topology: "sparse-blackboard",
  };

  if (blackboard.routing.wakeCartographer) {
    await puppetSendMessage(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      args.session,
      "refinery-claim-scout",
      {
        threadId: synthesisThreadId,
        content: JSON.stringify({
          ...args.intake,
          phase: "overlap-cartography-intake",
          context: sharedContext,
        }),
        mentions: ["refinery-memory-cartographer"],
      },
    );
    blackboard.wakeSequence.push("memory-cartographer:overlap");
    blackboard.modelCalls += 1;
    polled = await pollReviewOutputs({
      apiUrl: args.apiUrl,
      authKey: args.authKey,
      session: args.session,
      threadIds,
      runId: args.runId,
      timeoutMs: args.timeoutMs,
      readinessSnapshots: args.readinessSnapshots,
      topology: "sparse-blackboard",
      complete: (messages) => Boolean(findMessage({
        messages,
        step: "memory-cartographer",
        threadId: synthesisThreadId,
        phase: "overlap-cartography",
      })),
    });
    blackboard.cartographyFindings = recordArray(findMessage({
      messages: polled.specialistMessages,
      step: "memory-cartographer",
      threadId: synthesisThreadId,
      phase: "overlap-cartography",
    })?.output?.findings);
  }

  if (blackboard.routing.wakeAuditor) {
    await puppetSendMessage(
      { apiUrl: args.apiUrl, authKey: args.authKey },
      args.session,
      "refinery-claim-scout",
      {
        threadId: synthesisThreadId,
        content: JSON.stringify({
          ...args.intake,
          phase: "risk-audit-intake",
          claim_cards: claimCards,
          context: sharedContext,
        }),
        mentions: ["refinery-evidence-auditor"],
      },
    );
    blackboard.wakeSequence.push("evidence-auditor:risk");
    blackboard.modelCalls += 1;
    polled = await pollReviewOutputs({
      apiUrl: args.apiUrl,
      authKey: args.authKey,
      session: args.session,
      threadIds,
      runId: args.runId,
      timeoutMs: args.timeoutMs,
      readinessSnapshots: args.readinessSnapshots,
      topology: "sparse-blackboard",
      complete: (messages) => Boolean(findMessage({
        messages,
        step: "evidence-auditor",
        threadId: synthesisThreadId,
        phase: "risk-audit",
      })),
    });
    blackboard.auditFindings = recordArray(findMessage({
      messages: polled.specialistMessages,
      step: "evidence-auditor",
      threadId: synthesisThreadId,
      phase: "risk-audit",
    })?.output?.findings);
  }

  let routed = routeSparseClaims({
    candidates: blackboard.claims,
    activeMemories,
    cartographyFindings: blackboard.cartographyFindings,
    auditFindings: blackboard.auditFindings,
  });
  blackboard.routing = routed.decision;
  if (!blackboard.routing.wakeProposalEditor) return {
    blackboard,
    threadId: threadIds[0]!,
    threadIds,
    snapshot: polled.snapshot,
    messages: polled.specialistMessages,
    threadCreated,
  };

  await puppetSendMessage(
    { apiUrl: args.apiUrl, authKey: args.authKey },
    args.session,
    "refinery-evidence-auditor",
    {
      threadId: synthesisThreadId,
      content: JSON.stringify({
        schemaVersion: refineryReviewSchemaVersion,
        type: "refinery-review-intake",
        runId: args.runId,
        topology: "sparse-blackboard",
        phase: "survivor-proposal-intake",
        output: { findings: [...blackboard.cartographyFindings, ...blackboard.auditFindings] },
        context: { ...sharedContext, claim_candidates: routed.survivors },
      }),
      mentions: ["refinery-proposal-editor"],
    },
  );
  blackboard.wakeSequence.push("proposal-editor:survivors");
  blackboard.modelCalls += 1;
  polled = await pollReviewOutputs({
    apiUrl: args.apiUrl,
    authKey: args.authKey,
    session: args.session,
    threadIds,
    runId: args.runId,
    timeoutMs: args.timeoutMs,
    readinessSnapshots: args.readinessSnapshots,
    topology: "sparse-blackboard",
    complete: (messages) => Boolean(findMessage({
      messages,
      step: "proposal-editor",
      threadId: synthesisThreadId,
      phase: "survivor-proposal",
    })),
  });
  const proposalEditor = findMessage({
    messages: polled.specialistMessages,
    step: "proposal-editor",
    threadId: synthesisThreadId,
    phase: "survivor-proposal",
  });
  blackboard.typedCandidates = recordArray(proposalEditor?.output?.typed);
  routed = routeSparseClaims({
    candidates: blackboard.claims,
    activeMemories,
    cartographyFindings: blackboard.cartographyFindings,
    auditFindings: blackboard.auditFindings,
    typedCandidates: blackboard.typedCandidates,
  });
  blackboard.routing = routed.decision;
  if (!blackboard.routing.wakeDecisionSynthesizer) return {
    blackboard,
    threadId: threadIds[0]!,
    threadIds,
    snapshot: polled.snapshot,
    messages: polled.specialistMessages,
    threadCreated,
  };

  await puppetSendMessage(
    { apiUrl: args.apiUrl, authKey: args.authKey },
    args.session,
    "refinery-proposal-editor",
    {
      threadId: synthesisThreadId,
      content: JSON.stringify({
        schemaVersion: refineryReviewSchemaVersion,
        type: "refinery-review-merge",
        runId: args.runId,
        topology: "sparse-blackboard",
        phase: "candidate-synthesis-intake",
        proposal_editor_output: { typed: blackboard.typedCandidates },
        context: {
          ...sharedContext,
          claim_cards: claimCards,
          debate_critique: {
            topology: "sparse-blackboard",
            cartographyFindings: blackboard.cartographyFindings,
            auditFindings: blackboard.auditFindings,
            routing: blackboard.routing,
          },
        },
      }),
      mentions: ["refinery-decision-synthesizer"],
    },
  );
  blackboard.wakeSequence.push("decision-synthesizer:candidates");
  blackboard.modelCalls += 1;
  polled = await pollReviewOutputs({
    apiUrl: args.apiUrl,
    authKey: args.authKey,
    session: args.session,
    threadIds,
    runId: args.runId,
    timeoutMs: args.timeoutMs,
    readinessSnapshots: args.readinessSnapshots,
    topology: "sparse-blackboard",
    complete: (messages) => Boolean(findMessage({
      messages,
      step: "decision-synthesizer",
      threadId: synthesisThreadId,
      phase: "candidate-synthesis",
    })),
  });
  return {
    blackboard,
    threadId: threadIds[0]!,
    threadIds,
    snapshot: polled.snapshot,
    messages: polled.specialistMessages,
    threadCreated,
  };
}

function transcriptFromSnapshot(snapshot: ExtendedState | null, threadIds: string[]): unknown[] {
  if (!snapshot) return [];
  const allowedThreadIds = new Set(threadIds);
  return allMessages(snapshot)
    .filter((message) => allowedThreadIds.has(message.threadId))
    .map((message) => ({
      id: message.id,
      threadId: message.threadId,
      senderName: message.senderName,
      mentionNames: message.mentionNames ?? [],
      timestamp: message.timestamp ?? null,
      textExcerpt: compactText(message.text),
    }));
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "message";
}

function writeSpecialistMessageArtifacts(runDir: string, messages: SpecialistMessage[]): void {
  for (const message of messages) {
    const token = safeFileToken(`${message.phase ?? "unphased"}-${message.messageId}`);
    const messageDir = path.join(runDir, "steps", message.step, "messages", token);
    writeJson(path.join(messageDir, "message.json"), message);
    fs.writeFileSync(path.join(messageDir, "output.raw.md"), `${message.rawOutput ?? message.textExcerpt}\n`);
    if (message.output) writeJson(path.join(messageDir, "output.parsed.json"), message.output);
    if (message.error) writeJson(path.join(messageDir, "error.json"), message.error);
  }
}

function writeSpecialistStepArtifacts(
  runDir: string,
  messages: SpecialistMessage[],
  topology: ReviewTopology = defaultReviewTopology,
): void {
  writeSpecialistMessageArtifacts(runDir, messages);
  const canonical = Array.from(outputMap(messages, topology).values());
  for (const message of canonical) {
    const stepDir = path.join(runDir, "steps", message.step);
    writeJson(path.join(stepDir, "input.json"), {
      step: message.step,
      agent: message.agent,
      status: message.status,
      messageId: message.messageId,
      threadId: message.threadId,
      topology: message.topology,
      phase: message.phase,
      mentions: message.mentionNames,
      promptVersion: message.promptVersion,
      model: message.model,
      providerMetadata: message.providerMetadata,
      prompt: message.prompt,
    });
    fs.writeFileSync(path.join(stepDir, "output.raw.md"), `${message.rawOutput ?? message.textExcerpt}\n`);
    if (message.output) writeJson(path.join(stepDir, "output.parsed.json"), message.output);
    if (message.error) writeJson(path.join(stepDir, "error.json"), message.error);
  }
}

function toDeliberationMessages(messages: SpecialistMessage[]): DeliberationSpecialistMessage[] {
  return messages.map((message) => ({
    step: message.step,
    agent: message.agent,
    status: message.status,
    messageId: message.messageId,
    threadId: message.threadId,
    phase: message.phase,
    output: message.output,
  }));
}

function failedSpecialistError(args: {
  runDir: string;
  runId: string;
  message: SpecialistMessage;
}): RefineryError {
  const code = typeof args.message.error?.code === "string" ? args.message.error.code : "CORAL_SPECIALIST_FAILED";
  const message = typeof args.message.error?.message === "string" ? args.message.error.message : "Specialist returned a failed review envelope.";
  return new RefineryError(
    code,
    `Coral specialist ${args.message.step} failed: ${message}`,
    {
      phase: "coral",
      runId: args.runId,
      runDir: args.runDir,
      failedStep: args.message.step,
      rawOutputPath: path.join(args.runDir, "steps", args.message.step, "output.raw.md"),
      details: args.message.error ?? null,
    },
  );
}

export async function startCoralConsoleRun(options: CoralConsoleRunOptions): Promise<CoralConsoleRunSession> {
  const intent = options.packet.objective.intent as ReviewIntent;
  const request = options.packet.objective.request;
  const coral = options.coral ?? {};
  const topology = coral.topology ?? defaultReviewTopology;
  const startServer = coral.startServer ?? !coral.apiUrl;
  const serverMode = startServer ? "managed" : "attached";
  const namespace = coral.namespace ?? `refinery-${options.runId}`;
  const timeoutMs = coral.timeoutMs ?? defaultCoralReviewTimeoutMs(topology);
  const configuredModel = resolveConfiguredModel(coral);
  const coralJar = coral.coralJar ?? process.env.REFINERY_CORAL_SERVER_JAR;
  const serverSecrets = resolveCoralServerSecrets(coral);
  const selectedServerSecretEnv = selectCoralServerSecretEnv(configuredModel, serverSecrets);
  const requestedConfigPath = coral.configPath ?? refineryCoralConfigPath;
  const generatedDefaultConfig = startServer && requestedConfigPath === refineryCoralConfigPath;
  const managedPort = generatedDefaultConfig && !coral.apiUrl ? await reserveLoopbackPort() : refineryCoralPort;
  const apiUrl = coral.apiUrl ?? `http://127.0.0.1:${managedPort}`;
  const authKey = coral.authKey ?? (generatedDefaultConfig ? crypto.randomBytes(32).toString("base64url") : refineryCoralAuthKey);
  let configPath = path.isAbsolute(requestedConfigPath) ? requestedConfigPath : path.resolve(repoRoot, requestedConfigPath);
  let generatedConfigPath: string | null = null;
  const runtimeProjection = buildCoralCommunicationProjection(
    topology,
    options.packet.graph?.plan.responsibilityUnits ?? [],
  );
  const logs: string[] = [];
  const readinessSnapshots: ReadinessSnapshot[] = [];
  const seededMessages: CoralConsoleRunResult["seededMessages"] = [];
  let child: ChildProcessWithoutNullStreams | null = null;
  let session: SessionIdentifier | null = null;
  let sessionCreated = false;
  let closed = false;
  let runtimeCapabilities: CoralRuntimeCapabilities | null = null;

  const teardownRuntime = async (): Promise<void> => {
    try {
      if (session && sessionCreated && !coral.noTeardown) {
        await closeSession({ apiUrl, authKey }, session);
      }
    } finally {
      try {
        await stopStartedServer(child);
      } finally {
        if (generatedConfigPath) cleanupRuntimeCoralConfigPath(generatedConfigPath);
      }
    }
  };

  try {
    if (
      configuredModel.transport === "coral-server-proxy"
      && configuredModel.proxyProvider === deepSeekProxyProvider
      && startServer
      && !serverSecrets.deepSeekApiKey
    ) {
      throw new RefineryError(
        "CORAL_MODEL_PROVIDER_AUTH_MISSING",
        "DeepSeek V4 Pro requires DEEPSEEK_API_KEY for the self-hosted Coral proxy; the Coral Cloud key does not currently expose this model.",
        { phase: "coral", runId: options.runId, details: { modelName: configuredModel.modelName, proxyProvider: configuredModel.proxyProvider } },
      );
    }
    if (
      configuredModel.transport === "coral-server-proxy"
      && configuredModel.proxyProvider === coralCloudOpenAiProxyProvider
      && startServer
      && !serverSecrets.coralApiKey
    ) {
      throw new RefineryError(
        "CORAL_MODEL_PROVIDER_AUTH_MISSING",
        "Coral Cloud proxy mode requires CORAL_API_KEY or stored Coral auth.",
        { phase: "coral", runId: options.runId, details: { modelName: configuredModel.modelName, proxyProvider: configuredModel.proxyProvider } },
      );
    }
    if (startServer) {
      configPath = resolveRuntimeCoralConfigPath(requestedConfigPath, {
        modernAgents: configuredModel.transport === "coral-server-proxy",
        coralCloudProxy: configuredModel.transport === "coral-server-proxy"
          && configuredModel.proxyProvider === coralCloudOpenAiProxyProvider,
        deepSeekProxy: configuredModel.transport === "coral-server-proxy"
          && configuredModel.proxyProvider === deepSeekProxyProvider,
        port: managedPort,
        authKey,
      });
      if (requestedConfigPath === refineryCoralConfigPath) generatedConfigPath = configPath;
    }
    const intake = buildReviewIntake({
      runId: options.runId,
      packet: options.packet,
      intent,
      request,
      topology,
      runtimeProjection,
    });

    if (startServer && !(await isServerReady(apiUrl, authKey))) {
      child = startCoralServer({
        configPath,
        coralRuntimeJar: coral.coralRuntimeJar,
        coralJar,
        secretEnv: selectedServerSecretEnv,
        logSecrets: [authKey],
        logs,
      });
    }
    if (!(await waitForServer(apiUrl, authKey, 60_000))) {
      throw new RefineryError(
        "CORAL_SERVER_UNREACHABLE",
        `Coral server was not reachable at ${apiUrl}.`,
        { phase: "coral", runId: options.runId },
      );
    }
    runtimeCapabilities = await inspectCoralRuntimeCapabilities(apiUrl);
    if (configuredModel.transport === "coral-server-proxy" && !runtimeCapabilities.graphAgentProxyOverrides) {
      throw new RefineryError(
        "CORAL_SERVER_PROXY_UNSUPPORTED",
        "The running Coral Server does not expose GraphAgentRequest.proxies; use Coral Server 1.4+ or disable --coral-llm-proxy.",
        { phase: "coral", runId: options.runId, details: runtimeCapabilities },
      );
    }

    const registry = [];
    for (const agentName of refineryCoralAgentNames) {
      try {
        await getLocalAgent({ apiUrl, authKey }, agentName);
        registry.push({ agentName, ok: true });
      } catch (error) {
        registry.push({ agentName, ok: false, error: (error as Error).message });
        throw new RefineryError(
          "CORAL_AGENT_REGISTRY_MISSING",
          `Coral registry missing ${agentName}: ${(error as Error).message}`,
          { phase: "coral", runId: options.runId, details: registry },
        );
      }
    }

    if (coral.sessionId) {
      session = { namespace, sessionId: coral.sessionId };
    } else {
      session = await createSession(
        { apiUrl, authKey },
        buildCoralSessionRequest({
          namespace,
          runId: options.runId,
          modelName: configuredModel.modelName,
          modelBaseUrl: configuredModel.baseUrl,
          reasoningEffort: configuredModel.reasoningEffort,
          maxTurns: coral.maxTurns ?? process.env.REFINERY_CORAL_MAX_TURNS ?? (topology === "sparse-blackboard"
            ? String(Math.max(4, runtimeProjection.attachments.filter((attachment) => attachment.responsibilityState === "awake").length + 4))
            : topology === "debate-critique" ? "3" : "2"),
          ttlMs: Math.max(timeoutMs + 60_000, 30 * 60_000),
          holdAfterExitMs: Math.max(timeoutMs + 60_000, 30 * 60_000),
          topology,
        }),
      );
      sessionCreated = true;
    }

    const ready = await waitForAgentsReady(
      { apiUrl, authKey },
      session,
      refineryCoralAgentNames,
      (snapshot) => recordReadinessSnapshot(readinessSnapshots, snapshot),
      { timeoutMs: 90_000, intervalMs: DEFAULT_WAIT_INTERVAL_MS },
    );
    if (!ready.ok) {
      throw new RefineryError(
        "CORAL_AGENTS_NOT_READY",
        `Agents did not reach readiness. stopped=${ready.stopped.join(",") || "none"}`,
        { phase: "coral", runId: options.runId, details: ready.snapshot },
      );
    }

    let threadId: string;
    let threadIds: string[];
    let proposalThreadId: string | undefined;
    let critiqueThreadId: string | undefined;

    const rememberSeed = (message: CoralMessage): void => {
      seededMessages.push({
        id: message.id,
        threadId: message.threadId,
        senderName: message.senderName,
        mentionNames: message.mentionNames ?? [],
        textExcerpt: compactText(message.text),
      });
    };

    if (topology === "sparse-blackboard") {
      const blackboard = createSparseBlackboard(options.runId, options.packet);
      const awakeTopics = blackboard.topics.filter((topic) => topic.state === "awake");
      const topics = awakeTopics.length > 0 ? awakeTopics : blackboard.topics.slice(0, 1);
      threadIds = [];
      for (let index = 0; index < topics.length; index += 1) {
        const topic = topics[index]!;
        let topicThreadId: string;
        if (index === 0 && coral.threadId) {
          topicThreadId = coral.threadId;
        } else {
          const created = await puppetCreateThread(
            { apiUrl, authKey },
            session,
            "refinery-claim-scout",
            {
              threadName: `Refinery console ${options.runId} topic ${index + 1}`,
              participantNames: refineryCoralAgentNames,
            },
          );
          topicThreadId = created.thread.id;
        }
        threadIds.push(topicThreadId);
        const seed = await puppetSendMessage(
          { apiUrl, authKey },
          session,
          "refinery-evidence-auditor",
          {
            threadId: topicThreadId,
            content: JSON.stringify(topicIntake({ intake, topic, packet: options.packet })),
            mentions: ["refinery-claim-scout"],
          },
        );
        rememberSeed(seed.message);
      }
      threadId = threadIds[0]!;
    } else if (topology === "debate-critique") {
      if (coral.threadId) {
        proposalThreadId = coral.threadId;
      } else {
        const proposalThread = await puppetCreateThread(
          { apiUrl, authKey },
          session,
          "refinery-claim-scout",
          {
            threadName: `Refinery console ${options.runId} proposal`,
            participantNames: refineryCoralAgentNames,
          },
        );
        proposalThreadId = proposalThread.thread.id;
      }
      const critiqueThread = await puppetCreateThread(
        { apiUrl, authKey },
        session,
        "refinery-evidence-auditor",
        {
          threadName: `Refinery console ${options.runId} critique`,
          participantNames: refineryCoralAgentNames,
        },
      );
      critiqueThreadId = critiqueThread.thread.id;
      threadId = proposalThreadId;
      threadIds = [proposalThreadId, critiqueThreadId];

      const proposalSeed = await puppetSendMessage(
        { apiUrl, authKey },
        session,
        "refinery-evidence-auditor",
        {
          threadId: proposalThreadId,
          content: JSON.stringify({ ...intake, phase: "proposal-intake" }),
          mentions: ["refinery-claim-scout"],
        },
      );
      rememberSeed(proposalSeed.message);
      const critiqueSeed = await puppetSendMessage(
        { apiUrl, authKey },
        session,
        "refinery-claim-scout",
        {
          threadId: critiqueThreadId,
          content: JSON.stringify({ ...intake, phase: "critique-intake" }),
          mentions: ["refinery-evidence-auditor"],
        },
      );
      rememberSeed(critiqueSeed.message);
    } else {
      if (coral.threadId) {
        threadId = coral.threadId;
      } else {
        const thread = await puppetCreateThread(
          { apiUrl, authKey },
          session,
          "refinery-claim-scout",
          {
            threadName: `Refinery console ${options.runId}`,
            participantNames: refineryCoralAgentNames,
          },
        );
        threadId = thread.thread.id;
      }
      threadIds = [threadId];
      const seed = await puppetSendMessage(
        { apiUrl, authKey },
        session,
        "refinery-evidence-auditor",
        {
          threadId,
          content: JSON.stringify(intake),
          mentions: ["refinery-claim-scout"],
        },
      );
      rememberSeed(seed.message);
    }

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await teardownRuntime();
    };

    return {
      managedServerStarted: Boolean(child),
      managedProcess: child,
      close,
      result: {
        ok: true,
        schemaVersion: refineryReviewSchemaVersion,
        command: "console run",
        mode: "coral-console",
        sourceSets: options.packet.sourceSets,
        targets: options.packet.targets,
        project: options.packet.objective.project,
        scope: options.packet.objective.scope,
        dryRun: true,
        archive: false,
        artifactDir: null,
        writesAttempted: false,
        runId: options.runId,
        consoleUrl: buildConsoleUrl(apiUrl, "/ui/console"),
        schemaUrl: buildConsoleUrl(apiUrl, "/api_v1.json"),
        counts: {
          sourceSets: options.packet.counts.sourceSets,
          documents: options.packet.counts.documents,
          activeMemoryHints: options.packet.counts.activeMemoryHints,
          seededMessages: seededMessages.length,
        },
        coral: {
          apiUrl,
          namespace: session.namespace,
          sessionId: session.sessionId,
          threadId,
          threadIds,
          ...(proposalThreadId ? { proposalThreadId } : {}),
          ...(critiqueThreadId ? { critiqueThreadId } : {}),
          agents: refineryCoralAgentNames,
          topology,
          serverMode,
          managedServerStarted: Boolean(child),
          model: {
            name: configuredModel.modelName,
            transport: configuredModel.transport,
            proxyProvider: configuredModel.proxyProvider,
          },
          runtimeCapabilities: runtimeCapabilities!,
          runtimeProjection,
        },
        seededMessages,
        next: `Open ${buildConsoleUrl(apiUrl, "/ui/console")} and inspect namespace ${session.namespace}, session ${session.sessionId}.`,
      },
    };
  } catch (error) {
    await teardownRuntime().catch(() => {});
    throw applyErrorContext(asRefineryError(error, { code: "CORAL_CONSOLE_FAILED" }), {
      phase: "coral",
      runId: options.runId,
    });
  }
}

export async function runCoralReview(options: CoralReviewRunOptions): Promise<CoralReviewRunResult> {
  const runDir = path.join(options.outputDir, options.runId);
  const createdAt = new Date().toISOString();
  const intent = options.packet.objective.intent as ReviewIntent;
  const request = options.packet.objective.request;
  const coral = options.coral ?? {};
  const topology = coral.topology ?? defaultReviewTopology;
  const startServer = coral.startServer ?? !coral.apiUrl;
  const serverMode = startServer ? "managed" : "attached";
  const namespace = coral.namespace ?? `refinery-${options.runId}`;
  const timeoutMs = coral.timeoutMs ?? defaultCoralReviewTimeoutMs(topology);
  const configuredModel = resolveConfiguredModel(coral);
  const coralJar = coral.coralJar ?? process.env.REFINERY_CORAL_SERVER_JAR;
  const serverSecrets = resolveCoralServerSecrets(coral);
  const selectedServerSecretEnv = selectCoralServerSecretEnv(configuredModel, serverSecrets);
  const requestedConfigPath = coral.configPath ?? refineryCoralConfigPath;
  const generatedDefaultConfig = startServer && requestedConfigPath === refineryCoralConfigPath;
  const managedPort = generatedDefaultConfig && !coral.apiUrl ? await reserveLoopbackPort() : refineryCoralPort;
  const apiUrl = coral.apiUrl ?? `http://127.0.0.1:${managedPort}`;
  const authKey = coral.authKey ?? (generatedDefaultConfig ? crypto.randomBytes(32).toString("base64url") : refineryCoralAuthKey);
  let configPath = path.isAbsolute(requestedConfigPath) ? requestedConfigPath : path.resolve(repoRoot, requestedConfigPath);
  let generatedConfigPath: string | null = null;
  const runtimeProjection = buildCoralCommunicationProjection(
    topology,
    options.packet.graph?.plan.responsibilityUnits ?? [],
  );
  const logs: string[] = [];
  const readinessSnapshots: ReadinessSnapshot[] = [];
  let child: ChildProcessWithoutNullStreams | null = null;
  let session: SessionIdentifier | null = null;
  let threadId: string | null = null;
  let threadIds: string[] = [];
  let proposalThreadId: string | null = null;
  let critiqueThreadId: string | null = null;
  let sparseBlackboard: SparseBlackboard | null = null;
  let sessionCreated = false;
  let threadCreated = false;
  let finalSnapshot: ExtendedState | null = null;
  let specialistMessages: SpecialistMessage[] = [];
  let runtimeCapabilities: CoralRuntimeCapabilities | null = null;

  fs.mkdirSync(runDir, { recursive: true });
  try {
    if (
      configuredModel.transport === "coral-server-proxy"
      && configuredModel.proxyProvider === deepSeekProxyProvider
      && startServer
      && !serverSecrets.deepSeekApiKey
    ) {
      throw new RefineryError(
        "CORAL_MODEL_PROVIDER_AUTH_MISSING",
        "DeepSeek V4 Pro requires DEEPSEEK_API_KEY for the self-hosted Coral proxy; the Coral Cloud key does not currently expose this model.",
        { phase: "coral", runId: options.runId, runDir, details: { modelName: configuredModel.modelName, proxyProvider: configuredModel.proxyProvider } },
      );
    }
    if (
      configuredModel.transport === "coral-server-proxy"
      && configuredModel.proxyProvider === coralCloudOpenAiProxyProvider
      && startServer
      && !serverSecrets.coralApiKey
    ) {
      throw new RefineryError(
        "CORAL_MODEL_PROVIDER_AUTH_MISSING",
        "Coral Cloud proxy mode requires CORAL_API_KEY or stored Coral auth.",
        { phase: "coral", runId: options.runId, runDir, details: { modelName: configuredModel.modelName, proxyProvider: configuredModel.proxyProvider } },
      );
    }
    if (startServer) {
      configPath = resolveRuntimeCoralConfigPath(requestedConfigPath, {
        modernAgents: configuredModel.transport === "coral-server-proxy",
        coralCloudProxy: configuredModel.transport === "coral-server-proxy"
          && configuredModel.proxyProvider === coralCloudOpenAiProxyProvider,
        deepSeekProxy: configuredModel.transport === "coral-server-proxy"
          && configuredModel.proxyProvider === deepSeekProxyProvider,
        port: managedPort,
        authKey,
      });
      if (requestedConfigPath === refineryCoralConfigPath) generatedConfigPath = configPath;
    }
    const intake = buildReviewIntake({
      runId: options.runId,
      packet: options.packet,
      intent,
      request,
      topology,
      runtimeProjection,
    });
    writeJson(path.join(runDir, "input.json"), options.packet);
    if (options.packet.graph) {
      writeJson(path.join(runDir, "responsibility-plan.json"), options.packet.graph.plan);
      writeJson(path.join(runDir, "graph-context.json"), options.packet.graph.context);
    }
    writeJson(path.join(runDir, "source-counts.json"), {
      runId: options.runId,
      sourceSets: options.packet.sourceSets.map((sourceSet) => ({
        id: sourceSet.id,
        spec: sourceSet.spec,
        role: sourceSet.role,
        documents: options.packet.documents.filter((doc) => doc.sourceSet === sourceSet.id).length,
      })),
      counts: options.packet.counts,
      warnings: options.packet.warnings,
    });

    if (startServer && !(await isServerReady(apiUrl, authKey))) {
      child = startCoralServer({
        configPath,
        coralRuntimeJar: coral.coralRuntimeJar,
        coralJar,
        secretEnv: selectedServerSecretEnv,
        logSecrets: [authKey],
        logs,
      });
    }
    if (!(await waitForServer(apiUrl, authKey, 60_000))) {
      throw new RefineryError(
        "CORAL_SERVER_UNREACHABLE",
        `Coral server was not reachable at ${apiUrl}.`,
        { phase: "coral", runId: options.runId, runDir },
      );
    }
    runtimeCapabilities = await inspectCoralRuntimeCapabilities(apiUrl);
    if (configuredModel.transport === "coral-server-proxy" && !runtimeCapabilities.graphAgentProxyOverrides) {
      throw new RefineryError(
        "CORAL_SERVER_PROXY_UNSUPPORTED",
        "The running Coral Server does not expose GraphAgentRequest.proxies; use Coral Server 1.4+ or disable --coral-llm-proxy.",
        { phase: "coral", runId: options.runId, runDir, details: runtimeCapabilities },
      );
    }

    const registry = [];
    for (const agentName of refineryCoralAgentNames) {
      try {
        await getLocalAgent({ apiUrl, authKey }, agentName);
        registry.push({ agentName, ok: true });
      } catch (error) {
        registry.push({ agentName, ok: false, error: (error as Error).message });
        throw new RefineryError(
          "CORAL_AGENT_REGISTRY_MISSING",
          `Coral registry missing ${agentName}: ${(error as Error).message}`,
          { phase: "coral", runId: options.runId, runDir, details: registry },
        );
      }
    }

    if (coral.sessionId) {
      session = { namespace, sessionId: coral.sessionId };
    } else {
      session = await createSession(
        { apiUrl, authKey },
        buildCoralSessionRequest({
          namespace,
          runId: options.runId,
          modelName: configuredModel.modelName,
          modelBaseUrl: configuredModel.baseUrl,
          reasoningEffort: configuredModel.reasoningEffort,
          maxTurns: coral.maxTurns ?? process.env.REFINERY_CORAL_MAX_TURNS ?? (topology === "sparse-blackboard"
            ? String(Math.max(4, runtimeProjection.attachments.filter((attachment) => attachment.responsibilityState === "awake").length + 4))
            : topology === "debate-critique" ? "3" : "2"),
          ttlMs: Math.max(timeoutMs + 60_000, 180_000),
          holdAfterExitMs: Math.max(timeoutMs + 60_000, 180_000),
          topology,
          llmProxy: {
            enabled: configuredModel.transport === "coral-server-proxy",
            configurationName: configuredModel.proxyProvider ?? undefined,
          },
        }),
      );
      sessionCreated = true;
    }

    const ready = await waitForAgentsReady(
      { apiUrl, authKey },
      session,
      refineryCoralAgentNames,
      (snapshot) => recordReadinessSnapshot(readinessSnapshots, snapshot),
      { timeoutMs: 90_000, intervalMs: DEFAULT_WAIT_INTERVAL_MS },
    );
    if (!ready.ok) {
      throw new RefineryError(
        "CORAL_AGENTS_NOT_READY",
        `Agents did not reach readiness. stopped=${ready.stopped.join(",") || "none"}`,
        { phase: "coral", runId: options.runId, runDir, details: ready.snapshot },
      );
    }

    if (topology === "sparse-blackboard") {
      const sparse = await executeSparseBlackboardReview({
        apiUrl,
        authKey,
        session,
        runId: options.runId,
        packet: options.packet,
        intake,
        timeoutMs,
        readinessSnapshots,
        suppliedThreadId: coral.threadId,
      });
      sparseBlackboard = sparse.blackboard;
      threadId = sparse.threadId;
      threadIds = sparse.threadIds;
      finalSnapshot = sparse.snapshot;
      specialistMessages = sparse.messages;
      threadCreated = sparse.threadCreated;
      writeJson(path.join(runDir, "blackboard.json"), sparseBlackboard);
    } else if (topology === "debate-critique") {
      if (coral.threadId) {
        proposalThreadId = coral.threadId;
      } else {
        const proposalThread = await puppetCreateThread(
          { apiUrl, authKey },
          session,
          "refinery-claim-scout",
          {
            threadName: `Refinery review ${options.runId} proposal`,
            participantNames: refineryCoralAgentNames,
          },
        );
        proposalThreadId = proposalThread.thread.id;
        threadCreated = true;
      }
      threadId = proposalThreadId;
      threadIds = [proposalThreadId];

      await puppetSendMessage(
        { apiUrl, authKey },
        session,
        "refinery-evidence-auditor",
        {
          threadId: proposalThreadId,
          content: JSON.stringify({ ...intake, phase: "proposal-intake" }),
          mentions: ["refinery-claim-scout"],
        },
      );

      const claimScoutPoll = await pollReviewOutputs({
        apiUrl,
        authKey,
        session,
        threadIds,
        runId: options.runId,
        timeoutMs,
        readinessSnapshots,
        topology,
        complete: (messages) => Boolean(
          findMessage({ messages, step: "claim-scout", threadId: proposalThreadId!, phase: "candidate-proposal" }),
        ),
      });
      finalSnapshot = claimScoutPoll.snapshot;
      specialistMessages = claimScoutPoll.specialistMessages;
      const claimScoutFailure = specialistMessages.find((message) => message.status === "failed");
      if (claimScoutFailure) {
        writeSpecialistStepArtifacts(runDir, specialistMessages, topology);
        throw failedSpecialistError({ runDir, runId: options.runId, message: claimScoutFailure });
      }
      const claimScoutMessage = findMessage({
        messages: specialistMessages,
        step: "claim-scout",
        threadId: proposalThreadId,
        phase: "candidate-proposal",
      });
      if (!claimScoutMessage?.output) {
        throw new RefineryError(
          "CORAL_REVIEW_INCOMPLETE",
          "Debate/critique review did not emit claim scout candidates before claim critique.",
          { phase: "coral", runId: options.runId, runDir, details: { specialistMessages } },
        );
      }
      const claimCards = claimCardsForCritique({
        runId: options.runId,
        claimScoutOutput: claimScoutMessage.output,
      });

      const critiqueThread = await puppetCreateThread(
        { apiUrl, authKey },
        session,
        "refinery-evidence-auditor",
        {
          threadName: `Refinery review ${options.runId} claim critique`,
          participantNames: refineryCoralAgentNames,
        },
      );
      critiqueThreadId = critiqueThread.thread.id;
      threadCreated = true;
      threadIds = [proposalThreadId, critiqueThreadId];

      await puppetSendMessage(
        { apiUrl, authKey },
        session,
        "refinery-claim-scout",
        {
          threadId: critiqueThreadId,
          content: JSON.stringify({
            ...intake,
            phase: "critique-intake",
            claim_cards: claimCards,
            context: {
              source_chunks: options.packet.derivedViews.source_chunks,
              active_memory_hints: options.packet.derivedViews.active_memory_hints,
              responsibility_plan: options.packet.derivedViews.responsibility_plan ?? null,
              graph_context: options.packet.derivedViews.graph_context ?? [],
              review_intent: intent,
              review_request: request,
              intent_description: describeReviewIntent(intent),
              topology,
              phase: "critique-intake",
              claim_cards: claimCards,
            },
          }),
          mentions: ["refinery-evidence-auditor"],
        },
      );

      const branches = await pollReviewOutputs({
        apiUrl,
        authKey,
        session,
        threadIds,
        runId: options.runId,
        timeoutMs,
        readinessSnapshots,
        topology,
        complete: (messages) => debateBranchesComplete(messages, proposalThreadId!, critiqueThreadId!),
      });
      finalSnapshot = branches.snapshot;
      specialistMessages = branches.specialistMessages;
      const branchFailure = specialistMessages.find((message) => message.status === "failed");
      if (branchFailure) {
        writeSpecialistStepArtifacts(runDir, specialistMessages, topology);
        throw failedSpecialistError({ runDir, runId: options.runId, message: branchFailure });
      }
      if (!debateBranchesComplete(specialistMessages, proposalThreadId, critiqueThreadId)) {
        throw new RefineryError(
          "CORAL_REVIEW_INCOMPLETE",
          "Debate/critique branches did not emit required proposal and critique outputs before merge.",
          { phase: "coral", runId: options.runId, runDir, details: { specialistMessages } },
        );
      }

      const proposalEditorMessage = findMessage({
        messages: specialistMessages,
        step: "proposal-editor",
        threadId: proposalThreadId,
        phase: "typed-proposal",
      });
      const evidenceAudit = findMessage({
        messages: specialistMessages,
        step: "evidence-auditor",
        threadId: critiqueThreadId,
        phase: "preflight-critique",
      });
      if (!proposalEditorMessage?.output || !evidenceAudit?.output) {
        throw new RefineryError(
          "CORAL_REVIEW_INCOMPLETE",
          "Debate/critique merge inputs were missing after branch completion.",
          { phase: "coral", runId: options.runId, runDir, details: { proposalEditorMessage, evidenceAudit } },
        );
      }

      const branchDeliberation = buildDeliberationArtifacts({
        runId: options.runId,
        topology,
        messages: toDeliberationMessages(specialistMessages),
      });
      const critique = {
        topology,
        proposalThreadId,
        critiqueThreadId,
        claim_cards: branchDeliberation.claims.length > 0 ? branchDeliberation.claims : claimCards,
        challenge_ledger: branchDeliberation.challengeLedger,
        deliberation_trace: branchDeliberation.trace,
        evidenceAudit: evidenceAudit.output,
        evidenceMessages: [
          {
            step: evidenceAudit.step,
            phase: evidenceAudit.phase,
            agent: evidenceAudit.agent,
            messageId: evidenceAudit.messageId,
            threadId: evidenceAudit.threadId,
          },
        ],
      };
      const merge = {
        schemaVersion: refineryReviewSchemaVersion,
        type: "refinery-review-merge",
        topology,
        phase: "proposal-synthesis-intake",
        runId: options.runId,
        project: options.packet.objective.project,
        sourceSets: options.packet.sourceSets,
        targets: options.packet.targets,
        scope: options.packet.objective.scope,
        intent,
        request,
        responsibility_plan: options.packet.derivedViews.responsibility_plan ?? null,
        graph_context: options.packet.derivedViews.graph_context ?? [],
        context: {
          source_chunks: options.packet.derivedViews.source_chunks,
          active_memory_hints: options.packet.derivedViews.active_memory_hints,
          responsibility_plan: options.packet.derivedViews.responsibility_plan ?? null,
          graph_context: options.packet.derivedViews.graph_context ?? [],
          review_intent: intent,
          review_request: request,
          intent_description: describeReviewIntent(intent),
          topology,
          claim_cards: branchDeliberation.claims.length > 0 ? branchDeliberation.claims : claimCards,
          challenge_ledger: branchDeliberation.challengeLedger,
          debate_critique: critique,
        },
        proposal_editor_output: proposalEditorMessage.output,
        critique,
        instruction: [
          "Merge the typed proposal branch with the local claim critique thread.",
          "Reject, qualify, or endorse candidates according to claim-level challenges and evidence.",
          "Do not activate, approve, or write memory.",
        ].join(" "),
      };
      await puppetSendMessage(
        { apiUrl, authKey },
        session,
        "refinery-proposal-editor",
        {
          threadId: proposalThreadId,
          content: JSON.stringify(merge),
          mentions: ["refinery-decision-synthesizer"],
        },
      );

      const final = await pollReviewOutputs({
        apiUrl,
        authKey,
        session,
        threadIds,
        runId: options.runId,
        timeoutMs,
        readinessSnapshots,
        topology,
        complete: (messages) => debateFinalComplete(messages, proposalThreadId!, critiqueThreadId!),
      });
      finalSnapshot = final.snapshot;
      specialistMessages = final.specialistMessages;
    } else {
      if (coral.threadId) {
        threadId = coral.threadId;
      } else {
        const thread = await puppetCreateThread(
          { apiUrl, authKey },
          session,
          "refinery-claim-scout",
          {
            threadName: `Refinery review ${options.runId}`,
            participantNames: refineryCoralAgentNames,
          },
        );
        threadId = thread.thread.id;
        threadCreated = true;
      }
      threadIds = [threadId];
      await puppetSendMessage(
        { apiUrl, authKey },
        session,
        "refinery-evidence-auditor",
        {
          threadId,
          content: JSON.stringify(intake),
          mentions: ["refinery-claim-scout"],
        },
      );

      const polled = await pollReviewOutputs({
        apiUrl,
        authKey,
        session,
        threadIds,
        runId: options.runId,
        timeoutMs,
        readinessSnapshots,
        topology,
      });
      finalSnapshot = polled.snapshot;
      specialistMessages = polled.specialistMessages;
    }
    writeSpecialistStepArtifacts(runDir, specialistMessages, topology);
    const failedMessage = specialistMessages.find((message) => message.status === "failed");
    if (failedMessage) {
      throw failedSpecialistError({ runDir, runId: options.runId, message: failedMessage });
    }
    const byStep = outputMap(specialistMessages, topology);
    const requiredSteps = topology === "sparse-blackboard" && sparseBlackboard
      ? [
        ...(sparseBlackboard.modelCalls > 0 ? ["claim-scout"] : []),
        ...(sparseBlackboard.routing.wakeCartographer ? ["memory-cartographer"] : []),
        ...(sparseBlackboard.routing.wakeAuditor ? ["evidence-auditor"] : []),
        ...(sparseBlackboard.routing.wakeProposalEditor ? ["proposal-editor"] : []),
        ...(sparseBlackboard.routing.wakeDecisionSynthesizer ? ["decision-synthesizer"] : []),
      ]
      : reviewStepOrder;
    const missingSteps = requiredSteps.filter((step) => !byStep.has(step));
    if (missingSteps.length > 0) {
      throw new RefineryError(
        "CORAL_REVIEW_INCOMPLETE",
        `Coral review did not emit all specialist outputs. Missing: ${missingSteps.join(", ")}`,
        { phase: "coral", runId: options.runId, runDir, details: { missingSteps, specialistMessages } },
      );
    }

    const decisionSynthesis = byStep.get("decision-synthesizer");
    if (!decisionSynthesis && topology !== "sparse-blackboard") throw new Error("Missing decision-synthesizer output.");
    const parsedDecision = parseDecisionSynthesizerOutput(
      options.runId,
      decisionSynthesis?.output ?? { proposals: [], rejected: [] },
    );
    const proposalEditorOutput = byStep.get("proposal-editor")?.output;
    validateCoralDecisionContract({
      sourceChunks: options.packet.derivedViews.source_chunks,
      typedCandidates: isRecord(proposalEditorOutput) && Array.isArray(proposalEditorOutput.typed)
        ? proposalEditorOutput.typed
        : [],
      proposals: parsedDecision.proposals,
    });
    parsedDecision.proposals = parsedDecision.proposals.map((proposal) => ({
      ...proposal,
      intent,
    }));
    const evidenceReview = byStep.get("evidence-auditor")?.output ?? { findings: [] };
    const usage = summarizeCoralUsage(specialistMessages);
    writeJson(path.join(runDir, "paid-run.json"), {
      schemaVersion: "refinery.paid-run.v1",
      runId: options.runId,
      hypothesis: options.hypothesis?.trim() || null,
      topology,
      model: configuredModel.modelName,
      provider: configuredModel.proxyProvider,
      status: "succeeded",
      usage,
      outcome: {
        proposalCount: parsedDecision.proposals.length,
        rejectedCount: parsedDecision.rejected.length,
        unsupportedFinalProposals: 0,
        citationContractValidated: true,
      },
    });
    const deliberation: DeliberationArtifacts = buildDeliberationArtifacts({
      runId: options.runId,
      topology,
      messages: toDeliberationMessages(specialistMessages),
    });
    writeJson(path.join(runDir, "claims.json"), deliberation.claims);
    writeJson(path.join(runDir, "challenge-ledger.json"), deliberation.challengeLedger);
    writeJson(path.join(runDir, "deliberation.json"), deliberation);
    writeJson(path.join(runDir, "proposals.json"), parsedDecision.proposals);
    writeJson(path.join(runDir, "rejected.json"), parsedDecision.rejected);
    const shouldWriteSkillCandidates =
      options.packet.targets.includes("codex:skills") ||
      parsedDecision.skillCandidates.candidates.length > 0 ||
      parsedDecision.skillCandidates.rejected.length > 0 ||
      parsedDecision.skillCandidates.unresolved.length > 0;
    if (shouldWriteSkillCandidates) {
      writeJson(path.join(runDir, "skillCandidates.json"), parsedDecision.skillCandidates);
    }

    const transcript = transcriptFromSnapshot(finalSnapshot, threadIds);
    const runtime = {
      kind: "coral",
      topology,
      topologyDesign: topology === "sparse-blackboard"
        ? "app-owned-topic-blackboard"
        : topology === "debate-critique" ? "claim-centered-interruptible" : "pipeline",
      serverMode,
      apiUrl,
      authKeyPresent: Boolean(authKey),
      configPath: path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath),
      namespace: session.namespace,
      sessionId: session.sessionId,
      threadId,
      threadIds,
      proposalThreadId,
      critiqueThreadId,
      agents: refineryCoralAgentNames,
      startedServer: Boolean(child),
      sessionCreated,
      threadCreated,
      noTeardown: Boolean(coral.noTeardown),
      model: configuredModel,
      runtimeCapabilities,
      runtimeProjection,
      sparseBlackboard,
      usage,
      sourceSets: options.packet.sourceSets,
      targets: options.packet.targets,
    };
    const coralArtifact = {
      schemaVersion: "refinery.coral-review.v1",
      status: "succeeded",
      runId: options.runId,
      apiUrl,
      topology,
      serverMode,
      configPath: runtime.configPath,
      session,
      threadId,
      threadIds,
      proposalThreadId,
      critiqueThreadId,
      agents: refineryCoralAgentNames,
      sessionCreated,
      threadCreated,
      model: configuredModel,
      runtimeCapabilities,
      runtimeProjection,
      sparseBlackboard,
      usage,
      sourceSets: options.packet.sourceSets,
      targets: options.packet.targets,
      readinessSnapshots,
      specialistMessages,
      deliberation,
      transcriptExcerpts: transcript,
      serverLogExcerpt: logs.slice(-200),
    };
    writeJson(path.join(runDir, "coral.json"), coralArtifact);
    writeJson(path.join(runDir, "transcript.json"), transcript);

    const metadata: ReviewRunMetadata = {
      schemaVersion: refineryReviewSchemaVersion,
      runId: options.runId,
      sourceSets: options.packet.sourceSets,
      targets: options.packet.targets,
      scope: options.packet.objective.scope,
      dryRun: true,
      mode: "coral",
      createdAt,
      writesAttempted: false,
      sinkUrl: options.sink?.url ?? null,
      runtime,
      model: configuredModel,
      specialistOrder: topology === "sparse-blackboard" && sparseBlackboard
        ? sparseBlackboard.wakeSequence
        : topology === "debate-critique"
        ? [
          "proposal:claim-scout",
          "proposal:memory-cartographer",
          "critique:evidence-auditor",
          "proposal:proposal-editor",
          "proposal:decision-synthesizer",
        ]
        : reviewStepOrder,
      sourceLimit: options.packet.limits.sourceLimit,
      sourceCharLimit: options.packet.limits.sourceCharLimit,
      intent,
      request,
    };
    const manifestMetadata = metadata as unknown as Record<string, unknown>;
    const result: CoralReviewRunResult = {
      ok: true,
      schemaVersion: refineryReviewSchemaVersion,
      command: "review",
      mode: "coral",
      sourceSets: options.packet.sourceSets,
      targets: options.packet.targets,
      project: options.packet.objective.project,
      scope: options.packet.objective.scope,
      dryRun: true,
      runId: options.runId,
      runDir,
      counts: {
        sourceSets: options.packet.counts.sourceSets,
        documents: options.packet.counts.documents,
        activeMemoryHints: options.packet.counts.activeMemoryHints,
        proposals: parsedDecision.proposals.length,
        rejected: parsedDecision.rejected.length,
        skillCandidates: parsedDecision.skillCandidates.candidates.length,
        skillCandidateRejected: parsedDecision.skillCandidates.rejected.length,
        skillCandidateUnresolved: parsedDecision.skillCandidates.unresolved.length,
        claims: deliberation.summary.claims,
        challenges: deliberation.summary.challenges,
        deliberationMoves: deliberation.summary.moves,
      },
      proposals: parsedDecision.proposals,
      rejected: parsedDecision.rejected,
      evidenceReview,
      ...(shouldWriteSkillCandidates ? { skillCandidates: parsedDecision.skillCandidates } : {}),
      coral: {
        namespace: session.namespace,
        sessionId: session.sessionId,
        threadId: threadId ?? threadIds[0] ?? "",
        threadIds,
        agents: refineryCoralAgentNames,
        model: {
          name: configuredModel.modelName,
          transport: configuredModel.transport,
          proxyProvider: configuredModel.proxyProvider,
        },
        runtimeCapabilities: runtimeCapabilities!,
        runtimeProjection,
        usage,
      },
      metadata,
    };
    writeJson(path.join(runDir, "metadata.json"), metadata);
    writeJson(path.join(runDir, "review.json"), result);
    writeReviewArtifactManifest({
      runDir,
      runId: options.runId,
      scope: options.packet.objective.scope,
      mode: "coral",
      status: "succeeded",
      createdAt,
      counts: result.counts,
      metadata: manifestMetadata,
      intent,
      request,
    });

    if (!options.sink) return result;
    const sink = await deliverReviewSink(options.sink, result);
    const resultWithSink = { ...result, sink };
    writeJson(path.join(runDir, "sink.json"), sink);
    writeJson(path.join(runDir, "review.json"), resultWithSink);
    writeReviewArtifactManifest({
      runDir,
      runId: options.runId,
      scope: options.packet.objective.scope,
      mode: "coral",
      status: "succeeded",
      createdAt,
      counts: result.counts,
      metadata: manifestMetadata,
      intent,
      request,
    });
    return resultWithSink;
  } catch (error) {
    const refineryError = applyErrorContext(asRefineryError(error, { code: "CORAL_REVIEW_FAILED" }), {
      phase: "coral",
      runId: options.runId,
      runDir,
    });
    const usage = summarizeCoralUsage(specialistMessages);
    writeJson(path.join(runDir, "paid-run.json"), {
      schemaVersion: "refinery.paid-run.v1",
      runId: options.runId,
      hypothesis: options.hypothesis?.trim() || null,
      topology,
      model: configuredModel.modelName,
      provider: configuredModel.proxyProvider,
      status: "failed",
      usage,
      outcome: {
        errorCode: refineryError.code,
        phase: refineryError.phase,
      },
    });
    writeJson(path.join(runDir, "coral.json"), {
      schemaVersion: "refinery.coral-review.v1",
      status: "failed",
      runId: options.runId,
      apiUrl,
      topology,
      serverMode,
      configPath: path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath),
      session,
      threadId,
      threadIds,
      proposalThreadId,
      critiqueThreadId,
      agents: refineryCoralAgentNames,
      model: configuredModel,
      sourceSets: options.packet.sourceSets,
      targets: options.packet.targets,
      intent,
      request,
      readinessSnapshots,
      specialistMessages,
      transcriptExcerpts: threadIds.length > 0 ? transcriptFromSnapshot(finalSnapshot, threadIds) : [],
      serverLogExcerpt: logs.slice(-200),
      error: {
        code: refineryError.code,
        message: refineryError.message,
        phase: refineryError.phase,
      },
    });
    writeReviewFailureStatus({
      runDir,
      runId: options.runId,
      scope: options.packet.objective.scope,
      mode: "coral",
      createdAt,
      error: refineryError,
      intent,
      request,
    });
    throw refineryError;
  } finally {
    if (logs.length > 0) fs.writeFileSync(path.join(runDir, "server.log"), `${logs.join("\n")}\n`);
    try {
      if (session && sessionCreated && !coral.noTeardown) await closeSession({ apiUrl, authKey }, session);
    } finally {
      try {
        await stopStartedServer(child);
      } finally {
        if (generatedConfigPath) cleanupRuntimeCoralConfigPath(generatedConfigPath);
      }
    }
  }
}
