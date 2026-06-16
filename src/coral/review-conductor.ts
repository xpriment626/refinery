import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
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
  puppetCreateThread,
  puppetSendMessage,
  waitForAgentsReady,
  type CoralMessage,
  type ExtendedState,
  type SessionIdentifier,
} from "./client.ts";
import {
  refineryCoralAgentNames,
  refineryCoralAuthKey,
  refineryCoralConfigPath,
  refineryCoralModelDefaults,
  refineryCoralPort,
} from "./definitions.ts";
import {
  memoryMaintenanceActions,
  refineryReviewSchemaVersion,
  type ActiveMemory,
  type MemoryMaintenanceAction,
  type MemoryProposal,
  type MemoryStoreAdapter,
  type SourceEvidence,
} from "../core/adapter.ts";
import { loadLocalEnv } from "../env.ts";
import {
  applyErrorContext,
  asRefineryError,
  RefineryError,
} from "../core/errors.ts";
import { writeReviewArtifactManifest, reviewStepOrder } from "../core/artifacts.ts";
import {
  deliverReviewSink,
  writeReviewFailureStatus,
  type ReviewRejected,
  type ReviewRunMetadata,
  type ReviewRunResult,
  type ReviewSinkOptions,
  type ReviewSinkResult,
} from "../core/review.ts";

const DEFAULT_SOURCE_LIMIT = 3;
const DEFAULT_SOURCE_CHAR_LIMIT = 6000;
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
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
  coralPackage?: string;
  timeoutMs?: number;
  modelName?: string;
  modelBaseUrl?: string;
  reasoningEffort?: string;
  maxTurns?: string;
}

export interface CoralReviewRunOptions {
  adapter: MemoryStoreAdapter;
  project: string;
  source: "claude-code-sessions";
  target: "codex-memory";
  scope: string;
  runId: string;
  outputDir: string;
  sink?: ReviewSinkOptions;
  sourceLimit?: number;
  sourceCharLimit?: number;
  coral?: CoralReviewRuntimeOptions;
}

