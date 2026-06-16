import { loadLocalEnv } from "../env.ts";
import type { ModelConfig } from "../env.ts";
import {
  parseCapture,
  parseDistillation,
  parseRelationshipReview,
  parseRelevance,
  parseSchema,
  buildPrompt,
  redactModel,
} from "../core/live-review.ts";
import { refineryReviewSchemaVersion } from "../core/adapter.ts";
import {
  captureSpecialist,
  distillationSpecialist,
  relationshipReviewSpecialist,
  relevanceSpecialist,
  schemaSpecialist,
} from "../core/specialists/index.ts";
import type { LocalSpecialist, SpecialistName } from "../core/specialists/types.ts";
import { callOpenRouterChatWithMetadata, type OpenRouterCallMetadata } from "../runtimes/mastra/runtime.ts";
import {
  getCoralAgentBySpecialistName,
  getSpecialistNameArg,
  refineryCoralAgentNames,
  refineryCoralModelDefaults,
} from "./definitions.ts";
import { connectCoralMcp, parseWaitForMentionResult, readCoralState } from "./mcp.ts";

const coralSpecialistPromptVersion = "refinery.coral-specialist-prompt.v1";

interface WorkerModelConfig extends ModelConfig {
  modelName: string;
  baseUrl: string;
  reasoningEffort: string;
  apiKeyPresent: boolean;
}

type WorkerModelCaller = (request: {
  model: ModelConfig;
  system: string;
  user: string;
}) => Promise<{ content: string; metadata?: OpenRouterCallMetadata }>;

function readEnv(name: string, localEnv: Record<string, string>): string | undefined {
  return process.env[name] ?? localEnv[name];
}

export function loadWorkerModelConfig(cwd = process.cwd()): WorkerModelConfig {
  const localEnv = loadLocalEnv(cwd);
  const apiKey = readEnv("MODEL_API_KEY", localEnv) ?? readEnv("OPENROUTER_API_KEY", localEnv);
  return {
    provider: readEnv("MODEL_PROVIDER", localEnv) ?? readEnv("REFINERY_MODEL_PROVIDER", localEnv) ?? "openrouter",
    modelName: readEnv("MODEL_NAME", localEnv) ?? readEnv("REFINERY_MODEL_NAME", localEnv) ?? refineryCoralModelDefaults.modelName,
    baseUrl: readEnv("MODEL_BASE_URL", localEnv) ?? readEnv("REFINERY_MODEL_BASE_URL", localEnv) ?? refineryCoralModelDefaults.baseUrl,
    apiKey: apiKey ?? "",
    reasoningEffort: readEnv("REASONING_EFFORT", localEnv) ?? refineryCoralModelDefaults.reasoningEffort,
    apiKeyPresent: Boolean(apiKey),
  };
}

