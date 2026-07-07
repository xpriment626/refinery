import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { allMessages, buildCoralSessionRequest, classifyAgentReadiness, closeSession, createSession, getExtended, getLocalAgent, puppetCreateThread, puppetSendMessage, waitForAgentsReady, } from "./client.js";
import { refineryCoralAgentGlobForRepo, refineryCoralAgentNames, refineryCoralAuthKey, refineryCoralConfigPath, refineryCoralModelDefaults, refineryCoralPort, } from "./definitions.js";
import { defaultReviewTopology } from "./topology.js";
import { memoryMaintenanceActions, refineryReviewSchemaVersion, } from "../core/types.js";
import { loadLocalEnv, parseModelMaxTokens } from "../env.js";
import { applyErrorContext, asRefineryError, RefineryError, } from "../core/errors.js";
import { writeReviewArtifactManifest, reviewStepOrder } from "../core/artifacts.js";
import { buildDeliberationArtifacts, claimCardsForCritique, } from "../core/deliberation.js";
import { deliverReviewSink, writeReviewFailureStatus, } from "../core/review.js";
import { defaultReviewIntent, describeReviewIntent } from "../core/intents.js";
const DEFAULT_PIPELINE_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_DEBATE_CRITIQUE_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_WAIT_INTERVAL_MS = 1_500;
const MAX_EXCERPT_CHARS = 1200;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
export function defaultCoralReviewTimeoutMs(topology) {
    return topology === "debate-critique"
        ? DEFAULT_DEBATE_CRITIQUE_WAIT_TIMEOUT_MS
        : DEFAULT_PIPELINE_WAIT_TIMEOUT_MS;
}
function compactText(text, max = MAX_EXCERPT_CHARS) {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max)
        return compact;
    return `${compact.slice(0, max - 3).trimEnd()}...`;
}
function buildConsoleUrl(apiUrl, pathname) {
    try {
        const url = new URL(apiUrl);
        url.pathname = pathname;
        url.search = "";
        url.hash = "";
        return url.toString();
    }
    catch {
        return `${apiUrl.replace(/\/+$/, "")}${pathname}`;
    }
}
function resolveConfiguredModel(coral) {
    const localEnv = loadLocalEnv(repoRoot);
    const readConfig = (name) => process.env[name] ?? localEnv[name];
    return {
        provider: "coral",
        baseUrl: coral.modelBaseUrl ?? readConfig("MODEL_BASE_URL") ?? readConfig("REFINERY_MODEL_BASE_URL") ?? refineryCoralModelDefaults.baseUrl,
        modelName: coral.modelName ?? readConfig("MODEL_NAME") ?? readConfig("REFINERY_MODEL_NAME") ?? refineryCoralModelDefaults.modelName,
        reasoningEffort: coral.reasoningEffort ?? readConfig("REASONING_EFFORT") ?? refineryCoralModelDefaults.reasoningEffort,
        maxTokens: parseModelMaxTokens(readConfig("MODEL_MAX_TOKENS") ?? readConfig("REFINERY_MODEL_MAX_TOKENS")),
    };
}
function buildReviewIntake(args) {
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
        phase: args.topology === "debate-critique" ? "proposal-intake" : "pipeline",
        sourceLimit: args.packet.limits.sourceLimit,
        sourceCharLimit: args.packet.limits.sourceCharLimit,
        source_chunks: args.packet.derivedViews.source_chunks,
        active_memory_hints: args.packet.derivedViews.active_memory_hints,
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
            args.topology === "debate-critique"
                ? "Use debate/critique topology: proposal work and critique work happen in separate Coral threads before final synthesis."
                : "Use the default pipeline topology.",
        ].join(" "),
    };
}
function parseReviewOutput(text) {
    try {
        const parsed = JSON.parse(text);
        const status = parsed?.status === "failed" ? "failed" : "succeeded";
        if (parsed?.type !== "refinery-review-output" ||
            typeof parsed.runId !== "string" ||
            typeof parsed.step !== "string" ||
            !reviewStepOrder.includes(parsed.step) ||
            (status === "succeeded" &&
                (!parsed.output || typeof parsed.output !== "object" || Array.isArray(parsed.output))) ||
            (status === "failed" &&
                (!parsed.error || typeof parsed.error !== "object" || Array.isArray(parsed.error)))) {
            return null;
        }
        return {
            ...parsed,
            status,
        };
    }
    catch {
        return null;
    }
}
function collectSpecialistMessages(messages, threadIds, runId) {
    const allowedThreadIds = new Set(threadIds);
    return messages
        .filter((message) => allowedThreadIds.has(message.threadId))
        .map((message) => ({ message, envelope: parseReviewOutput(message.text) }))
        .filter((item) => item.envelope !== null && item.envelope.runId === runId)
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
function debatePriority(message) {
    if (message.step === "decision-synthesizer" && message.phase === "proposal-synthesis")
        return 3;
    if (message.phase === "pipeline")
        return 2;
    if (!message.phase)
        return 1;
    return 0;
}
function outputMap(messages, topology = defaultReviewTopology) {
    const byStep = new Map();
    for (const message of messages) {
        if (message.status !== "succeeded" || !message.output)
            continue;
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
function normalizeId(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "number")
        return `memory:${value}`;
    if (typeof value === "string")
        return value;
    throw new Error("target_memory_id must be string, number, or null.");
}
function normalizeIds(value) {
    if (value === null || value === undefined)
        return [];
    if (Array.isArray(value))
        return value.map((item) => {
            const normalized = normalizeId(item);
            if (!normalized)
                throw new Error("target_memory_id array must not contain null values.");
            return normalized;
        });
    const normalized = normalizeId(value);
    return normalized ? [normalized] : [];
}
function parseAction(value) {
    if (!memoryMaintenanceActions.includes(value)) {
        throw new Error(`Invalid proposal action: ${String(value)}`);
    }
    return value;
}
function asRecords(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array.`);
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error(`${label}[${index}] must be an object.`);
        }
        return item;
    });
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function requiredString(record, field) {
    const value = record[field];
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${field} must be a non-empty string.`);
    return value;
}
function requiredNumber(record, field) {
    const value = record[field];
    if (typeof value !== "number" || value < 0 || value > 1) {
        throw new Error(`${field} must be a number from 0 to 1.`);
    }
    return value;
}
function optionalString(record, field) {
    if (!(field in record))
        return undefined;
    const value = record[field];
    if (value === null)
        return null;
    if (typeof value !== "string")
        throw new Error(`${field} must be string or null when present.`);
    return value;
}
function optionalStringArray(record, field) {
    if (!(field in record))
        return undefined;
    const value = record[field];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`${field} must be an array of strings when present.`);
    }
    return value;
}
function parseDecisionSynthesizerOutput(runId, output) {
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
function skillBundle(output) {
    const camel = output.skillCandidates;
    const snake = output.skill_candidates;
    if (isRecord(camel))
        return camel;
    if (isRecord(snake))
        return snake;
    return {};
}
function skillRows(output, camel, snake) {
    const bundle = skillBundle(output);
    const bundled = bundle[camel] ?? bundle[snake];
    const direct = output[`skill${camel[0].toUpperCase()}${camel.slice(1)}`] ?? output[`skill_${snake}`];
    const value = bundled ?? direct ?? [];
    return asRecords(value, `decision-synthesizer.${camel}`);
}
function stringArrayFrom(record, camel, snake) {
    const value = record[camel] ?? record[snake];
    if (Array.isArray(value))
        return value.filter((item) => typeof item === "string");
    if (typeof value === "string" && value.trim())
        return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return [];
}
function refsFrom(record, camel, snake) {
    const value = record[camel] ?? record[snake];
    return Array.isArray(value) ? value : [];
}
function parseSkillCandidateArtifact(runId, output) {
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
        rejected: rejectedRows.map((row, index) => ({
            sourceId: typeof row.sourceId === "string"
                ? row.sourceId
                : typeof row.source_id === "string"
                    ? row.source_id
                    : `skill-rejected:${runId}:${index + 1}`,
            reason: typeof row.reason === "string" && row.reason.trim() ? row.reason : requiredString(row, "rationale"),
        })),
        unresolved: unresolvedRows.map((row, index) => ({
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
function appendLogLines(store, prefix, chunk) {
    const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines)
        store.push(`[${prefix}] ${line}`);
    while (store.length > 500)
        store.shift();
}
function node24Bin() {
    const candidate = path.join(os.homedir(), ".nvm/versions/node/v24.10.0/bin/node");
    return fs.existsSync(candidate) ? candidate : null;
}
function coralJavaHome() {
    const candidates = [
        "/opt/homebrew/Cellar/openjdk/25.0.2/libexec/openjdk.jdk/Contents/Home",
        "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    ];
    return candidates.find((candidate) => fs.existsSync(path.join(candidate, "bin/java"))) ?? null;
}
async function isServerReady(apiUrl, authKey) {
    try {
        const res = await fetch(`${apiUrl}/api/v1/registry`, {
            headers: { Authorization: `Bearer ${authKey}` },
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
async function waitForServer(apiUrl, authKey, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isServerReady(apiUrl, authKey))
            return true;
        await sleep(1_000);
    }
    return false;
}
function startCoralServer(args) {
    const configAbs = path.isAbsolute(args.configPath) ? args.configPath : path.resolve(repoRoot, args.configPath);
    const nodeBin = node24Bin();
    const nodeDir = nodeBin ? path.dirname(nodeBin) : null;
    const javaHome = coralJavaHome();
    const pathEntries = [
        nodeDir,
        javaHome ? path.join(javaHome, "bin") : null,
        process.env.PATH,
    ].filter((entry) => Boolean(entry));
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
    child.stdout.on("data", (chunk) => appendLogLines(args.logs, "coral:stdout", chunk));
    child.stderr.on("data", (chunk) => appendLogLines(args.logs, "coral:stderr", chunk));
    child.on("exit", (code, signal) => args.logs.push(`[coral:exit] code=${code ?? "null"} signal=${signal ?? "null"}`));
    return child;
}
function defaultRuntimeCoralConfig() {
    return [
        "[network]",
        'bind_address = "127.0.0.1"',
        'external_address = "127.0.0.1"',
        `bind_port = ${refineryCoralPort}`,
        "allow_any_host = true",
        "",
        "[auth]",
        `keys = ["${refineryCoralAuthKey}"]`,
        "",
        "[registry]",
        "include_coral_home_agents = false",
        "include_debug_agents = false",
        "export_debug_agents = false",
        "watch_local_agents = true",
        'local_agent_rescan_timer = "10s"',
        `local_agents = [${JSON.stringify(refineryCoralAgentGlobForRepo(repoRoot))}]`,
        "",
    ].join("\n");
}
export function resolveRuntimeCoralConfigPath(configPath) {
    if (configPath !== refineryCoralConfigPath) {
        return path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath);
    }
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-config-"));
    const runtimeConfigPath = path.join(configDir, "refinery-config.toml");
    fs.writeFileSync(runtimeConfigPath, defaultRuntimeCoralConfig());
    return runtimeConfigPath;
}
async function stopStartedServer(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
    child.kill("SIGTERM");
    await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve())),
        sleep(5_000).then(() => {
            if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
        }),
    ]);
}
function recordReadinessSnapshot(target, snapshot) {
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
    if (target.length > 80)
        target.shift();
}
async function pollReviewOutputs(args) {
    const deadline = Date.now() + args.timeoutMs;
    let lastSnapshot = null;
    let lastMessages = [];
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
        if (stopped.length > 0)
            break;
        await sleep(DEFAULT_WAIT_INTERVAL_MS);
    }
    return { snapshot: lastSnapshot, specialistMessages: lastMessages };
}
function findMessage(args) {
    return args.messages.find((message) => message.status === "succeeded" &&
        message.output &&
        message.step === args.step &&
        (args.threadId ? message.threadId === args.threadId : true) &&
        (args.phase ? message.phase === args.phase : true)) ?? null;
}
function debateBranchesComplete(messages, proposalThreadId, critiqueThreadId) {
    return Boolean(findMessage({ messages, step: "claim-scout", threadId: proposalThreadId, phase: "candidate-proposal" }) &&
        findMessage({ messages, step: "memory-cartographer", threadId: proposalThreadId, phase: "memory-cartography" }) &&
        findMessage({ messages, step: "proposal-editor", threadId: proposalThreadId, phase: "typed-proposal" }) &&
        findMessage({ messages, step: "evidence-auditor", threadId: critiqueThreadId, phase: "preflight-critique" }));
}
function debateFinalComplete(messages, proposalThreadId, critiqueThreadId) {
    return debateBranchesComplete(messages, proposalThreadId, critiqueThreadId) &&
        Boolean(findMessage({ messages, step: "decision-synthesizer", threadId: proposalThreadId, phase: "proposal-synthesis" }));
}
function transcriptFromSnapshot(snapshot, threadIds) {
    if (!snapshot)
        return [];
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
function safeFileToken(value) {
    return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "message";
}
function writeSpecialistMessageArtifacts(runDir, messages) {
    for (const message of messages) {
        const token = safeFileToken(`${message.phase ?? "unphased"}-${message.messageId}`);
        const messageDir = path.join(runDir, "steps", message.step, "messages", token);
        writeJson(path.join(messageDir, "message.json"), message);
        fs.writeFileSync(path.join(messageDir, "output.raw.md"), `${message.rawOutput ?? message.textExcerpt}\n`);
        if (message.output)
            writeJson(path.join(messageDir, "output.parsed.json"), message.output);
        if (message.error)
            writeJson(path.join(messageDir, "error.json"), message.error);
    }
}
function writeSpecialistStepArtifacts(runDir, messages, topology = defaultReviewTopology) {
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
        if (message.output)
            writeJson(path.join(stepDir, "output.parsed.json"), message.output);
        if (message.error)
            writeJson(path.join(stepDir, "error.json"), message.error);
    }
}
function toDeliberationMessages(messages) {
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
function failedSpecialistError(args) {
    const code = typeof args.message.error?.code === "string" ? args.message.error.code : "CORAL_SPECIALIST_FAILED";
    const message = typeof args.message.error?.message === "string" ? args.message.error.message : "Specialist returned a failed review envelope.";
    return new RefineryError(code, `Coral specialist ${args.message.step} failed: ${message}`, {
        phase: "coral",
        runId: args.runId,
        runDir: args.runDir,
        failedStep: args.message.step,
        rawOutputPath: path.join(args.runDir, "steps", args.message.step, "output.raw.md"),
        details: args.message.error ?? null,
    });
}
export async function startCoralConsoleRun(options) {
    const intent = options.packet.objective.intent;
    const request = options.packet.objective.request;
    const coral = options.coral ?? {};
    const topology = coral.topology ?? defaultReviewTopology;
    const apiUrl = coral.apiUrl ?? `http://localhost:${refineryCoralPort}`;
    const authKey = coral.authKey ?? refineryCoralAuthKey;
    const configPath = resolveRuntimeCoralConfigPath(coral.configPath ?? refineryCoralConfigPath);
    const startServer = coral.startServer ?? !coral.apiUrl;
    const serverMode = startServer ? "managed" : "attached";
    const namespace = coral.namespace ?? `refinery-${options.runId}`;
    const timeoutMs = coral.timeoutMs ?? defaultCoralReviewTimeoutMs(topology);
    const configuredModel = resolveConfiguredModel(coral);
    const logs = [];
    const readinessSnapshots = [];
    const seededMessages = [];
    let child = null;
    let session = null;
    let sessionCreated = false;
    let closed = false;
    try {
        const intake = buildReviewIntake({
            runId: options.runId,
            packet: options.packet,
            intent,
            request,
            topology,
        });
        if (startServer && !(await isServerReady(apiUrl, authKey))) {
            child = startCoralServer({
                configPath,
                coralPackage: coral.coralPackage ?? process.env.REFINERY_CORAL_PACKAGE ?? "coralos-dev@RC-1.2.0",
                logs,
            });
        }
        if (!(await waitForServer(apiUrl, authKey, 60_000))) {
            throw new RefineryError("CORAL_SERVER_UNREACHABLE", `Coral server was not reachable at ${apiUrl}.`, { phase: "coral", runId: options.runId });
        }
        const registry = [];
        for (const agentName of refineryCoralAgentNames) {
            try {
                await getLocalAgent({ apiUrl, authKey }, agentName);
                registry.push({ agentName, ok: true });
            }
            catch (error) {
                registry.push({ agentName, ok: false, error: error.message });
                throw new RefineryError("CORAL_AGENT_REGISTRY_MISSING", `Coral registry missing ${agentName}: ${error.message}`, { phase: "coral", runId: options.runId, details: registry });
            }
        }
        if (coral.sessionId) {
            session = { namespace, sessionId: coral.sessionId };
        }
        else {
            session = await createSession({ apiUrl, authKey }, buildCoralSessionRequest({
                namespace,
                runId: options.runId,
                modelName: configuredModel.modelName,
                modelBaseUrl: configuredModel.baseUrl,
                reasoningEffort: configuredModel.reasoningEffort,
                maxTurns: coral.maxTurns ?? process.env.REFINERY_CORAL_MAX_TURNS ?? (topology === "debate-critique" ? "3" : "2"),
                ttlMs: Math.max(timeoutMs + 60_000, 30 * 60_000),
                holdAfterExitMs: Math.max(timeoutMs + 60_000, 30 * 60_000),
            }));
            sessionCreated = true;
        }
        const ready = await waitForAgentsReady({ apiUrl, authKey }, session, refineryCoralAgentNames, (snapshot) => recordReadinessSnapshot(readinessSnapshots, snapshot), { timeoutMs: 90_000, intervalMs: DEFAULT_WAIT_INTERVAL_MS });
        if (!ready.ok) {
            throw new RefineryError("CORAL_AGENTS_NOT_READY", `Agents did not reach readiness. stopped=${ready.stopped.join(",") || "none"}`, { phase: "coral", runId: options.runId, details: ready.snapshot });
        }
        let threadId;
        let threadIds;
        let proposalThreadId;
        let critiqueThreadId;
        const rememberSeed = (message) => {
            seededMessages.push({
                id: message.id,
                threadId: message.threadId,
                senderName: message.senderName,
                mentionNames: message.mentionNames ?? [],
                textExcerpt: compactText(message.text),
            });
        };
        if (topology === "debate-critique") {
            if (coral.threadId) {
                proposalThreadId = coral.threadId;
            }
            else {
                const proposalThread = await puppetCreateThread({ apiUrl, authKey }, session, "refinery-claim-scout", {
                    threadName: `Refinery console ${options.runId} proposal`,
                    participantNames: refineryCoralAgentNames,
                });
                proposalThreadId = proposalThread.thread.id;
            }
            const critiqueThread = await puppetCreateThread({ apiUrl, authKey }, session, "refinery-evidence-auditor", {
                threadName: `Refinery console ${options.runId} critique`,
                participantNames: refineryCoralAgentNames,
            });
            critiqueThreadId = critiqueThread.thread.id;
            threadId = proposalThreadId;
            threadIds = [proposalThreadId, critiqueThreadId];
            const proposalSeed = await puppetSendMessage({ apiUrl, authKey }, session, "refinery-evidence-auditor", {
                threadId: proposalThreadId,
                content: JSON.stringify({ ...intake, phase: "proposal-intake" }),
                mentions: ["refinery-claim-scout"],
            });
            rememberSeed(proposalSeed.message);
            const critiqueSeed = await puppetSendMessage({ apiUrl, authKey }, session, "refinery-claim-scout", {
                threadId: critiqueThreadId,
                content: JSON.stringify({ ...intake, phase: "critique-intake" }),
                mentions: ["refinery-evidence-auditor"],
            });
            rememberSeed(critiqueSeed.message);
        }
        else {
            if (coral.threadId) {
                threadId = coral.threadId;
            }
            else {
                const thread = await puppetCreateThread({ apiUrl, authKey }, session, "refinery-claim-scout", {
                    threadName: `Refinery console ${options.runId}`,
                    participantNames: refineryCoralAgentNames,
                });
                threadId = thread.thread.id;
            }
            threadIds = [threadId];
            const seed = await puppetSendMessage({ apiUrl, authKey }, session, "refinery-evidence-auditor", {
                threadId,
                content: JSON.stringify(intake),
                mentions: ["refinery-claim-scout"],
            });
            rememberSeed(seed.message);
        }
        const close = async () => {
            if (closed)
                return;
            closed = true;
            if (session && sessionCreated && !coral.noTeardown) {
                await closeSession({ apiUrl, authKey }, session);
            }
            await stopStartedServer(child);
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
                },
                seededMessages,
                next: `Open ${buildConsoleUrl(apiUrl, "/ui/console")} and inspect namespace ${session.namespace}, session ${session.sessionId}.`,
            },
        };
    }
    catch (error) {
        if (session && sessionCreated && !coral.noTeardown) {
            await closeSession({ apiUrl, authKey }, session);
        }
        await stopStartedServer(child);
        throw applyErrorContext(asRefineryError(error, { code: "CORAL_CONSOLE_FAILED" }), {
            phase: "coral",
            runId: options.runId,
        });
    }
}
export async function runCoralReview(options) {
    const runDir = path.join(options.outputDir, options.runId);
    const createdAt = new Date().toISOString();
    const intent = options.packet.objective.intent;
    const request = options.packet.objective.request;
    const coral = options.coral ?? {};
    const topology = coral.topology ?? defaultReviewTopology;
    const apiUrl = coral.apiUrl ?? `http://localhost:${refineryCoralPort}`;
    const authKey = coral.authKey ?? refineryCoralAuthKey;
    const configPath = resolveRuntimeCoralConfigPath(coral.configPath ?? refineryCoralConfigPath);
    const startServer = coral.startServer ?? !coral.apiUrl;
    const serverMode = startServer ? "managed" : "attached";
    const namespace = coral.namespace ?? `refinery-${options.runId}`;
    const timeoutMs = coral.timeoutMs ?? defaultCoralReviewTimeoutMs(topology);
    const configuredModel = resolveConfiguredModel(coral);
    const logs = [];
    const readinessSnapshots = [];
    let child = null;
    let session = null;
    let threadId = null;
    let threadIds = [];
    let proposalThreadId = null;
    let critiqueThreadId = null;
    let sessionCreated = false;
    let threadCreated = false;
    let finalSnapshot = null;
    let specialistMessages = [];
    fs.mkdirSync(runDir, { recursive: true });
    try {
        const intake = buildReviewIntake({
            runId: options.runId,
            packet: options.packet,
            intent,
            request,
            topology,
        });
        writeJson(path.join(runDir, "input.json"), options.packet);
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
                coralPackage: coral.coralPackage ?? process.env.REFINERY_CORAL_PACKAGE ?? "coralos-dev@RC-1.2.0",
                logs,
            });
        }
        if (!(await waitForServer(apiUrl, authKey, 60_000))) {
            throw new RefineryError("CORAL_SERVER_UNREACHABLE", `Coral server was not reachable at ${apiUrl}.`, { phase: "coral", runId: options.runId, runDir });
        }
        const registry = [];
        for (const agentName of refineryCoralAgentNames) {
            try {
                await getLocalAgent({ apiUrl, authKey }, agentName);
                registry.push({ agentName, ok: true });
            }
            catch (error) {
                registry.push({ agentName, ok: false, error: error.message });
                throw new RefineryError("CORAL_AGENT_REGISTRY_MISSING", `Coral registry missing ${agentName}: ${error.message}`, { phase: "coral", runId: options.runId, runDir, details: registry });
            }
        }
        if (coral.sessionId) {
            session = { namespace, sessionId: coral.sessionId };
        }
        else {
            session = await createSession({ apiUrl, authKey }, buildCoralSessionRequest({
                namespace,
                runId: options.runId,
                modelName: configuredModel.modelName,
                modelBaseUrl: configuredModel.baseUrl,
                reasoningEffort: configuredModel.reasoningEffort,
                maxTurns: coral.maxTurns ?? process.env.REFINERY_CORAL_MAX_TURNS ?? (topology === "debate-critique" ? "3" : "2"),
                ttlMs: Math.max(timeoutMs + 60_000, 180_000),
                holdAfterExitMs: Math.max(timeoutMs + 60_000, 180_000),
            }));
            sessionCreated = true;
        }
        const ready = await waitForAgentsReady({ apiUrl, authKey }, session, refineryCoralAgentNames, (snapshot) => recordReadinessSnapshot(readinessSnapshots, snapshot), { timeoutMs: 90_000, intervalMs: DEFAULT_WAIT_INTERVAL_MS });
        if (!ready.ok) {
            throw new RefineryError("CORAL_AGENTS_NOT_READY", `Agents did not reach readiness. stopped=${ready.stopped.join(",") || "none"}`, { phase: "coral", runId: options.runId, runDir, details: ready.snapshot });
        }
        if (topology === "debate-critique") {
            if (coral.threadId) {
                proposalThreadId = coral.threadId;
            }
            else {
                const proposalThread = await puppetCreateThread({ apiUrl, authKey }, session, "refinery-claim-scout", {
                    threadName: `Refinery review ${options.runId} proposal`,
                    participantNames: refineryCoralAgentNames,
                });
                proposalThreadId = proposalThread.thread.id;
                threadCreated = true;
            }
            threadId = proposalThreadId;
            threadIds = [proposalThreadId];
            await puppetSendMessage({ apiUrl, authKey }, session, "refinery-evidence-auditor", {
                threadId: proposalThreadId,
                content: JSON.stringify({ ...intake, phase: "proposal-intake" }),
                mentions: ["refinery-claim-scout"],
            });
            const claimScoutPoll = await pollReviewOutputs({
                apiUrl,
                authKey,
                session,
                threadIds,
                runId: options.runId,
                timeoutMs,
                readinessSnapshots,
                topology,
                complete: (messages) => Boolean(findMessage({ messages, step: "claim-scout", threadId: proposalThreadId, phase: "candidate-proposal" })),
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
                throw new RefineryError("CORAL_REVIEW_INCOMPLETE", "Debate/critique review did not emit claim scout candidates before claim critique.", { phase: "coral", runId: options.runId, runDir, details: { specialistMessages } });
            }
            const claimCards = claimCardsForCritique({
                runId: options.runId,
                claimScoutOutput: claimScoutMessage.output,
            });
            const critiqueThread = await puppetCreateThread({ apiUrl, authKey }, session, "refinery-evidence-auditor", {
                threadName: `Refinery review ${options.runId} claim critique`,
                participantNames: refineryCoralAgentNames,
            });
            critiqueThreadId = critiqueThread.thread.id;
            threadCreated = true;
            threadIds = [proposalThreadId, critiqueThreadId];
            await puppetSendMessage({ apiUrl, authKey }, session, "refinery-claim-scout", {
                threadId: critiqueThreadId,
                content: JSON.stringify({
                    ...intake,
                    phase: "critique-intake",
                    claim_cards: claimCards,
                    context: {
                        source_chunks: options.packet.derivedViews.source_chunks,
                        active_memory_hints: options.packet.derivedViews.active_memory_hints,
                        review_intent: intent,
                        review_request: request,
                        intent_description: describeReviewIntent(intent),
                        topology,
                        phase: "critique-intake",
                        claim_cards: claimCards,
                    },
                }),
                mentions: ["refinery-evidence-auditor"],
            });
            const branches = await pollReviewOutputs({
                apiUrl,
                authKey,
                session,
                threadIds,
                runId: options.runId,
                timeoutMs,
                readinessSnapshots,
                topology,
                complete: (messages) => debateBranchesComplete(messages, proposalThreadId, critiqueThreadId),
            });
            finalSnapshot = branches.snapshot;
            specialistMessages = branches.specialistMessages;
            const branchFailure = specialistMessages.find((message) => message.status === "failed");
            if (branchFailure) {
                writeSpecialistStepArtifacts(runDir, specialistMessages, topology);
                throw failedSpecialistError({ runDir, runId: options.runId, message: branchFailure });
            }
            if (!debateBranchesComplete(specialistMessages, proposalThreadId, critiqueThreadId)) {
                throw new RefineryError("CORAL_REVIEW_INCOMPLETE", "Debate/critique branches did not emit required proposal and critique outputs before merge.", { phase: "coral", runId: options.runId, runDir, details: { specialistMessages } });
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
                throw new RefineryError("CORAL_REVIEW_INCOMPLETE", "Debate/critique merge inputs were missing after branch completion.", { phase: "coral", runId: options.runId, runDir, details: { proposalEditorMessage, evidenceAudit } });
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
                context: {
                    source_chunks: options.packet.derivedViews.source_chunks,
                    active_memory_hints: options.packet.derivedViews.active_memory_hints,
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
            await puppetSendMessage({ apiUrl, authKey }, session, "refinery-proposal-editor", {
                threadId: proposalThreadId,
                content: JSON.stringify(merge),
                mentions: ["refinery-decision-synthesizer"],
            });
            const final = await pollReviewOutputs({
                apiUrl,
                authKey,
                session,
                threadIds,
                runId: options.runId,
                timeoutMs,
                readinessSnapshots,
                topology,
                complete: (messages) => debateFinalComplete(messages, proposalThreadId, critiqueThreadId),
            });
            finalSnapshot = final.snapshot;
            specialistMessages = final.specialistMessages;
        }
        else {
            if (coral.threadId) {
                threadId = coral.threadId;
            }
            else {
                const thread = await puppetCreateThread({ apiUrl, authKey }, session, "refinery-claim-scout", {
                    threadName: `Refinery review ${options.runId}`,
                    participantNames: refineryCoralAgentNames,
                });
                threadId = thread.thread.id;
                threadCreated = true;
            }
            threadIds = [threadId];
            await puppetSendMessage({ apiUrl, authKey }, session, "refinery-evidence-auditor", {
                threadId,
                content: JSON.stringify(intake),
                mentions: ["refinery-claim-scout"],
            });
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
        const missingSteps = reviewStepOrder.filter((step) => !byStep.has(step));
        if (missingSteps.length > 0) {
            throw new RefineryError("CORAL_REVIEW_INCOMPLETE", `Coral review did not emit all specialist outputs. Missing: ${missingSteps.join(", ")}`, { phase: "coral", runId: options.runId, runDir, details: { missingSteps, specialistMessages } });
        }
        const decisionSynthesis = byStep.get("decision-synthesizer");
        if (!decisionSynthesis)
            throw new Error("Missing decision-synthesizer output.");
        const parsedDecision = parseDecisionSynthesizerOutput(options.runId, decisionSynthesis.output ?? {});
        parsedDecision.proposals = parsedDecision.proposals.map((proposal) => ({
            ...proposal,
            intent,
        }));
        const evidenceReview = byStep.get("evidence-auditor")?.output ?? { findings: [] };
        const deliberation = buildDeliberationArtifacts({
            runId: options.runId,
            topology,
            messages: toDeliberationMessages(specialistMessages),
        });
        writeJson(path.join(runDir, "claims.json"), deliberation.claims);
        writeJson(path.join(runDir, "challenge-ledger.json"), deliberation.challengeLedger);
        writeJson(path.join(runDir, "deliberation.json"), deliberation);
        writeJson(path.join(runDir, "proposals.json"), parsedDecision.proposals);
        writeJson(path.join(runDir, "rejected.json"), parsedDecision.rejected);
        const shouldWriteSkillCandidates = options.packet.targets.includes("codex:skills") ||
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
            topologyDesign: topology === "debate-critique" ? "claim-centered-interruptible" : "pipeline",
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
        const metadata = {
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
            specialistOrder: topology === "debate-critique"
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
        const manifestMetadata = metadata;
        const result = {
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
        if (!options.sink)
            return result;
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
    }
    catch (error) {
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
    }
    finally {
        if (logs.length > 0)
            fs.writeFileSync(path.join(runDir, "server.log"), `${logs.join("\n")}\n`);
        if (session && sessionCreated && !coral.noTeardown)
            await closeSession({ apiUrl, authKey }, session);
        await stopStartedServer(child);
    }
}
//# sourceMappingURL=review-conductor.js.map