export interface CoralReviewRunResult extends ReviewRunResult {
  mode: "coral";
  source: "claude-code-sessions";
  target: "codex-memory";
  project: string;
  relationshipReview: unknown;
  coral: {
    namespace: string;
    sessionId: string;
    threadId: string;
    agents: string[];
  };
  sink?: ReviewSinkResult;
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

function compactText(text: string, max = MAX_EXCERPT_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3).trimEnd()}...`;
}

function sourceRefs(source: SourceEvidence): unknown[] {
  if (source.refs && source.refs.length > 0) return source.refs;
  return [{ source_id: source.id, source_path: source.path ?? null, kind: source.kind }];
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
    .filter((source) => source.text.length > 0);
}

function memoryHints(memories: ActiveMemory[], limit = 12): unknown[] {
  return memories.slice(0, limit).map((memory) => ({
    id: memory.id,
    type: memory.type,
    scope: memory.scope,
    body: compactText(memory.body, 360),
    provenance: memory.provenance ?? null,
  }));
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

function collectSpecialistMessages(messages: CoralMessage[], threadId: string, runId: string): SpecialistMessage[] {
  return messages
    .filter((message) => message.threadId === threadId)
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
      error: envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
        ? envelope.error
        : null,
    }))
    .sort((left, right) => reviewStepOrder.indexOf(left.step) - reviewStepOrder.indexOf(right.step));
}

function outputMap(messages: SpecialistMessage[]): Map<string, SpecialistMessage> {
  const byStep = new Map<string, SpecialistMessage>();
  for (const message of messages) {
    if (message.status === "succeeded" && message.output && !byStep.has(message.step)) {
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

function parseRelevanceOutput(runId: string, output: Record<string, unknown>): {
  proposals: MemoryProposal[];
  rejected: ReviewRejected[];
} {
  const proposalRows = asRecords(output.proposals, "relevance.proposals");
  const rejectedRows = asRecords(output.rejected ?? [], "relevance.rejected");
  return {
    proposals: proposalRows.map((row, index) => ({
      schemaVersion: refineryReviewSchemaVersion,
      id: `proposal:${runId}:${index + 1}`,
      action: parseAction(row.action),
      lifecycle: "proposed",
      memoryType: requiredString(row, "memory_type"),
      scope: requiredString(row, "proposed_scope"),
      body: requiredString(row, "body"),
      confidence: requiredNumber(row, "confidence"),
      rationale: requiredString(row, "rationale"),
      sourceRefs: Array.isArray(row.source_refs) ? row.source_refs : [],
      targetMemoryId: normalizeId(row.target_memory_id),
    })),
    rejected: rejectedRows.map((row, index) => ({
      sourceId: typeof row.source_id === "string" ? row.source_id : `rejected:${runId}:${index + 1}`,
      reason: requiredString(row, "reason"),
    })),
  };
}

function appendLogLines(store: string[], prefix: string, chunk: Buffer): void {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) store.push(`[${prefix}] ${line}`);
  while (store.length > 500) store.shift();
}

function node24Bin(): string | null {
  const candidate = path.join(os.homedir(), ".nvm/versions/node/v24.10.0/bin/node");
  return fs.existsSync(candidate) ? candidate : null;
}

function coralJavaHome(): string | null {
  const candidates = [
    "/opt/homebrew/Cellar/openjdk/25.0.2/libexec/openjdk.jdk/Contents/Home",
    "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "bin/java"))) ?? null;
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
  coralPackage: string;
  logs: string[];
}): ChildProcessWithoutNullStreams {
  const configAbs = path.isAbsolute(args.configPath) ? args.configPath : path.resolve(repoRoot, args.configPath);
  const nodeBin = node24Bin();
  const nodeDir = nodeBin ? path.dirname(nodeBin) : null;
  const javaHome = coralJavaHome();
  const pathEntries = [
    nodeDir,
    javaHome ? path.join(javaHome, "bin") : null,
    process.env.PATH,
  ].filter((entry): entry is string => Boolean(entry));
  const child = spawn("npx", ["-y", args.coralPackage, "server", "start"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CONFIG_FILE_PATH: configAbs,
      REFINERY_NODE_BIN: process.env.REFINERY_NODE_BIN ?? nodeBin ?? undefined,
      JAVA_HOME: process.env.JAVA_HOME ?? javaHome ?? undefined,
      PATH: pathEntries.join(":"),
    },
  });
  child.stdout.on("data", (chunk: Buffer) => appendLogLines(args.logs, "coral:stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => appendLogLines(args.logs, "coral:stderr", chunk));
  child.on("exit", (code, signal) => args.logs.push(`[coral:exit] code=${code ?? "null"} signal=${signal ?? "null"}`));
  return child;
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
  threadId: string;
  runId: string;
  timeoutMs: number;
  readinessSnapshots: ReadinessSnapshot[];
}): Promise<{ snapshot: ExtendedState | null; specialistMessages: SpecialistMessage[] }> {
  const deadline = Date.now() + args.timeoutMs;
  let lastSnapshot: ExtendedState | null = null;
  let lastMessages: SpecialistMessage[] = [];
  while (Date.now() < deadline) {
    const snapshot = await getExtended({ apiUrl: args.apiUrl, authKey: args.authKey }, args.session);
    lastSnapshot = snapshot;
    recordReadinessSnapshot(args.readinessSnapshots, snapshot);
    lastMessages = collectSpecialistMessages(allMessages(snapshot), args.threadId, args.runId);
    if (lastMessages.some((message) => message.status === "failed")) {
      return { snapshot, specialistMessages: lastMessages };
    }
    const byStep = outputMap(lastMessages);
    if (reviewStepOrder.every((step) => byStep.has(step))) {
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

function transcriptFromSnapshot(snapshot: ExtendedState | null, threadId: string): unknown[] {
  if (!snapshot) return [];
  return allMessages(snapshot)
    .filter((message) => message.threadId === threadId)
    .map((message) => ({
      id: message.id,
      threadId: message.threadId,
      senderName: message.senderName,
      mentionNames: message.mentionNames ?? [],
      timestamp: message.timestamp ?? null,
      textExcerpt: compactText(message.text),
    }));
}

function writeSpecialistStepArtifacts(runDir: string, messages: SpecialistMessage[]): void {
  for (const message of messages) {
    const stepDir = path.join(runDir, "steps", message.step);
    writeJson(path.join(stepDir, "input.json"), {
      step: message.step,
      agent: message.agent,
      status: message.status,
      messageId: message.messageId,
      threadId: message.threadId,
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

export async function runCoralReview(options: CoralReviewRunOptions): Promise<CoralReviewRunResult> {
  const runDir = path.join(options.outputDir, options.runId);
  const createdAt = new Date().toISOString();
  const sourceLimit = Math.max(1, Math.min(options.sourceLimit ?? DEFAULT_SOURCE_LIMIT, 10));
  const sourceCharLimit = Math.max(500, Math.min(options.sourceCharLimit ?? DEFAULT_SOURCE_CHAR_LIMIT, 24_000));
  const coral = options.coral ?? {};
  const apiUrl = coral.apiUrl ?? `http://localhost:${refineryCoralPort}`;
  const authKey = coral.authKey ?? refineryCoralAuthKey;
  const configPath = coral.configPath ?? refineryCoralConfigPath;
  const startServer = coral.startServer ?? !coral.apiUrl;
  const serverMode = startServer ? "managed" : "attached";
  const namespace = coral.namespace ?? `refinery-${options.runId}`;
  const timeoutMs = coral.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const localEnv = loadLocalEnv(repoRoot);
  const readConfig = (name: string): string | undefined => process.env[name] ?? localEnv[name];
  const configuredModel = {
    provider: readConfig("MODEL_PROVIDER") ?? readConfig("REFINERY_MODEL_PROVIDER") ?? "openrouter",
    baseUrl: coral.modelBaseUrl ?? readConfig("MODEL_BASE_URL") ?? readConfig("REFINERY_MODEL_BASE_URL") ?? refineryCoralModelDefaults.baseUrl,
    modelName: coral.modelName ?? readConfig("MODEL_NAME") ?? readConfig("REFINERY_MODEL_NAME") ?? refineryCoralModelDefaults.modelName,
    reasoningEffort: coral.reasoningEffort ?? readConfig("REASONING_EFFORT") ?? refineryCoralModelDefaults.reasoningEffort,
  };
  const logs: string[] = [];
  const readinessSnapshots: ReadinessSnapshot[] = [];
  let child: ChildProcessWithoutNullStreams | null = null;
  let session: SessionIdentifier | null = null;
  let threadId: string | null = null;
  let sessionCreated = false;
  let threadCreated = false;
  let finalSnapshot: ExtendedState | null = null;
  let specialistMessages: SpecialistMessage[] = [];

  fs.mkdirSync(runDir, { recursive: true });
  try {
    const [sources, activeMemories] = await Promise.all([
      options.adapter.listSourceEvidence({ scope: options.scope, limit: sourceLimit }),
      options.adapter.listActiveMemories({ scope: options.scope, limit: 50 }),
    ]);
    const sourceChunks = toSourceChunks(sources, sourceCharLimit);
    const activeMemoryHints = memoryHints(activeMemories);
    const intake = {
      schemaVersion: refineryReviewSchemaVersion,
      type: "refinery-review-intake",
      runId: options.runId,
      project: options.project,
      source: options.source,
      target: options.target,
      adapter: options.adapter.name,
      scope: options.scope,
      noApply: true,
      dryRun: true,
      sourceLimit,
      sourceCharLimit,
      source_chunks: sourceChunks,
      active_memory_hints: activeMemoryHints,
      proposal_schema: {
        schemaVersion: refineryReviewSchemaVersion,
        lifecycle: "proposed",
        writesAttempted: false,
        actions: memoryMaintenanceActions,
      },
      instruction:
        "Coordinate over this intake and emit proposal-shaped outputs only. Do not activate, approve, or write memory.",
    };
    writeJson(path.join(runDir, "input.json"), intake);

    if (startServer && !(await isServerReady(apiUrl, authKey))) {
      child = startCoralServer({
        configPath,
        coralPackage: coral.coralPackage ?? process.env.REFINERY_CORAL_PACKAGE ?? "coralos-dev@RC-1.2.0",
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
          maxTurns: coral.maxTurns ?? process.env.REFINERY_CORAL_MAX_TURNS ?? "2",
          ttlMs: Math.max(timeoutMs + 60_000, 180_000),
          holdAfterExitMs: Math.max(timeoutMs + 60_000, 180_000),
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

    if (coral.threadId) {
      threadId = coral.threadId;
    } else {
      const thread = await puppetCreateThread(
        { apiUrl, authKey },
        session,
        "refinery-capture",
        {
          threadName: `Refinery review ${options.runId}`,
          participantNames: refineryCoralAgentNames,
        },
      );
      threadId = thread.thread.id;
      threadCreated = true;
    }
    await puppetSendMessage(
      { apiUrl, authKey },
      session,
      "refinery-relationship-review",
      {
        threadId,
        content: JSON.stringify(intake),
        mentions: ["refinery-capture"],
      },
    );

    const polled = await pollReviewOutputs({
      apiUrl,
      authKey,
      session,
      threadId,
      runId: options.runId,
      timeoutMs,
      readinessSnapshots,
    });
    finalSnapshot = polled.snapshot;
    specialistMessages = polled.specialistMessages;
    writeSpecialistStepArtifacts(runDir, specialistMessages);
    const failedMessage = specialistMessages.find((message) => message.status === "failed");
    if (failedMessage) {
      throw failedSpecialistError({ runDir, runId: options.runId, message: failedMessage });
    }
    const byStep = outputMap(specialistMessages);
    const missingSteps = reviewStepOrder.filter((step) => !byStep.has(step));
    if (missingSteps.length > 0) {
      throw new RefineryError(
        "CORAL_REVIEW_INCOMPLETE",
        `Coral review did not emit all specialist outputs. Missing: ${missingSteps.join(", ")}`,
        { phase: "coral", runId: options.runId, runDir, details: { missingSteps, specialistMessages } },
      );
    }

    const relevance = byStep.get("relevance");
    if (!relevance) throw new Error("Missing relevance output.");
    const parsedRelevance = parseRelevanceOutput(options.runId, relevance.output ?? {});
    const relationshipReview = byStep.get("relationship-review")?.output ?? { findings: [] };
    writeJson(path.join(runDir, "proposals.json"), parsedRelevance.proposals);
    writeJson(path.join(runDir, "rejected.json"), parsedRelevance.rejected);

    const transcript = transcriptFromSnapshot(finalSnapshot, threadId);
    const runtime = {
      kind: "coral",
      serverMode,
      apiUrl,
      authKeyPresent: Boolean(authKey),
      configPath: path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath),
      namespace: session.namespace,
      sessionId: session.sessionId,
      threadId,
      agents: refineryCoralAgentNames,
      startedServer: Boolean(child),
      sessionCreated,
      threadCreated,
      noTeardown: Boolean(coral.noTeardown),
      model: configuredModel,
    };
    const coralArtifact = {
      schemaVersion: "refinery.coral-review.v1",
      status: "succeeded",
      runId: options.runId,
      apiUrl,
      serverMode,
      configPath: runtime.configPath,
      session,
      threadId,
      agents: refineryCoralAgentNames,
      sessionCreated,
      threadCreated,
      model: configuredModel,
      readinessSnapshots,
      specialistMessages,
      transcriptExcerpts: transcript,
      serverLogExcerpt: logs.slice(-200),
    };
    writeJson(path.join(runDir, "coral.json"), coralArtifact);
    writeJson(path.join(runDir, "transcript.json"), transcript);

    const metadata: ReviewRunMetadata = {
      schemaVersion: refineryReviewSchemaVersion,
      runId: options.runId,
      adapter: options.adapter.name,
      scope: options.scope,
      dryRun: true,
      mode: "coral",
      createdAt,
      writesAttempted: false,
      sinkUrl: options.sink?.url ?? null,
      runtime,
      model: configuredModel,
      specialistOrder: reviewStepOrder,
      sourceLimit,
      sourceCharLimit,
    };
    const result: CoralReviewRunResult = {
      ok: true,
      schemaVersion: refineryReviewSchemaVersion,
      command: "review",
      mode: "coral",
      source: options.source,
      target: options.target,
      project: options.project,
      adapter: { name: options.adapter.name },
      scope: options.scope,
      dryRun: true,
      runId: options.runId,
      runDir,
      counts: {
        sources: sources.length,
        activeMemories: activeMemories.length,
        proposals: parsedRelevance.proposals.length,
        rejected: parsedRelevance.rejected.length,
      },
      proposals: parsedRelevance.proposals,
      rejected: parsedRelevance.rejected,
      relationshipReview,
      coral: {
        namespace: session.namespace,
        sessionId: session.sessionId,
        threadId,
        agents: refineryCoralAgentNames,
      },
      metadata,
    };
    writeJson(path.join(runDir, "metadata.json"), metadata);
    writeJson(path.join(runDir, "review.json"), result);
    writeReviewArtifactManifest({
      runDir,
      runId: options.runId,
      adapterName: options.adapter.name,
      scope: options.scope,
      mode: "coral",
      status: "succeeded",
      createdAt,
      counts: result.counts,
      metadata,
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
      mode: "coral",
      status: "succeeded",
      createdAt,
      counts: result.counts,
      metadata,
    });
    return resultWithSink;
  } catch (error) {
    const refineryError = applyErrorContext(asRefineryError(error, { code: "CORAL_REVIEW_FAILED" }), {
      phase: "coral",
      runId: options.runId,
      runDir,
    });
    writeJson(path.join(runDir, "coral.json"), {
      schemaVersion: "refinery.coral-review.v1",
      status: "failed",
      runId: options.runId,
      apiUrl,
      serverMode,
      configPath: path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath),
      session,
      threadId,
      agents: refineryCoralAgentNames,
      model: configuredModel,
      readinessSnapshots,
      specialistMessages,
      transcriptExcerpts: threadId ? transcriptFromSnapshot(finalSnapshot, threadId) : [],
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
      adapterName: options.adapter.name,
      scope: options.scope,
      mode: "coral",
      createdAt,
      error: refineryError,
    });
    throw refineryError;
  } finally {
    if (logs.length > 0) fs.writeFileSync(path.join(runDir, "server.log"), `${logs.join("\n")}\n`);
    if (session && sessionCreated && !coral.noTeardown) await closeSession({ apiUrl, authKey }, session);
    await stopStartedServer(child);
  }
}
