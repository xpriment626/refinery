import { loadLocalEnv, parseModelMaxTokens, redactModelBaseUrl } from "../env.js";
import { parseClaimScout, parseDecisionSynthesizer, parseEvidenceFindings, parseProposalEditor, buildPrompt, redactModel, } from "../core/live-review.js";
import { refineryReviewSchemaVersion } from "../core/types.js";
import { claimScoutSpecialist, decisionSynthesizerSpecialist, evidenceAuditorSpecialist, memoryCartographerSpecialist, proposalEditorSpecialist, } from "../core/specialists/index.js";
import { callCoralChatWithMetadata } from "../core/model-client.js";
import { resolveModelApiKey } from "../core/credentials.js";
import { getCoralAgentBySpecialistName, getSpecialistNameArg, refineryCoralAgentNames, refineryCoralProxyRequestName, refineryCoralModelDefaults, } from "./definitions.js";
import { connectCoralMcp, parseWaitForMentionResult, readCoralState } from "./mcp.js";
import { defaultReviewTopology, isReviewTopology } from "./topology.js";
const coralSpecialistPromptVersion = "refinery.coral-specialist-prompt.v1";
function readEnv(name, localEnv) {
    return process.env[name] ?? localEnv[name];
}
export function loadWorkerModelConfig(cwd = process.cwd()) {
    const localEnv = loadLocalEnv(cwd);
    const proxyUrl = readEnv(`CORAL_PROXY_URL_${refineryCoralProxyRequestName}`, localEnv);
    const proxyModel = readEnv(`CORAL_PROXY_MODEL_${refineryCoralProxyRequestName}`, localEnv);
    if (proxyUrl) {
        return {
            provider: "coral",
            modelName: proxyModel ?? readEnv("MODEL_NAME", localEnv) ?? refineryCoralModelDefaults.modelName,
            baseUrl: `${proxyUrl.replace(/\/$/, "")}/v1`,
            apiKey: "",
            authMode: "coral-agent-proxy",
            reasoningEffort: readEnv("REASONING_EFFORT", localEnv) ?? refineryCoralModelDefaults.reasoningEffort,
            maxTokens: parseModelMaxTokens(readEnv("MODEL_MAX_TOKENS", localEnv) ?? readEnv("REFINERY_MODEL_MAX_TOKENS", localEnv)),
            apiKeyPresent: true,
        };
    }
    const modelAuth = resolveModelApiKey({
        env: process.env,
        localEnv,
        cwd,
    });
    return {
        provider: "coral",
        modelName: readEnv("MODEL_NAME", localEnv) ?? readEnv("REFINERY_MODEL_NAME", localEnv) ?? refineryCoralModelDefaults.modelName,
        baseUrl: readEnv("MODEL_BASE_URL", localEnv) ?? readEnv("REFINERY_MODEL_BASE_URL", localEnv) ?? refineryCoralModelDefaults.baseUrl,
        apiKey: modelAuth.apiKey,
        authMode: "bearer",
        reasoningEffort: readEnv("REASONING_EFFORT", localEnv) ?? refineryCoralModelDefaults.reasoningEffort,
        maxTokens: parseModelMaxTokens(readEnv("MODEL_MAX_TOKENS", localEnv) ?? readEnv("REFINERY_MODEL_MAX_TOKENS", localEnv)),
        apiKeyPresent: Boolean(modelAuth.apiKey),
    };
}
function log(agentName, message) {
    console.log(`[${new Date().toISOString()}] [${agentName}] ${message}`);
}
function parseMaxTurns() {
    const raw = process.env.REFINERY_CORAL_MAX_TURNS ?? "2";
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}
export function isCoralWaitTimeout(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /request timed out|timeout of .* occurred waiting|timed out/i.test(message);
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function parseMessageEnvelope(text) {
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
            runId: parsed.runId,
            sequence: parsed.sequence.filter((item) => typeof item === "string"),
            index: parsed.index,
            nextAgent: typeof parsed.nextAgent === "string" ? parsed.nextAgent : null,
        };
    }
    catch {
        return null;
    }
}
function parseReviewEnvelope(text) {
    try {
        const parsed = JSON.parse(text);
        if (!isRecord(parsed))
            return null;
        if (parsed.type !== "refinery-review-intake" &&
            parsed.type !== "refinery-review-output" &&
            parsed.type !== "refinery-review-merge")
            return null;
        if (typeof parsed.runId !== "string")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function topologyFrom(envelope) {
    return isReviewTopology(envelope.topology) ? envelope.topology : defaultReviewTopology;
}
function phaseFrom(envelope) {
    return typeof envelope.phase === "string" ? envelope.phase : null;
}
function outputPhaseFor(args) {
    if (args.topology === "sparse-blackboard") {
        switch (args.specialistName) {
            case "claim-scout": return "topic-claim";
            case "memory-cartographer": return "overlap-cartography";
            case "evidence-auditor": return "risk-audit";
            case "proposal-editor": return "survivor-proposal";
            case "decision-synthesizer": return "candidate-synthesis";
        }
    }
    if (args.topology !== "debate-critique")
        return "pipeline";
    const incomingPhase = phaseFrom(args.envelope);
    switch (args.specialistName) {
        case "claim-scout":
            return "candidate-proposal";
        case "memory-cartographer":
            return "memory-cartography";
        case "evidence-auditor":
            return incomingPhase === "critique-intake" ? "preflight-critique" : "evidence-review";
        case "proposal-editor":
            return "typed-proposal";
        case "decision-synthesizer":
            return "proposal-synthesis";
    }
}
function contextFrom(envelope) {
    const base = isRecord(envelope.context)
        ? envelope.context
        : {
            source_chunks: Array.isArray(envelope.source_chunks) ? envelope.source_chunks : [],
            active_memory_hints: Array.isArray(envelope.active_memory_hints) ? envelope.active_memory_hints : [],
            responsibility_plan: isRecord(envelope.responsibility_plan) ? envelope.responsibility_plan : null,
            graph_context: Array.isArray(envelope.graph_context) ? envelope.graph_context : [],
            target_surfaces: Array.isArray(envelope.target_surfaces) ? envelope.target_surfaces : [],
            source_sets: Array.isArray(envelope.source_sets) ? envelope.source_sets : [],
        };
    return {
        ...base,
        topology: topologyFrom(envelope),
        phase: phaseFrom(envelope),
        review_intent: typeof envelope.intent === "string"
            ? envelope.intent
            : typeof base.review_intent === "string"
                ? base.review_intent
                : "general-review",
        review_request: typeof envelope.request === "string"
            ? envelope.request
            : typeof base.review_request === "string"
                ? base.review_request
                : null,
        intent_description: typeof envelope.intentDescription === "string"
            ? envelope.intentDescription
            : typeof base.intent_description === "string"
                ? base.intent_description
                : null,
        claim_cards: Array.isArray(envelope.claim_cards)
            ? envelope.claim_cards
            : Array.isArray(base.claim_cards)
                ? base.claim_cards
                : [],
        target_surfaces: Array.isArray(envelope.target_surfaces)
            ? envelope.target_surfaces
            : Array.isArray(base.target_surfaces)
                ? base.target_surfaces
                : [],
        source_sets: Array.isArray(envelope.source_sets)
            ? envelope.source_sets
            : Array.isArray(base.source_sets)
                ? base.source_sets
                : [],
        responsibility_plan: isRecord(base.responsibility_plan)
            ? base.responsibility_plan
            : isRecord(envelope.responsibility_plan)
                ? envelope.responsibility_plan
                : null,
        graph_context: Array.isArray(base.graph_context)
            ? base.graph_context
            : Array.isArray(envelope.graph_context)
                ? envelope.graph_context
                : [],
    };
}
function arrayFrom(record, field) {
    const value = record[field];
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => isRecord(item));
}
function nextReviewAgent(agentName) {
    const index = refineryCoralAgentNames.indexOf(agentName);
    return index >= 0 ? refineryCoralAgentNames[index + 1] ?? null : null;
}
export function expectedReviewAgent(envelope, senderName) {
    if (envelope.type === "refinery-review-intake") {
        if (topologyFrom(envelope) === "sparse-blackboard") {
            switch (phaseFrom(envelope)) {
                case "overlap-cartography-intake": return "refinery-memory-cartographer";
                case "risk-audit-intake": return "refinery-evidence-auditor";
                case "survivor-proposal-intake": return "refinery-proposal-editor";
                default: return "refinery-claim-scout";
            }
        }
        return topologyFrom(envelope) === "debate-critique" && phaseFrom(envelope) === "critique-intake"
            ? "refinery-evidence-auditor"
            : "refinery-claim-scout";
    }
    if (envelope.type === "refinery-review-merge")
        return "refinery-decision-synthesizer";
    return nextReviewAgent(String(envelope.agent ?? senderName));
}
function nextReviewMentions(outputEnvelope, currentAgent) {
    const topology = topologyFrom(outputEnvelope);
    if (topology === "sparse-blackboard")
        return [];
    if (topology !== "debate-critique") {
        const next = nextReviewAgent(currentAgent);
        return next ? [next] : [];
    }
    switch (phaseFrom(outputEnvelope)) {
        case "candidate-proposal":
            return ["refinery-memory-cartographer"];
        case "memory-cartography":
            return ["refinery-proposal-editor"];
        case "typed-proposal":
            return [];
        case "preflight-critique":
            return [];
        case "proposal-synthesis":
            return [];
        default: {
            const next = nextReviewAgent(currentAgent);
            return next ? [next] : [];
        }
    }
}
function specialistForName(name) {
    switch (name) {
        case "claim-scout":
            return claimScoutSpecialist;
        case "memory-cartographer":
            return memoryCartographerSpecialist;
        case "evidence-auditor":
            return evidenceAuditorSpecialist;
        case "proposal-editor":
            return proposalEditorSpecialist;
        case "decision-synthesizer":
            return decisionSynthesizerSpecialist;
    }
}
function outputShapeForSpecialist(name) {
    switch (name) {
        case "claim-scout":
            return `{"candidates":[{"claim":"...","source_refs":[],"why_future_useful":"..."}]}`;
        case "memory-cartographer":
        case "evidence-auditor":
            return `{"findings":[{"body":"...","relation":"novel","target_memory_id":null,"confidence":0.8,"rationale":"...","source_refs":[],"memory_refs":[{"memory_id":"memory:1","provenance_kind":"fixture"}]}]}`;
        case "proposal-editor":
            return `{"typed":[{"body":"...","memory_type":"semantic","primary_type":"semantic","secondary_type":null,"type_confidence":0.8,"type_rationale":"...","ambiguities":[],"durability":"durable","ttl":null,"proposed_scope":"project","action":"create","target_memory_id":null,"target_memory_ids":[],"source_refs":[]}]}`;
        case "decision-synthesizer":
            return `{"proposals":[{"memory_type":"semantic","proposed_scope":"project","body":"...","confidence":0.8,"rationale":"...","source_refs":[],"action":"create","target_memory_id":null,"target_memory_ids":[],"staleness_reason":null,"forget_reason":null,"update_reason":null,"conflict_reason":null,"scope_reason":null,"replacement_body":null,"ambiguities":[]}],"rejected":[{"body":"...","reason":"..."}],"skillCandidates":{"candidates":[{"name":"example-skill","trigger":"Use when ...","evidenceRefs":[],"existingSkillRefs":[],"skillMdOutline":["frontmatter","workflow"],"skillMdDraft":"---\\nname: example-skill\\ndescription: Use when ...\\n---\\n# Example Skill\\n","rationale":"...","confidence":0.8}],"rejected":[],"unresolved":[]}}`;
    }
}
function instructionForSpecialist(name) {
    switch (name) {
        case "claim-scout":
            return "Emit at most three durable, evidence-bound candidate memories. Prefer fewer high-signal candidates over broad extraction.";
        case "memory-cartographer":
            return "Classify each claim exactly once against active-memory candidates. memory_refs must be objects, never bare strings.";
        case "evidence-auditor":
            return "Audit each claim card exactly once. Prefer challenge relations for duplicate, weak, stale, unsupported, or scope-risk claims; use novel only when the evidence and memory context justify endorsement.";
        case "proposal-editor":
            return "Use project scope for this slice. Set memory_type equal to primary_type. Preserve source_refs and target_memory_id from cartography when applicable. For merge or supersede across multiple memories, set target_memory_id to the primary target and target_memory_ids to the full list.";
        case "decision-synthesizer":
            return "Emit proposal-shaped records only for durable future-useful candidates that survive critique. Include rejected[] for filtered memory candidates and every rejected item must include reason. Use canonical action enum values only; include intent-specific rationale fields when relevant and null otherwise. For multi-target merge or supersede proposals, preserve target_memory_ids and put the primary target in target_memory_id. When target_surfaces includes codex:skills or the intent is skill-promotion-audit, also emit skillCandidates with candidates, rejected, and unresolved arrays.";
    }
}
function intentInstruction(context) {
    const intent = typeof context.review_intent === "string" ? context.review_intent : "general-review";
    const request = typeof context.review_request === "string" && context.review_request.trim()
        ? ` User request: ${context.review_request.trim()}`
        : "";
    switch (intent) {
        case "stale-audit":
            return `Intent guidance: this is a stale audit. Treat active_memory_hints as primary audit targets, use source_chunks as evidence, and prefer update, archive, supersede, ttl_update, or contradiction_review over create when a memory appears outdated, misleading, or over-broad. If no stale target is supported, reject rather than inventing unrelated new memory.${request}`;
        case "forget-candidates":
            return `Intent guidance: identify active memories that may be obsolete, redundant, too noisy, or low-value. Prefer archive, quarantine, merge, demote, or ttl_update proposals with explicit target_memory_id. If evidence is insufficient, reject.${request}`;
        case "update-candidates":
            return `Intent guidance: identify active memories that remain useful but need refreshed wording, replacement body, corrected scope, or newer evidence. Prefer update, supersede, retag, or ttl_update and include replacement_body when useful.${request}`;
        case "conflict-audit":
            return `Intent guidance: identify contradictions between active memories and source evidence. Prefer contradiction_review, update, or supersede with clear evidence refs and target_memory_id.${request}`;
        case "scope-audit":
            return `Intent guidance: identify memories whose scope is too broad, too narrow, or attached to the wrong project/user/org context. Prefer retag, update, demote, or promote with scope_reason.${request}`;
        case "general-review":
            return `Intent guidance: perform a general dry-run memory review and emit only evidence-backed proposals.${request}`;
        case "session-recurrence":
            return `Intent guidance: identify recurring Codex session topics, workflows, failures, or preferences that are durable enough to propose as memory. Prefer create/update memory proposals grounded in session summaries; reject one-off transcript noise.${request}`;
        case "memory-gap-audit":
            return `Intent guidance: compare session summaries and current memories. Propose memory updates or creates only for gaps that are clearly supported by session evidence and absent or under-specified in active_memory_hints.${request}`;
        case "skill-promotion-audit":
            return `Intent guidance: identify repeated workflows or memory clusters that should become reusable Codex skills. Emit skillCandidates.candidates with name, trigger, evidenceRefs, existingSkillRefs, skillMdOutline, skillMdDraft, rationale, and confidence. Use memory proposals only for durable memory changes; use skillCandidates.rejected and skillCandidates.unresolved for weak or ambiguous skill ideas.${request}`;
        default:
            return `Intent guidance: perform a dry-run memory review for intent ${intent} and emit only evidence-backed proposals.${request}`;
    }
}
function evidenceBoundaryInstruction() {
    return [
        "Treat review_request as a hard relevance constraint: if the selected source chunks do not directly support the requested subject, emit an empty candidate/proposal array rather than substituting a different durable fact.",
        "Only source_chunks may support a new memory claim; active_memory_hints may be used only to compare or target existing memory.",
        "A recurring-workflow claim requires selected source refs from at least two independent session ids unless the chunks contain an explicit decision, invariant, or reproducible failure that independently establishes durability.",
        "Honor source chunk truncation metadata. If omitted context could change the claim, mark it too_weak or return no candidate.",
        "Novelty means absent retrieval behavior; contradiction means incompatible behavior; supersession requires evidence that a newer decision replaces an exact prior target.",
        "responsibility_plan, graph_context, coral_runtime_projection, and coral_thread_context are control metadata, not admissible memory evidence. Never cite their fields as source_refs or turn runtime attachment state into a memory claim.",
    ].join(" ");
}
function topologyInstructionForSpecialist(args) {
    if (args.topology === "sparse-blackboard") {
        switch (args.phase) {
            case "topic-claim":
                return "Topology guidance: inspect only this topic's selected source chunks. Emit durable claims with exact source references; do not broaden into sleeping topics or ask other agents to bid for work.";
            case "overlap-cartography":
                return "Topology guidance: the app-owned blackboard detected material active-memory overlap. Classify only duplicate, refinement, contradiction, or supersession relationships supported by the supplied candidates and memory hints.";
            case "risk-audit":
                return "Topology guidance: the app-owned blackboard woke this audit only for weak, conflicting, truncated, or high-impact claims. Validate provenance and future value; mark unsupported or one-off claims too_weak.";
            case "survivor-proposal":
                return "Topology guidance: edit only candidates that survived deterministic routing and optional review. Preserve source references and do not resurrect duplicate or too_weak claims.";
            case "candidate-synthesis":
                return "Topology guidance: synthesize only typed candidates or explicit specialist disagreement from the app-owned blackboard. Emit no unsupported final proposal.";
            default:
                return "Topology guidance: follow app-owned sparse routing and remain idle unless mentioned.";
        }
    }
    if (args.topology !== "debate-critique")
        return "";
    switch (args.phase) {
        case "candidate-proposal":
            return "Topology guidance: this is the Claim Scout phase of the default debate-critique run. Produce source-grounded claims that can become claim cards. Keep each claim durable, evidence-bound, and suitable for local critique.";
        case "memory-cartography":
            return "Topology guidance: this is the Memory Cartographer phase. Map claim cards/candidates to nearby active memories, duplicate targets, supersession targets, and conflicts. Leave final acceptance to debate-critique synthesis.";
        case "preflight-critique":
            return "Topology guidance: this is the Evidence/Provenance Auditor local critique thread. Treat claim_cards as the deliberation unit. For each claim card, make one small structured move using the findings JSON shape: novel is an endorsement; duplicate, too_weak, contradiction, refinement, and supersession are challenges. Ground each challenge in source or active-memory evidence and avoid broad global debate.";
        case "typed-proposal":
            return "Topology guidance: this is the Proposal Editor phase. Turn surviving claims and cartography into typed proposal packets. Preserve evidence so final challenges can target the claim precisely. If cartography shows every claim is duplicate or too_weak, emit {\"typed\":[]} rather than restating rejected claims.";
        case "proposal-synthesis":
            return "Topology guidance: this is the Decision Synthesizer merge point. Synthesize typed claims together with debate_critique.claim_cards and debate_critique.challenge_ledger. Final proposal or rejection rationale must explicitly account for relevant challenges, endorsements, or unresolved questions.";
        default:
            return `Topology guidance: debate/critique phase ${args.phase}. Keep reasoning evidence-bound and do not write memory.`;
    }
}
function compactMemoryHints(value, limit = 10) {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, limit);
}
function claimCards(context) {
    return arrayFrom(context, "claim_cards");
}
function activeMemoryCandidates(context, proposalOutput) {
    const proposals = arrayFrom(proposalOutput, "proposals");
    const memories = compactMemoryHints(context.active_memory_hints, 8);
    return proposals.map((proposal, proposalIndex) => ({
        proposal_index: proposalIndex,
        proposal_body: typeof proposal.body === "string" ? proposal.body : null,
        memories,
    }));
}
function preflightMemoryCandidates(context) {
    const claims = claimCards(context);
    if (claims.length > 0) {
        const memories = compactMemoryHints(context.active_memory_hints, 10);
        return claims.map((claim, index) => ({
            claim_id: typeof claim.claimId === "string" ? claim.claimId : `claim:${index + 1}`,
            proposal_index: index,
            proposal_body: typeof claim.body === "string" ? claim.body : null,
            source_refs: Array.isArray(claim.sourceRefs) ? claim.sourceRefs : [],
            memories,
        }));
    }
    return compactMemoryHints(context.active_memory_hints, 10).map((memory, index) => ({
        proposal_index: index,
        proposal_body: isRecord(memory) && typeof memory.body === "string" ? memory.body : null,
        memories: [memory],
    }));
}
function referencedMemoryIds(findings) {
    const ids = new Set();
    for (const finding of findings) {
        if (typeof finding.target_memory_id === "string" || typeof finding.target_memory_id === "number") {
            ids.add(String(finding.target_memory_id));
        }
        if (!Array.isArray(finding.memory_refs))
            continue;
        for (const ref of finding.memory_refs) {
            if (!isRecord(ref))
                continue;
            if (typeof ref.memory_id === "string" || typeof ref.memory_id === "number") {
                ids.add(String(ref.memory_id));
            }
        }
    }
    return ids;
}
function referencedActiveMemoryHints(context, findings) {
    const ids = referencedMemoryIds(findings);
    if (ids.size === 0 || !Array.isArray(context.active_memory_hints))
        return [];
    return context.active_memory_hints.filter((memory) => {
        if (!isRecord(memory))
            return false;
        if (typeof memory.id !== "string" && typeof memory.id !== "number")
            return false;
        return ids.has(String(memory.id));
    });
}
function sourceReferenceIds(value) {
    if (typeof value === "string" && value.trim())
        return [value.trim()];
    if (!isRecord(value))
        return [];
    return ["source_id", "sourceId", "graph_node_id", "graphNodeId", "source_uri", "sourceUri", "uri"]
        .flatMap((key) => {
        const candidate = value[key];
        return typeof candidate === "string" && candidate.trim() ? [candidate.trim()] : [];
    });
}
function referencedSourceChunks(context, findings) {
    const referencedIds = new Set();
    for (const finding of findings) {
        if (!Array.isArray(finding.source_refs))
            continue;
        for (const ref of finding.source_refs) {
            for (const id of sourceReferenceIds(ref))
                referencedIds.add(id);
        }
    }
    if (referencedIds.size === 0 || !Array.isArray(context.source_chunks))
        return [];
    return context.source_chunks.filter((chunk) => {
        if (!isRecord(chunk))
            return false;
        if (sourceReferenceIds(chunk.id).some((id) => referencedIds.has(id)))
            return true;
        if (sourceReferenceIds(chunk.uri).some((id) => referencedIds.has(id)))
            return true;
        return Array.isArray(chunk.refs)
            && chunk.refs.some((ref) => sourceReferenceIds(ref).some((id) => referencedIds.has(id)));
    });
}
function mergeProposalEditorOutput(envelope) {
    return isRecord(envelope.proposal_editor_output) ? envelope.proposal_editor_output : {};
}
function critiqueBundle(envelope, context) {
    if (isRecord(envelope.critique))
        return envelope.critique;
    return isRecord(context.debate_critique) ? context.debate_critique : null;
}
function coralThreadContext(args) {
    return {
        threadId: args.message.threadId,
        receivedMessageId: args.message.id,
        senderName: args.message.senderName,
        mentionNames: args.message.mentionNames,
        previousAgent: typeof args.envelope.agent === "string" ? args.envelope.agent : args.message.senderName,
        previousStep: typeof args.envelope.step === "string" ? args.envelope.step : null,
    };
}
function payloadForSpecialist(args) {
    const context = contextFrom(args.envelope);
    const topology = topologyFrom(args.envelope);
    const phase = phaseFrom(args.envelope);
    const intentContext = {
        review_intent: context.review_intent,
        review_request: context.review_request,
        intent_description: context.intent_description,
        topology,
        phase,
        target_surfaces: context.target_surfaces,
        source_sets: context.source_sets,
        responsibility_plan: context.responsibility_plan,
        graph_context: context.graph_context,
    };
    const previousOutput = isRecord(args.envelope.output) ? args.envelope.output : {};
    const threadContext = coralThreadContext({ message: args.message, envelope: args.envelope });
    switch (args.specialistName) {
        case "claim-scout":
            return {
                context,
                payload: {
                    ...intentContext,
                    source_chunks: Array.isArray(context.source_chunks) ? context.source_chunks : [],
                    active_memory_hints: compactMemoryHints(context.active_memory_hints),
                    target_surfaces: context.target_surfaces,
                    source_sets: context.source_sets,
                    coral_thread_context: threadContext,
                },
            };
        case "memory-cartographer":
            const cartographyCandidates = arrayFrom(previousOutput, "candidates").length > 0
                ? arrayFrom(previousOutput, "candidates")
                : arrayFrom(context, "claim_candidates");
            return {
                context: {
                    ...context,
                    claim_candidates: cartographyCandidates,
                },
                payload: {
                    ...intentContext,
                    candidates: cartographyCandidates,
                    active_memory_hints: compactMemoryHints(context.active_memory_hints),
                    target_surfaces: context.target_surfaces,
                    source_sets: context.source_sets,
                    coral_thread_context: threadContext,
                },
            };
        case "proposal-editor":
            const findings = arrayFrom(previousOutput, "findings");
            return {
                context,
                payload: {
                    ...intentContext,
                    claim_cards: claimCards(context),
                    candidates: arrayFrom(context, "claim_candidates"),
                    cartography_findings: findings,
                    active_memory_hints: referencedActiveMemoryHints(context, findings),
                    target_surfaces: context.target_surfaces,
                    source_sets: context.source_sets,
                    coral_thread_context: threadContext,
                },
            };
        case "decision-synthesizer":
            if ((topology === "debate-critique" || topology === "sparse-blackboard")
                && args.envelope.type === "refinery-review-merge") {
                return {
                    context: {
                        ...context,
                        debate_critique: critiqueBundle(args.envelope, context),
                    },
                    payload: {
                        ...intentContext,
                        typed: arrayFrom(mergeProposalEditorOutput(args.envelope), "typed"),
                        debate_critique: critiqueBundle(args.envelope, context),
                        claim_cards: claimCards(context),
                        target_surfaces: context.target_surfaces,
                        source_sets: context.source_sets,
                        coral_thread_context: threadContext,
                    },
                };
            }
            return {
                context,
                payload: {
                    ...intentContext,
                    typed: arrayFrom(previousOutput, "typed"),
                    target_surfaces: context.target_surfaces,
                    source_sets: context.source_sets,
                    coral_thread_context: threadContext,
                },
            };
        case "evidence-auditor":
            if ((topology === "debate-critique" && phase === "critique-intake")
                || (topology === "sparse-blackboard" && phase === "risk-audit-intake")) {
                return {
                    context,
                    payload: {
                        ...intentContext,
                        claim_cards: claimCards(context),
                        source_chunks: Array.isArray(context.source_chunks) ? context.source_chunks : [],
                        active_memory_candidates: preflightMemoryCandidates(context),
                        target_surfaces: context.target_surfaces,
                        source_sets: context.source_sets,
                        coral_thread_context: threadContext,
                    },
                };
            }
            return {
                context,
                payload: {
                    ...intentContext,
                    proposal_synthesis: previousOutput,
                    source_chunks: referencedSourceChunks(context, arrayFrom(previousOutput, "findings")),
                    active_memory_candidates: activeMemoryCandidates(context, previousOutput),
                    debate_critique: critiqueBundle(args.envelope, context),
                    claim_cards: claimCards(context),
                    target_surfaces: context.target_surfaces,
                    source_sets: context.source_sets,
                    coral_thread_context: threadContext,
                },
            };
    }
}
function parseSpecialistOutput(name, raw) {
    switch (name) {
        case "claim-scout":
            return parseClaimScout(raw);
        case "memory-cartographer":
        case "evidence-auditor":
            return parseEvidenceFindings(raw);
        case "proposal-editor":
            return parseProposalEditor(raw);
        case "decision-synthesizer":
            return parseDecisionSynthesizer(raw);
    }
}
function failureEnvelope(args) {
    return {
        schemaVersion: refineryReviewSchemaVersion,
        type: "refinery-review-output",
        status: "failed",
        runId: args.runId,
        topology: args.topology,
        phase: args.phase,
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
export async function buildLiveReviewEnvelope(args) {
    const runId = String(args.envelope.runId);
    const specialist = specialistForName(args.specialistName);
    const topology = topologyFrom(args.envelope);
    const phase = outputPhaseFor({ topology, specialistName: args.specialistName, envelope: args.envelope });
    const { payload, context } = payloadForSpecialist(args);
    const prompt = buildPrompt({
        specialist,
        shape: outputShapeForSpecialist(args.specialistName),
        instruction: [
            instructionForSpecialist(args.specialistName),
            intentInstruction(context),
            evidenceBoundaryInstruction(),
            topologyInstructionForSpecialist({ topology, phase, specialistName: args.specialistName }),
        ].filter(Boolean).join(" "),
        payload,
    });
    if (!args.model.apiKeyPresent) {
        return failureEnvelope({
            runId,
            step: args.specialistName,
            topology,
            phase,
            agentName: args.agentName,
            receivedMessageId: args.message.id,
            code: "MODEL_CONFIG_MISSING",
            message: "CORAL_API_KEY or stored Coral auth is required for live Coral specialist execution.",
            model: args.model,
            prompt,
        });
    }
    let rawOutput = "";
    let providerMetadata;
    try {
        const callModel = args.callModel ?? callCoralChatWithMetadata;
        const response = await callModel({
            model: args.model,
            system: prompt.system,
            user: prompt.user,
        });
        rawOutput = response.content;
        providerMetadata = response.metadata
            ? {
                ...response.metadata,
                baseUrl: redactModelBaseUrl({
                    baseUrl: response.metadata.baseUrl,
                    authMode: args.model.authMode,
                }),
            }
            : undefined;
    }
    catch (error) {
        return failureEnvelope({
            runId,
            step: args.specialistName,
            topology,
            phase,
            agentName: args.agentName,
            receivedMessageId: args.message.id,
            code: "MODEL_CALL_FAILED",
            message: error instanceof Error ? error.message : String(error),
            model: args.model,
            providerMetadata,
            prompt,
        });
    }
    let parsed;
    try {
        parsed = parseSpecialistOutput(args.specialistName, rawOutput);
    }
    catch (error) {
        return failureEnvelope({
            runId,
            step: args.specialistName,
            topology,
            phase,
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
        topology,
        phase,
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
async function main() {
    const specialistName = getSpecialistNameArg(process.argv.slice(2));
    const definition = getCoralAgentBySpecialistName(specialistName);
    const model = loadWorkerModelConfig();
    const coralConnectionUrl = process.env.CORAL_CONNECTION_URL;
    if (!coralConnectionUrl)
        throw new Error("CORAL_CONNECTION_URL is required for executable Coral agents");
    log(definition.agentName, `booted specialist=${definition.specialistName} session=${process.env.CORAL_SESSION_ID ?? "unknown"}`);
    log(definition.agentName, `model=${model.modelName} baseUrl=${redactModelBaseUrl(model)} reasoning=${model.reasoningEffort} apiKey=${model.apiKeyPresent ? "present" : "missing"}`);
    const connection = await connectCoralMcp(coralConnectionUrl, `refinery-${definition.specialistName}-worker`);
    log(definition.agentName, `mcp connected tools=${connection.toolNames.join(",")}`);
    try {
        const state = await readCoralState(connection.client);
        log(definition.agentName, `state readable=${isRecord(state) && !("error" in state) ? "yes" : "partial"}`);
    }
    catch (error) {
        log(definition.agentName, `state read failed: ${error.message}`);
    }
    let cursorMs = 0;
    let handled = 0;
    const handledIds = new Set();
    const maxTurns = parseMaxTurns();
    while (handled < maxTurns) {
        const beforeWait = Date.now();
        let waitResult;
        try {
            waitResult = await connection.client.callTool({
                name: connection.waitForMentionToolName,
                arguments: { currentUnixTime: cursorMs, maxWaitMs: 60_000 },
            });
        }
        catch (error) {
            if (isCoralWaitTimeout(error)) {
                cursorMs = beforeWait;
                log(definition.agentName, `wait_for_mention timed out; continuing idle wait`);
                continue;
            }
            log(definition.agentName, `wait_for_mention failed: ${error.message}`);
            await connection.client.close();
            process.exit(0);
        }
        cursorMs = beforeWait;
        const message = parseWaitForMentionResult(waitResult);
        if (!message)
            continue;
        if (handledIds.has(message.id))
            continue;
        handledIds.add(message.id);
        const reviewEnvelope = parseReviewEnvelope(message.text);
        if (reviewEnvelope) {
            const expectedAgent = expectedReviewAgent(reviewEnvelope, message.senderName);
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
            const mentions = outputEnvelope.status === "succeeded" ? nextReviewMentions(outputEnvelope, definition.agentName) : [];
            const content = JSON.stringify(outputEnvelope);
            await connection.client.callTool({
                name: connection.sendMessageToolName,
                arguments: {
                    threadId: message.threadId,
                    content,
                    mentions,
                },
            });
            log(definition.agentName, `review output sent status=${String(outputEnvelope.status)} phase=${String(outputEnvelope.phase ?? "none")} thread=${message.threadId} next=${mentions.join(",") || "none"}`);
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
        console.error(`[${new Date().toISOString()}] [${label}] FATAL: ${error.message}`);
        console.error(error);
        process.exit(1);
    });
}
//# sourceMappingURL=worker.js.map