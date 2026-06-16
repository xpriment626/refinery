import { setTimeout as sleep } from "node:timers/promises";
import {
  refineryCoralAgents,
  refineryCoralAgentNames,
  refineryCoralAgentVersion,
  refineryCoralModelDefaults,
} from "./definitions.ts";

export interface SessionIdentifier {
  sessionId: string;
  namespace: string;
}

export interface CoralMessage {
  id: string;
  threadId: string;
  text: string;
  senderName: string;
  mentionNames: string[];
  timestamp?: string;
}

export interface CoralThread {
  id: string;
  name?: string;
  creatorName?: string;
  participants?: string[];
  messages?: CoralMessage[];
}

export interface CoralAgentState {
  name: string;
  status?: unknown;
}

export interface ExtendedState {
  base?: unknown;
  agents: CoralAgentState[];
  threads: CoralThread[];
}

export type AgentReadiness = "ready" | "starting" | "stopped";

export interface CoralSmokeClientOptions {
  apiUrl: string;
  authKey: string;
}

export interface CoralSessionRequestInput {
  namespace: string;
  runId: string;
  modelName?: string;
  modelBaseUrl?: string;
  reasoningEffort?: string;
  maxTurns?: string;
  ttlMs?: number;
  holdAfterExitMs?: number;
}

export interface PingEnvelope {
  type: "refinery-ping" | "refinery-pong";
  runId: string;
  sequence: string[];
  index: number;
  agent?: string;
  specialist?: string;
  receivedMessageId?: string;
  nextAgent?: string | null;
}

export interface PingPongEvaluation {
  ok: boolean;
  expectedAgents: string[];
  respondedAgents: string[];
  mentionedAgents: string[];
  missingResponses: string[];
  missingMentions: string[];
  responses: Array<{ agent: string; message: CoralMessage; envelope: PingEnvelope }>;
}

