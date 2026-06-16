import { loadLocalEnv } from "../env.ts";
import { getCoralAgentBySpecialistName, getSpecialistNameArg, refineryCoralModelDefaults } from "./definitions.ts";
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
    const nextAgent = envelope.sequence[ownIndex + 1] ?? null;
    const content = JSON.stringify({
      type: "refinery-pong",
      runId: envelope.runId,
      sequence: envelope.sequence,
      index: ownIndex,
      agent: definition.agentName,
      specialist: definition.specialistName,
      receivedMessageId: message.id,
      nextAgent,
      purpose: definition.specialist.purpose,
    });

    await connection.client.callTool({
      name: connection.sendMessageToolName,
      arguments: {
        threadId: message.threadId,
        content,
        mentions: nextAgent ? [nextAgent] : [],
      },
    });
    log(definition.agentName, `responded in thread=${message.threadId} next=${nextAgent ?? "none"}`);
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
