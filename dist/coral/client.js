import { setTimeout as sleep } from "node:timers/promises";
import { defaultCoralProxyProvider, refineryCoralAgents, refineryCoralAgentNames, refineryCoralProxyRequestName, refineryCoralAgentVersion, refineryCoralModelDefaults, } from "./definitions.js";
import { buildCoralCommunicationGroups } from "./topology.js";
function headers(authKey) {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authKey}`,
    };
}
async function jsonOrThrow(res) {
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Coral ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json());
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function option(value) {
    return { type: "string", value };
}
export function buildCoralSessionRequest(input) {
    const topology = input.topology ?? "pipeline";
    const modelName = input.modelName ?? refineryCoralModelDefaults.modelName;
    const proxyOverride = input.llmProxy?.enabled
        ? {
            [refineryCoralProxyRequestName]: {
                configurationName: input.llmProxy.configurationName ?? defaultCoralProxyProvider(modelName),
                modelName,
            },
        }
        : undefined;
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
                ...(proxyOverride ? { proxies: proxyOverride } : {}),
                annotations: {
                    "refinery.specialist": agent.specialistName,
                    "refinery.topology": topology,
                },
                options: {
                    MODEL_NAME: option(modelName),
                    MODEL_BASE_URL: option(input.modelBaseUrl ?? refineryCoralModelDefaults.baseUrl),
                    REASONING_EFFORT: option(input.reasoningEffort ?? refineryCoralModelDefaults.reasoningEffort),
                    REFINERY_CORAL_MAX_TURNS: option(input.maxTurns ?? "1"),
                },
            })),
            groups: buildCoralCommunicationGroups(topology),
            customTools: {},
        },
        namespaceProvider: {
            type: "create_if_not_exists",
            namespaceRequest: {
                name: input.namespace,
                deleteOnLastSessionExit: true,
                annotations: { app: "refinery", smoke: "coral-ping-pong", runId: input.runId, topology },
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
            topology,
        },
    };
}
export async function inspectCoralRuntimeCapabilities(apiUrl) {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api_v1.json`);
    if (!response.ok)
        throw new Error(`Coral schema request failed (${response.status}).`);
    const schema = await response.json();
    const graphAgentProperties = schema.components?.schemas?.GraphAgentRequest?.properties ?? {};
    return {
        schemaVersion: "refinery.coral-runtime-capabilities.v1",
        graphAgentProxyOverrides: "proxies" in graphAgentProperties,
        dynamicAgentInsertion: false,
        nativeSleep: false,
        softSleep: "wait_for_mention",
        wakeSignal: "mention",
    };
}
export async function getLocalAgent(opts, agentName) {
    const res = await fetch(`${opts.apiUrl}/api/v1/registry/local/${agentName}/${refineryCoralAgentVersion}`, {
        headers: headers(opts.authKey),
    });
    return jsonOrThrow(res);
}
export async function createSession(opts, req) {
    const res = await fetch(`${opts.apiUrl}/api/v1/local/session`, {
        method: "POST",
        headers: headers(opts.authKey),
        body: JSON.stringify(req),
    });
    return jsonOrThrow(res);
}
export async function closeSession(opts, session) {
    await fetch(`${opts.apiUrl}/api/v1/local/session/${session.namespace}/${session.sessionId}`, {
        method: "DELETE",
        headers: headers(opts.authKey),
    }).catch(() => { });
}
export async function getExtended(opts, session) {
    const res = await fetch(`${opts.apiUrl}/api/v1/local/session/${session.namespace}/${session.sessionId}/extended`, {
        headers: headers(opts.authKey),
    });
    return jsonOrThrow(res);
}
export async function puppetCreateThread(opts, session, agentName, body) {
    const res = await fetch(`${opts.apiUrl}/api/v1/puppet/${session.namespace}/${session.sessionId}/${agentName}/thread`, {
        method: "POST",
        headers: headers(opts.authKey),
        body: JSON.stringify(body),
    });
    return jsonOrThrow(res);
}
export async function puppetSendMessage(opts, session, agentName, body) {
    const res = await fetch(`${opts.apiUrl}/api/v1/puppet/${session.namespace}/${session.sessionId}/${agentName}/thread/message`, {
        method: "POST",
        headers: headers(opts.authKey),
        body: JSON.stringify(body),
    });
    return jsonOrThrow(res);
}
export function classifyAgentReadiness(agent) {
    const status = agent.status;
    if (!isRecord(status))
        return "starting";
    if (status.type === "stopped")
        return "stopped";
    const connectionStatus = isRecord(status.connectionStatus) ? status.connectionStatus : null;
    const communicationStatus = connectionStatus && isRecord(connectionStatus.communicationStatus)
        ? connectionStatus.communicationStatus
        : null;
    if (status.type === "running" &&
        connectionStatus?.type === "connected" &&
        (communicationStatus?.type === "waiting_message" || communicationStatus?.type === "thinking")) {
        return "ready";
    }
    return "starting";
}
export function allMessages(ext) {
    return ext.threads.flatMap((thread) => thread.messages ?? []);
}
export function parsePingEnvelope(text) {
    try {
        const parsed = JSON.parse(text);
        if (!isRecord(parsed))
            return null;
        if (parsed.type !== "refinery-ping" && parsed.type !== "refinery-pong")
            return null;
        if (typeof parsed.runId !== "string" || !Array.isArray(parsed.sequence) || typeof parsed.index !== "number") {
            return null;
        }
        return {
            type: parsed.type,
            runId: parsed.runId,
            sequence: parsed.sequence.filter((item) => typeof item === "string"),
            index: parsed.index,
            agent: typeof parsed.agent === "string" ? parsed.agent : undefined,
            specialist: typeof parsed.specialist === "string" ? parsed.specialist : undefined,
            receivedMessageId: typeof parsed.receivedMessageId === "string" ? parsed.receivedMessageId : undefined,
            nextAgent: typeof parsed.nextAgent === "string" ? parsed.nextAgent : null,
        };
    }
    catch {
        return null;
    }
}
export function evaluatePingPong(messages, threadId, runId, sequence) {
    const threadMessages = messages.filter((message) => message.threadId === threadId);
    const responses = threadMessages
        .map((message) => ({ message, envelope: parsePingEnvelope(message.text) }))
        .filter((item) => item.envelope?.type === "refinery-pong" && item.envelope.runId === runId)
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
export async function waitForAgentsReady(opts, session, agentNames, onSnapshot, wait) {
    const deadline = Date.now() + wait.timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const snapshot = await getExtended(opts, session);
        last = snapshot;
        onSnapshot(snapshot);
        const wanted = snapshot.agents.filter((agent) => agentNames.includes(agent.name));
        const stopped = wanted.filter((agent) => classifyAgentReadiness(agent) === "stopped").map((agent) => agent.name);
        if (stopped.length > 0)
            return { ok: false, snapshot, stopped };
        if (wanted.length === agentNames.length && wanted.every((agent) => classifyAgentReadiness(agent) === "ready")) {
            return { ok: true, snapshot };
        }
        await sleep(wait.intervalMs);
    }
    return { ok: false, snapshot: last, stopped: [] };
}
export async function pollPingPong(opts, session, threadId, runId, sequence, onSnapshot, wait) {
    const deadline = Date.now() + wait.timeoutMs;
    let last = null;
    let lastEvaluation = evaluatePingPong([], threadId, runId, sequence);
    while (Date.now() < deadline) {
        const snapshot = await getExtended(opts, session);
        last = snapshot;
        onSnapshot(snapshot);
        lastEvaluation = evaluatePingPong(allMessages(snapshot), threadId, runId, sequence);
        if (lastEvaluation.ok)
            return { evaluation: lastEvaluation, snapshot };
        const stopped = snapshot.agents
            .filter((agent) => sequence.includes(agent.name))
            .filter((agent) => classifyAgentReadiness(agent) === "stopped");
        if (stopped.length > 0)
            return { evaluation: lastEvaluation, snapshot };
        await sleep(wait.intervalMs);
    }
    return { evaluation: lastEvaluation, snapshot: last };
}
//# sourceMappingURL=client.js.map