function headers(authKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authKey}`,
  };
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Coral ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function option(value: string): { type: "string"; value: string } {
  return { type: "string", value };
}

export function buildCoralSessionRequest(input: CoralSessionRequestInput): unknown {
  return {
    agentGraphRequest: {
      agents: refineryCoralAgents.map((agent) => ({
        id: {
          name: agent.agentName,
          version: refineryCoralAgentVersion,
          registrySourceId: { type: "local" },
        },
        name: agent.agentName,
        description: agent.specialist.purpose,
        blocking: true,
        provider: { type: "local", runtime: "executable" },
        options: {
          MODEL_NAME: option(input.modelName ?? refineryCoralModelDefaults.modelName),
          MODEL_BASE_URL: option(input.modelBaseUrl ?? refineryCoralModelDefaults.baseUrl),
          REASONING_EFFORT: option(input.reasoningEffort ?? refineryCoralModelDefaults.reasoningEffort),
          REFINERY_CORAL_MAX_TURNS: option(input.maxTurns ?? "1"),
        },
      })),
      groups: [refineryCoralAgentNames],
      customTools: {},
    },
    namespaceProvider: {
      type: "create_if_not_exists",
      namespaceRequest: {
        name: input.namespace,
        deleteOnLastSessionExit: true,
        annotations: { app: "refinery", smoke: "coral-ping-pong", runId: input.runId },
      },
    },
    execution: {
      mode: "immediate",
      runtimeSettings: {
        ttl: input.ttlMs ?? 180_000,
        extendedEndReport: true,
        persistenceMode: { mode: "hold_after_exit", duration: input.holdAfterExitMs ?? 120_000 },
      },
    },
    annotations: {
      app: "refinery",
      smoke: "coral-ping-pong",
      runId: input.runId,
    },
  };
}

export async function getLocalAgent(opts: CoralSmokeClientOptions, agentName: string): Promise<unknown> {
  const res = await fetch(`${opts.apiUrl}/api/v1/registry/local/${agentName}/${refineryCoralAgentVersion}`, {
    headers: headers(opts.authKey),
  });
  return jsonOrThrow(res);
}

export async function createSession(opts: CoralSmokeClientOptions, req: unknown): Promise<SessionIdentifier> {
  const res = await fetch(`${opts.apiUrl}/api/v1/local/session`, {
    method: "POST",
    headers: headers(opts.authKey),
    body: JSON.stringify(req),
  });
  return jsonOrThrow<SessionIdentifier>(res);
}

export async function closeSession(opts: CoralSmokeClientOptions, session: SessionIdentifier): Promise<void> {
  await fetch(`${opts.apiUrl}/api/v1/local/session/${session.namespace}/${session.sessionId}`, {
    method: "DELETE",
    headers: headers(opts.authKey),
  }).catch(() => {});
}

export async function getExtended(opts: CoralSmokeClientOptions, session: SessionIdentifier): Promise<ExtendedState> {
  const res = await fetch(`${opts.apiUrl}/api/v1/local/session/${session.namespace}/${session.sessionId}/extended`, {
    headers: headers(opts.authKey),
  });
  return jsonOrThrow<ExtendedState>(res);
}

export async function puppetCreateThread(
  opts: CoralSmokeClientOptions,
  session: SessionIdentifier,
  agentName: string,
  body: { threadName: string; participantNames: string[] },
): Promise<{ thread: CoralThread }> {
  const res = await fetch(`${opts.apiUrl}/api/v1/puppet/${session.namespace}/${session.sessionId}/${agentName}/thread`, {
    method: "POST",
    headers: headers(opts.authKey),
    body: JSON.stringify(body),
  });
  return jsonOrThrow<{ thread: CoralThread }>(res);
}

export async function puppetSendMessage(
  opts: CoralSmokeClientOptions,
  session: SessionIdentifier,
  agentName: string,
  body: { threadId: string; content: string; mentions: string[] },
): Promise<{ status: string; message: CoralMessage }> {
  const res = await fetch(`${opts.apiUrl}/api/v1/puppet/${session.namespace}/${session.sessionId}/${agentName}/thread/message`, {
    method: "POST",
    headers: headers(opts.authKey),
    body: JSON.stringify(body),
  });
  return jsonOrThrow<{ status: string; message: CoralMessage }>(res);
}

export function classifyAgentReadiness(agent: CoralAgentState): AgentReadiness {
  const status = agent.status;
  if (!isRecord(status)) return "starting";
  if (status.type === "stopped") return "stopped";
  const connectionStatus = isRecord(status.connectionStatus) ? status.connectionStatus : null;
  const communicationStatus = connectionStatus && isRecord(connectionStatus.communicationStatus)
    ? connectionStatus.communicationStatus
    : null;
  if (
    status.type === "running" &&
    connectionStatus?.type === "connected" &&
    (communicationStatus?.type === "waiting_message" || communicationStatus?.type === "thinking")
  ) {
    return "ready";
  }
  return "starting";
}

export function allMessages(ext: ExtendedState): CoralMessage[] {
  return ext.threads.flatMap((thread) => thread.messages ?? []);
}

export function parsePingEnvelope(text: string): PingEnvelope | null {
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed.type !== "refinery-ping" && parsed.type !== "refinery-pong") return null;
    if (typeof parsed.runId !== "string" || !Array.isArray(parsed.sequence) || typeof parsed.index !== "number") {
      return null;
    }
    return {
      type: parsed.type,
      runId: parsed.runId,
      sequence: parsed.sequence.filter((item): item is string => typeof item === "string"),
      index: parsed.index,
      agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
      specialist: typeof parsed.specialist === "string" ? parsed.specialist : undefined,
      receivedMessageId: typeof parsed.receivedMessageId === "string" ? parsed.receivedMessageId : undefined,
      nextAgent: typeof parsed.nextAgent === "string" ? parsed.nextAgent : null,
    };
  } catch {
    return null;
  }
}

export function evaluatePingPong(messages: CoralMessage[], threadId: string, runId: string, sequence: string[]): PingPongEvaluation {
  const threadMessages = messages.filter((message) => message.threadId === threadId);
  const responses = threadMessages
    .map((message) => ({ message, envelope: parsePingEnvelope(message.text) }))
    .filter((item): item is { message: CoralMessage; envelope: PingEnvelope } =>
      item.envelope?.type === "refinery-pong" && item.envelope.runId === runId
    )
    .map((item) => ({ agent: item.message.senderName, message: item.message, envelope: item.envelope }))
    .sort((left, right) => left.envelope.index - right.envelope.index);
  const respondedAgents = responses.map((response) => response.agent);
  const mentionedAgents = Array.from(new Set(threadMessages.flatMap((message) => message.mentionNames ?? [])));
  const missingResponses = sequence.filter((agent) => !respondedAgents.includes(agent));
  const missingMentions = sequence.filter((agent) => !mentionedAgents.includes(agent));
  return {
    ok: missingResponses.length === 0 && missingMentions.length === 0,
    expectedAgents: sequence,
    respondedAgents,
    mentionedAgents,
    missingResponses,
    missingMentions,
    responses,
  };
}

export async function waitForAgentsReady(
  opts: CoralSmokeClientOptions,
  session: SessionIdentifier,
  agentNames: string[],
  onSnapshot: (snapshot: ExtendedState) => void,
  wait: { timeoutMs: number; intervalMs: number },
): Promise<{ ok: true; snapshot: ExtendedState } | { ok: false; snapshot: ExtendedState | null; stopped: string[] }> {
  const deadline = Date.now() + wait.timeoutMs;
  let last: ExtendedState | null = null;
  while (Date.now() < deadline) {
    const snapshot = await getExtended(opts, session);
    last = snapshot;
    onSnapshot(snapshot);
    const wanted = snapshot.agents.filter((agent) => agentNames.includes(agent.name));
    const stopped = wanted.filter((agent) => classifyAgentReadiness(agent) === "stopped").map((agent) => agent.name);
    if (stopped.length > 0) return { ok: false, snapshot, stopped };
    if (wanted.length === agentNames.length && wanted.every((agent) => classifyAgentReadiness(agent) === "ready")) {
      return { ok: true, snapshot };
    }
    await sleep(wait.intervalMs);
  }
  return { ok: false, snapshot: last, stopped: [] };
}

export async function pollPingPong(
  opts: CoralSmokeClientOptions,
  session: SessionIdentifier,
  threadId: string,
  runId: string,
  sequence: string[],
  onSnapshot: (snapshot: ExtendedState) => void,
  wait: { timeoutMs: number; intervalMs: number },
): Promise<{ evaluation: PingPongEvaluation; snapshot: ExtendedState | null }> {
  const deadline = Date.now() + wait.timeoutMs;
  let last: ExtendedState | null = null;
  let lastEvaluation: PingPongEvaluation = evaluatePingPong([], threadId, runId, sequence);
  while (Date.now() < deadline) {
    const snapshot = await getExtended(opts, session);
    last = snapshot;
    onSnapshot(snapshot);
    lastEvaluation = evaluatePingPong(allMessages(snapshot), threadId, runId, sequence);
    if (lastEvaluation.ok) return { evaluation: lastEvaluation, snapshot };
    const stopped = snapshot.agents
      .filter((agent) => sequence.includes(agent.name))
      .filter((agent) => classifyAgentReadiness(agent) === "stopped");
    if (stopped.length > 0) return { evaluation: lastEvaluation, snapshot };
    await sleep(wait.intervalMs);
  }
  return { evaluation: lastEvaluation, snapshot: last };
}