function log(agentName: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [${agentName}] ${message}`);
}

function parseMaxTurns(): number {
  const raw = process.env.REFINERY_CORAL_MAX_TURNS ?? "2";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

export function isCoralWaitTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /request timed out|timeout of .* occurred waiting|timed out/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseMessageEnvelope(text: string): { runId: string; sequence: string[]; index: number; nextAgent: string | null } | null {
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed.type !== "refinery-ping" && parsed.type !== "refinery-pong") return null;
    if (typeof parsed.runId !== "string" || !Array.isArray(parsed.sequence) || typeof parsed.index !== "number") {
      return null;
    }
    return {
      runId: parsed.runId,
      sequence: parsed.sequence.filter((item): item is string => typeof item === "string"),
      index: parsed.index,
      nextAgent: typeof parsed.nextAgent === "string" ? parsed.nextAgent : null,
    };
  } catch {
    return null;
  }
}

function parseReviewEnvelope(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.type !== "refinery-review-intake" && parsed.type !== "refinery-review-output") return null;
    if (typeof parsed.runId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function contextFrom(envelope: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(envelope.context)) return envelope.context;
  return {
    source_chunks: Array.isArray(envelope.source_chunks) ? envelope.source_chunks : [],
    active_memory_hints: Array.isArray(envelope.active_memory_hints) ? envelope.active_memory_hints : [],
  };
}

function arrayFrom(record: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = record[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

function nextReviewAgent(agentName: string): string | null {
  const index = refineryCoralAgentNames.indexOf(agentName);
  return index >= 0 ? refineryCoralAgentNames[index + 1] ?? null : null;
}

function specialistForName(name: SpecialistName): LocalSpecialist {
  switch (name) {
    case "capture":
      return captureSpecialist;
    case "distillation":
      return distillationSpecialist;
    case "schema":
      return schemaSpecialist;
    case "relevance":
      return relevanceSpecialist;
    case "relationship-review":
      return relationshipReviewSpecialist;
  }
}

function outputShapeForSpecialist(name: SpecialistName): string {
  switch (name) {
    case "capture":
      return `{"candidates":[{"claim":"...","source_refs":[],"why_future_useful":"..."}]}`;
    case "distillation":
      return `{"distilled":[{"body":"...","source_refs":[],"rationale":"..."}]}`;
    case "schema":
      return `{"typed":[{"body":"...","memory_type":"semantic","primary_type":"semantic","secondary_type":null,"type_confidence":0.8,"type_rationale":"...","ambiguities":[],"durability":"durable","ttl":null,"proposed_scope":"project","action":"create","target_memory_id":null,"source_refs":[]}]}`;
    case "relevance":
      return `{"proposals":[{"memory_type":"semantic","proposed_scope":"project","body":"...","confidence":0.8,"rationale":"...","source_refs":[],"action":"create","target_memory_id":null}],"rejected":[]}`;
    case "relationship-review":
      return `{"findings":[{"body":"...","relation":"novel","target_memory_id":null,"confidence":0.8,"rationale":"...","source_refs":[],"memory_refs":[{"memory_id":"memory:1","provenance_kind":"fixture"}]}]}`;
  }
}

function instructionForSpecialist(name: SpecialistName): string {
  switch (name) {
    case "capture":
      return "Emit at most three durable, evidence-bound candidate memories. Prefer fewer high-signal candidates over broad extraction.";
    case "distillation":
      return "Rewrite each candidate into an atomic, self-contained memory body while preserving source_refs.";
    case "schema":
      return "Use project scope for this slice. Set memory_type equal to primary_type. Use canonical action, not mutation_op.";
    case "relevance":
      return "Emit proposal-shaped records only for durable future-useful candidates. Include rejected[] for filtered candidates.";
    case "relationship-review":
      return "Classify each proposal exactly once against active-memory candidates. memory_refs must be objects, never bare strings.";
  }
}

function compactMemoryHints(value: unknown, limit = 10): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit);
}

function activeMemoryCandidates(context: Record<string, unknown>, relevanceOutput: Record<string, unknown>): unknown[] {
  const proposals = arrayFrom(relevanceOutput, "proposals");
  const memories = compactMemoryHints(context.active_memory_hints, 8);
  return proposals.map((proposal, proposalIndex) => ({
    proposal_index: proposalIndex,
    proposal_body: typeof proposal.body === "string" ? proposal.body : null,
    memories,
  }));
}

function coralThreadContext(args: {
  message: { id: string; senderName: string; mentionNames: string[]; threadId: string };
  envelope: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    threadId: args.message.threadId,
    receivedMessageId: args.message.id,
    senderName: args.message.senderName,
    mentionNames: args.message.mentionNames,
    previousAgent: typeof args.envelope.agent === "string" ? args.envelope.agent : args.message.senderName,
    previousStep: typeof args.envelope.step === "string" ? args.envelope.step : null,
  };
}

function payloadForSpecialist(args: {
  specialistName: SpecialistName;
  envelope: Record<string, unknown>;
  message: { id: string; senderName: string; mentionNames: string[]; threadId: string };
}): { payload: Record<string, unknown>; context: Record<string, unknown> } {
  const context = contextFrom(args.envelope);
  const previousOutput = isRecord(args.envelope.output) ? args.envelope.output : {};
  const threadContext = coralThreadContext({ message: args.message, envelope: args.envelope });
  switch (args.specialistName) {
    case "capture":
      return {
        context,
        payload: {
          source_chunks: Array.isArray(context.source_chunks) ? context.source_chunks : [],
          active_memory_hints: compactMemoryHints(context.active_memory_hints),
          coral_thread_context: threadContext,
        },
      };
    case "distillation":
      return {
        context,
        payload: {
          candidates: arrayFrom(previousOutput, "candidates"),
          coral_thread_context: threadContext,
        },
      };
    case "schema":
      return {
        context,
        payload: {
          distilled: arrayFrom(previousOutput, "distilled"),
          active_memory_hints: compactMemoryHints(context.active_memory_hints),
          coral_thread_context: threadContext,
        },
      };
    case "relevance":
      return {
        context,
        payload: {
          typed: arrayFrom(previousOutput, "typed"),
          coral_thread_context: threadContext,
        },
      };
    case "relationship-review":
      return {
        context,
        payload: {
          relevance: previousOutput,
          active_memory_candidates: activeMemoryCandidates(context, previousOutput),
          coral_thread_context: threadContext,
        },
      };
  }
}

function parseSpecialistOutput(name: SpecialistName, raw: string): Record<string, unknown> {
  switch (name) {
    case "capture":
      return parseCapture(raw) as unknown as Record<string, unknown>;
    case "distillation":
      return parseDistillation(raw) as unknown as Record<string, unknown>;
    case "schema":
      return parseSchema(raw) as unknown as Record<string, unknown>;
    case "relevance":
      return parseRelevance(raw) as unknown as Record<string, unknown>;
    case "relationship-review":
      return parseRelationshipReview(raw) as unknown as Record<string, unknown>;
  }
}

function failureEnvelope(args: {
  runId: string;
  step: SpecialistName;
  agentName: string;
  receivedMessageId: string;
  code: string;
  message: string;
  rawOutput?: string;
  model: WorkerModelConfig;
  providerMetadata?: OpenRouterCallMetadata;
  prompt?: { system: string; user: string };
}): Record<string, unknown> {
  return {
    schemaVersion: refineryReviewSchemaVersion,
    type: "refinery-review-output",
    status: "failed",
    runId: args.runId,
    step: args.step,
    agent: args.agentName,
    specialist: args.step,
    receivedMessageId: args.receivedMessageId,
    promptVersion: coralSpecialistPromptVersion,
    model: redactModel(args.model),
    providerMetadata: args.providerMetadata ?? null,
    prompt: args.prompt ?? null,
    rawOutput: args.rawOutput ?? "",
    error: {
      code: args.code,
      message: args.message,
    },
  };
}

export async function buildLiveReviewEnvelope(args: {
  specialistName: SpecialistName;
  agentName: string;
  envelope: Record<string, unknown>;
  message: { id: string; senderName: string; mentionNames: string[]; threadId: string };
  model: WorkerModelConfig;
  callModel?: WorkerModelCaller;
}): Promise<Record<string, unknown>> {
  const runId = String(args.envelope.runId);
  const specialist = specialistForName(args.specialistName);
  const { payload, context } = payloadForSpecialist(args);
  const prompt = buildPrompt({
    specialist,
    shape: outputShapeForSpecialist(args.specialistName),
    instruction: instructionForSpecialist(args.specialistName),
    payload,
  });

  if (!args.model.apiKey) {
    return failureEnvelope({
      runId,
      step: args.specialistName,
      agentName: args.agentName,
      receivedMessageId: args.message.id,
      code: "MODEL_CONFIG_MISSING",
      message: "OPENROUTER_API_KEY or MODEL_API_KEY is required for live Coral specialist execution.",
      model: args.model,
      prompt,
    });
  }

  let rawOutput = "";
  let providerMetadata: OpenRouterCallMetadata | undefined;
  try {
    const callModel = args.callModel ?? callOpenRouterChatWithMetadata;
    const response = await callModel({
      model: args.model,
      system: prompt.system,
      user: prompt.user,
    });
    rawOutput = response.content;
    providerMetadata = response.metadata;
  } catch (error) {
    return failureEnvelope({
      runId,
      step: args.specialistName,
      agentName: args.agentName,
      receivedMessageId: args.message.id,
      code: "MODEL_CALL_FAILED",
      message: error instanceof Error ? error.message : String(error),
      model: args.model,
      providerMetadata,
      prompt,
    });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseSpecialistOutput(args.specialistName, rawOutput);
  } catch (error) {
    return failureEnvelope({
      runId,
      step: args.specialistName,
      agentName: args.agentName,
      receivedMessageId: args.message.id,
      code: "MODEL_OUTPUT_INVALID",
      message: error instanceof Error ? error.message : String(error),
      rawOutput,
      model: args.model,
      providerMetadata,
      prompt,
    });
  }

  return {
    schemaVersion: refineryReviewSchemaVersion,
    type: "refinery-review-output",
    status: "succeeded",
    runId,
    step: args.specialistName,
    agent: args.agentName,
    specialist: args.specialistName,
    receivedMessageId: args.message.id,
    promptVersion: coralSpecialistPromptVersion,
    model: redactModel(args.model),
    providerMetadata: providerMetadata ?? null,
    prompt,
    rawOutput,
    output: parsed,
    context,
  };
}

async function main(): Promise<void> {
  const specialistName = getSpecialistNameArg(process.argv.slice(2));
  const definition = getCoralAgentBySpecialistName(specialistName);
  const model = loadWorkerModelConfig();
  const coralConnectionUrl = process.env.CORAL_CONNECTION_URL;
  if (!coralConnectionUrl) throw new Error("CORAL_CONNECTION_URL is required for executable Coral agents");

  log(definition.agentName, `booted specialist=${definition.specialistName} session=${process.env.CORAL_SESSION_ID ?? "unknown"}`);
  log(
    definition.agentName,
    `model=${model.modelName} baseUrl=${model.baseUrl} reasoning=${model.reasoningEffort} apiKey=${model.apiKeyPresent ? "present" : "missing"}`,
  );

  const connection = await connectCoralMcp(coralConnectionUrl, `refinery-${definition.specialistName}-worker`);
  log(definition.agentName, `mcp connected tools=${connection.toolNames.join(",")}`);
  try {
    const state = await readCoralState(connection.client);
    log(definition.agentName, `state readable=${isRecord(state) && !("error" in state) ? "yes" : "partial"}`);
  } catch (error) {
    log(definition.agentName, `state read failed: ${(error as Error).message}`);
  }

  let cursorMs = 0;
  let handled = 0;
  const handledIds = new Set<string>();
  const maxTurns = parseMaxTurns();

  while (handled < maxTurns) {
    const beforeWait = Date.now();
    let waitResult: unknown;
    try {
      waitResult = await connection.client.callTool({
        name: connection.waitForMentionToolName,
        arguments: { currentUnixTime: cursorMs, maxWaitMs: 60_000 },
      });
    } catch (error) {
      if (isCoralWaitTimeout(error)) {
        cursorMs = beforeWait;
        log(definition.agentName, `wait_for_mention timed out; continuing idle wait`);
        continue;
      }
      log(definition.agentName, `wait_for_mention failed: ${(error as Error).message}`);
      await connection.client.close();
      process.exit(0);
    }
    cursorMs = beforeWait;
    const message = parseWaitForMentionResult(waitResult);
    if (!message) continue;
    if (handledIds.has(message.id)) continue;
    handledIds.add(message.id);

    const reviewEnvelope = parseReviewEnvelope(message.text);
    if (reviewEnvelope) {
      const expectedAgent =
        reviewEnvelope.type === "refinery-review-intake"
          ? "refinery-capture"
          : nextReviewAgent(String(reviewEnvelope.agent ?? message.senderName));
      if (expectedAgent !== definition.agentName && !message.mentionNames.includes(definition.agentName)) {
        log(definition.agentName, `ignored review message expected=${expectedAgent ?? "none"}`);
        continue;
      }
      handled += 1;
      const outputEnvelope = await buildLiveReviewEnvelope({
        specialistName: definition.specialistName,
        agentName: definition.agentName,
        envelope: reviewEnvelope,
        message,
        model,
      });
      const next = outputEnvelope.status === "succeeded" ? nextReviewAgent(definition.agentName) : null;
      const content = JSON.stringify(outputEnvelope);
      await connection.client.callTool({
        name: connection.sendMessageToolName,
        arguments: {
          threadId: message.threadId,
          content,
          mentions: next ? [next] : [],
        },
      });
      log(
        definition.agentName,
        `review output sent status=${String(outputEnvelope.status)} thread=${message.threadId} next=${next ?? "none"}`,
      );
      continue;
    }

    const envelope = parseMessageEnvelope(message.text);
    if (!envelope) {
      log(definition.agentName, `ignored non-ping message from ${message.senderName}`);
      continue;
    }
    const expectedAgent = envelope.sequence[envelope.index];
    const ownIndex = envelope.sequence.indexOf(definition.agentName);
    if (expectedAgent !== definition.agentName && envelope.nextAgent !== definition.agentName) {
      log(definition.agentName, `ignored ping index=${envelope.index} expected=${expectedAgent} next=${envelope.nextAgent ?? "none"}`);
      continue;
    }
    if (ownIndex < 0) {
      log(definition.agentName, "ignored ping because this agent is not in the sequence");
      continue;
    }

    handled += 1;
    const nextPingAgent = envelope.sequence[ownIndex + 1] ?? null;
    const content = JSON.stringify({
      type: "refinery-pong",
      runId: envelope.runId,
      sequence: envelope.sequence,
      index: ownIndex,
      agent: definition.agentName,
      specialist: definition.specialistName,
      receivedMessageId: message.id,
      nextAgent: nextPingAgent,
      purpose: definition.specialist.purpose,
    });

    await connection.client.callTool({
      name: connection.sendMessageToolName,
      arguments: {
        threadId: message.threadId,
        content,
        mentions: nextPingAgent ? [nextPingAgent] : [],
      },
    });
    log(definition.agentName, `responded in thread=${message.threadId} next=${nextPingAgent ?? "none"}`);
  }

  log(definition.agentName, `max turns reached (${maxTurns}); exiting cleanly`);
  await connection.client.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const label = process.env.CORAL_AGENT_ID ?? "refinery-worker";
    console.error(`[${new Date().toISOString()}] [${label}] FATAL: ${(error as Error).message}`);
    console.error(error);
    process.exit(1);
  });
}
