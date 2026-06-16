import { loadLocalEnv } from "../env.ts";
import {
  getCoralAgentBySpecialistName,
  getSpecialistNameArg,
  refineryCoralAgentNames,
  refineryCoralModelDefaults,
} from "./definitions.ts";
import { connectCoralMcp, parseWaitForMentionResult, readCoralState } from "./mcp.ts";

interface WorkerModelConfig {
  modelName: string;
  baseUrl: string;
  reasoningEffort: string;
  hasApiKey: boolean;
}

function readEnv(name: string, localEnv: Record<string, string>): string | undefined {
  return process.env[name] ?? localEnv[name];
}

export function loadWorkerModelConfig(cwd = process.cwd()): WorkerModelConfig {
  const localEnv = loadLocalEnv(cwd);
  const apiKey = readEnv("MODEL_API_KEY", localEnv) ?? readEnv("OPENROUTER_API_KEY", localEnv);
  return {
    modelName: readEnv("MODEL_NAME", localEnv) ?? readEnv("REFINERY_MODEL_NAME", localEnv) ?? refineryCoralModelDefaults.modelName,
    baseUrl: readEnv("MODEL_BASE_URL", localEnv) ?? readEnv("REFINERY_MODEL_BASE_URL", localEnv) ?? refineryCoralModelDefaults.baseUrl,
    reasoningEffort: readEnv("REASONING_EFFORT", localEnv) ?? refineryCoralModelDefaults.reasoningEffort,
    hasApiKey: Boolean(apiKey),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactText(text: string, max = 420): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 3).trimEnd() + "...";
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

function sourceRefsFrom(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  return Array.isArray(value.refs)
    ? value.refs
    : Array.isArray(value.source_refs)
      ? value.source_refs
      : [];
}

function nextReviewAgent(agentName: string): string | null {
  const index = refineryCoralAgentNames.indexOf(agentName);
  return index >= 0 ? refineryCoralAgentNames[index + 1] ?? null : null;
}

function buildReviewOutput(specialistName: string, envelope: Record<string, unknown>): {
  output: Record<string, unknown>;
  context: Record<string, unknown>;
} {
  const context = contextFrom(envelope);
  const previousOutput = isRecord(envelope.output) ? envelope.output : {};
  if (specialistName === "capture") {
    const chunks = arrayFrom(context, "source_chunks");
    const first = chunks[0];
    const text = typeof first?.text === "string" ? first.text : "No source text was provided.";
    return {
      context,
      output: {
        candidates: [
          {
            claim: compactText(text),
            source_refs: sourceRefsFrom(first),
            why_future_useful: "Candidate came from Coral-coordinated Refinery review intake.",
          },
        ],
      },
    };
  }

  if (specialistName === "distillation") {
    const candidates = arrayFrom(previousOutput, "candidates");
    return {
      context,
      output: {
        distilled: candidates.map((candidate, index) => ({
          body: compactText(typeof candidate.claim === "string" ? candidate.claim : `Candidate ${index + 1}`),
          source_refs: sourceRefsFrom(candidate),
          rationale: "Distilled from the capture specialist candidate.",
        })),
      },
    };
  }

  if (specialistName === "schema") {
    const distilled = arrayFrom(previousOutput, "distilled");
    return {
      context,
      output: {
        typed: distilled.map((item) => ({
          body: compactText(typeof item.body === "string" ? item.body : "Distilled memory candidate."),
          memory_type: "semantic",
          primary_type: "semantic",
          secondary_type: null,
          type_confidence: 0.62,
          type_rationale: "Executable worker scaffold uses a conservative semantic classification.",
          ambiguities: ["coral_worker_scaffold"],
          durability: "durable",
          ttl: null,
          proposed_scope: "project",
          action: "create",
          target_memory_id: null,
          source_refs: sourceRefsFrom(item),
        })),
      },
    };
  }

  if (specialistName === "relevance") {
    const typed = arrayFrom(previousOutput, "typed");
    return {
      context,
      output: {
        proposals: typed.map((item) => ({
          memory_type: typeof item.memory_type === "string" ? item.memory_type : "semantic",
          proposed_scope: typeof item.proposed_scope === "string" ? item.proposed_scope : "project",
          body: compactText(typeof item.body === "string" ? item.body : "Typed memory candidate."),
          confidence: 0.62,
          rationale: "Proposal emitted by bounded Coral worker scaffold from real review intake.",
          source_refs: sourceRefsFrom(item),
          action: "create",
          target_memory_id: null,
        })),
        rejected: [],
      },
    };
  }

  const proposals = arrayFrom(previousOutput, "proposals");
  return {
    context,
    output: {
      findings: proposals.map((proposal) => ({
        body: compactText(typeof proposal.body === "string" ? proposal.body : "Proposal body unavailable."),
        relation: "novel",
        target_memory_id: null,
        confidence: 0.6,
        rationale: "No deterministic duplicate match was asserted by the worker scaffold.",
        source_refs: sourceRefsFrom(proposal),
        memory_refs: [],
      })),
    },
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
    `model=${model.modelName} baseUrl=${model.baseUrl} reasoning=${model.reasoningEffort} apiKey=${model.hasApiKey ? "present" : "missing"}`,
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
      const built = buildReviewOutput(definition.specialistName, reviewEnvelope);
      const next = nextReviewAgent(definition.agentName);
      const content = JSON.stringify({
        type: "refinery-review-output",
        runId: reviewEnvelope.runId,
        step: definition.specialistName,
        agent: definition.agentName,
        specialist: definition.specialistName,
        receivedMessageId: message.id,
        output: built.output,
        context: built.context,
      });
      await connection.client.callTool({
        name: connection.sendMessageToolName,
        arguments: {
          threadId: message.threadId,
          content,
          mentions: next ? [next] : [],
        },
      });
      log(definition.agentName, `review output sent in thread=${message.threadId} next=${next ?? "none"}`);
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

main().catch((error) => {
  const label = process.env.CORAL_AGENT_ID ?? "refinery-worker";
  console.error(`[${new Date().toISOString()}] [${label}] FATAL: ${(error as Error).message}`);
  console.error(error);
  process.exit(1);
});
