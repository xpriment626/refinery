import { type ReviewTopology } from "./topology.ts";
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
    topology?: ReviewTopology;
    llmProxy?: {
        enabled: boolean;
        configurationName?: string;
    };
}
export interface CoralRuntimeCapabilities {
    schemaVersion: "refinery.coral-runtime-capabilities.v1";
    graphAgentProxyOverrides: boolean;
    dynamicAgentInsertion: false;
    nativeSleep: false;
    softSleep: "wait_for_mention";
    wakeSignal: "mention";
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
    responses: Array<{
        agent: string;
        message: CoralMessage;
        envelope: PingEnvelope;
    }>;
}
export declare function buildCoralSessionRequest(input: CoralSessionRequestInput): unknown;
export declare function inspectCoralRuntimeCapabilities(apiUrl: string): Promise<CoralRuntimeCapabilities>;
export declare function getLocalAgent(opts: CoralSmokeClientOptions, agentName: string): Promise<unknown>;
export declare function createSession(opts: CoralSmokeClientOptions, req: unknown): Promise<SessionIdentifier>;
export declare function closeSession(opts: CoralSmokeClientOptions, session: SessionIdentifier): Promise<void>;
export declare function getExtended(opts: CoralSmokeClientOptions, session: SessionIdentifier): Promise<ExtendedState>;
export declare function puppetCreateThread(opts: CoralSmokeClientOptions, session: SessionIdentifier, agentName: string, body: {
    threadName: string;
    participantNames: string[];
}): Promise<{
    thread: CoralThread;
}>;
export declare function puppetSendMessage(opts: CoralSmokeClientOptions, session: SessionIdentifier, agentName: string, body: {
    threadId: string;
    content: string;
    mentions: string[];
}): Promise<{
    status: string;
    message: CoralMessage;
}>;
export declare function classifyAgentReadiness(agent: CoralAgentState): AgentReadiness;
export declare function allMessages(ext: ExtendedState): CoralMessage[];
export declare function parsePingEnvelope(text: string): PingEnvelope | null;
export declare function evaluatePingPong(messages: CoralMessage[], threadId: string, runId: string, sequence: string[]): PingPongEvaluation;
export declare function waitForAgentsReady(opts: CoralSmokeClientOptions, session: SessionIdentifier, agentNames: string[], onSnapshot: (snapshot: ExtendedState) => void, wait: {
    timeoutMs: number;
    intervalMs: number;
}): Promise<{
    ok: true;
    snapshot: ExtendedState;
} | {
    ok: false;
    snapshot: ExtendedState | null;
    stopped: string[];
}>;
export declare function pollPingPong(opts: CoralSmokeClientOptions, session: SessionIdentifier, threadId: string, runId: string, sequence: string[], onSnapshot: (snapshot: ExtendedState) => void, wait: {
    timeoutMs: number;
    intervalMs: number;
}): Promise<{
    evaluation: PingPongEvaluation;
    snapshot: ExtendedState | null;
}>;
