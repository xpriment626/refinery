import crypto from "node:crypto";
import { refineryReviewSchemaVersion } from "./types.js";
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function records(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}
function normalized(text) {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function hashParts(parts) {
    const hash = crypto.createHash("sha256");
    for (const part of parts)
        hash.update(JSON.stringify(part)).update("\0");
    return hash.digest("hex").slice(0, 12);
}
function refKeys(refs) {
    return new Set(refs.map((ref) => JSON.stringify(ref)).filter((ref) => ref !== undefined));
}
function refsOverlap(left, right) {
    const keys = refKeys(left);
    return right.some((ref) => keys.has(JSON.stringify(ref)));
}
function tokenSet(text) {
    return new Set(normalized(text)
        .split(/[^a-z0-9:_/-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4));
}
function rowBody(row) {
    return stringValue(row.body) ?? stringValue(row.claim) ?? stringValue(row.proposal_body);
}
function rowSourceRefs(row) {
    return arrayValue(row.source_refs ?? row.sourceRefs);
}
function bodyMatchScore(claim, row) {
    const body = rowBody(row);
    if (!body)
        return 0;
    const claimBody = normalized(claim.body);
    const rowText = normalized(body);
    if (claimBody === rowText)
        return 100;
    if (claimBody.includes(rowText) || rowText.includes(claimBody))
        return 90;
    if (claimBody.slice(0, 80) && rowText.includes(claimBody.slice(0, 80)))
        return 80;
    const claimTokens = tokenSet(claimBody);
    const rowTokens = tokenSet(rowText);
    if (claimTokens.size === 0 || rowTokens.size === 0)
        return 0;
    let overlap = 0;
    for (const token of rowTokens) {
        if (claimTokens.has(token))
            overlap += 1;
    }
    const ratio = overlap / Math.min(claimTokens.size, rowTokens.size);
    if (ratio >= 0.6)
        return 70;
    if (ratio >= 0.35)
        return 45;
    if (ratio >= 0.2)
        return 20;
    return 0;
}
function findClaim(claims, row, index) {
    const refs = rowSourceRefs(row);
    const refMatches = refs.length > 0 ? claims.filter((claim) => refsOverlap(claim.sourceRefs, refs)) : [];
    const uniqueRefClaim = refMatches.length === 1 ? refMatches[0] : null;
    const scored = claims
        .map((claim) => {
        let score = bodyMatchScore(claim, row);
        const targets = targetMemoryRefs(row);
        if (targets.length > 0 && idsOverlap(claim.targetMemoryRefs, targets))
            score += 45;
        if (uniqueRefClaim?.claimId === claim.claimId)
            score += 15;
        if (typeof index === "number" && claim.claimId.endsWith(`:${index + 1}`))
            score += 8;
        return { claim, score };
    })
        .sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (!best || best.score <= 0)
        return null;
    const second = scored[1];
    if (second && best.score === second.score && best.score < 60)
        return null;
    return best.claim;
}
function relationToChallengeKind(relation) {
    switch (relation) {
        case "duplicate":
            return "duplicate";
        case "too_weak":
            return "evidence_gap";
        case "contradiction":
            return "conflict";
        case "refinement":
            return "scope_risk";
        case "supersession":
            return "staleness";
        default:
            return null;
    }
}
function memoryRefs(row) {
    return records(row.memory_refs).flatMap((ref) => {
        const memoryId = ref.memory_id;
        if (typeof memoryId !== "string" && typeof memoryId !== "number")
            return [];
        const provenanceKind = typeof ref.provenance_kind === "string" ? ref.provenance_kind : null;
        return [{ memory_id: memoryId, provenance_kind: provenanceKind }];
    });
}
function targetMemoryRefs(row) {
    if (Array.isArray(row.target_memory_ids)) {
        return row.target_memory_ids.filter((item) => typeof item === "string" || typeof item === "number");
    }
    const target = row.target_memory_id ?? row.targetMemoryId;
    if (typeof target === "string" || typeof target === "number")
        return [target];
    return memoryRefs(row).map((ref) => ref.memory_id);
}
function idsOverlap(left, right) {
    const keys = new Set(left.map((item) => String(item)));
    return right.some((item) => keys.has(String(item)));
}
function statusFromRelation(relation) {
    if (relation === "novel")
        return "endorsed";
    if (relation)
        return "challenged";
    return "proposed";
}
function messageTrace(message) {
    return {
        step: message.step,
        phase: message.phase,
        messageId: message.messageId,
        threadId: message.threadId,
    };
}
function firstMessage(messages, step, phase) {
    return messages.find((message) => message.status === "succeeded" &&
        message.output &&
        message.step === step &&
        (phase ? message.phase === phase : true)) ?? null;
}
function addTrace(trace, args) {
    trace.push({
        moveId: `move:${trace.length + 1}`,
        ...args,
    });
}
function resolutionForClaim(claim, finalRelevance) {
    if (!finalRelevance?.output)
        return null;
    const rejected = records(finalRelevance.output.rejected);
    const rejection = rejected.find((row) => bodyMatchScore(claim, row) > 0);
    if (rejection)
        return stringValue(rejection.reason) ?? stringValue(rejection.rationale) ?? "Rejected during proposal synthesis.";
    const proposal = records(finalRelevance.output.proposals).find((row) => bodyMatchScore(claim, row) > 0);
    if (proposal)
        return stringValue(proposal.rationale) ?? "Accepted into final proposal synthesis.";
    return null;
}
export function buildDeliberationArtifacts(args) {
    const claimScout = firstMessage(args.messages, "claim-scout", "candidate-proposal") ??
        firstMessage(args.messages, "claim-scout");
    const proposalEditor = firstMessage(args.messages, "proposal-editor", "typed-proposal") ??
        firstMessage(args.messages, "proposal-editor");
    const memoryCartographer = firstMessage(args.messages, "memory-cartographer", "memory-cartography") ??
        firstMessage(args.messages, "memory-cartographer");
    const evidenceAudit = firstMessage(args.messages, "evidence-auditor", "preflight-critique") ??
        firstMessage(args.messages, "evidence-auditor");
    const finalSynthesis = firstMessage(args.messages, "decision-synthesizer", "proposal-synthesis") ??
        firstMessage(args.messages, "decision-synthesizer");
    const claims = records(claimScout?.output?.candidates).map((candidate, index) => ({
        schemaVersion: refineryReviewSchemaVersion,
        claimId: `claim:${args.runId}:${index + 1}`,
        body: rowBody(candidate) ?? `Unnamed claim ${index + 1}`,
        sourceRefs: rowSourceRefs(candidate),
        whyFutureUseful: stringValue(candidate.why_future_useful),
        candidateAction: null,
        targetMemoryRefs: [],
        confidence: null,
        status: "proposed",
        statusReason: null,
        specialistTrace: claimScout ? [messageTrace(claimScout)] : [],
    }));
    const trace = [];
    for (const claim of claims) {
        addTrace(trace, {
            kind: "claim",
            claimId: claim.claimId,
            challengeId: null,
            agent: claimScout?.agent ?? "refinery-claim-scout",
            step: "claim-scout",
            phase: claimScout?.phase ?? null,
            threadId: claimScout?.threadId ?? null,
            messageId: claimScout?.messageId ?? null,
            summary: claim.body,
            refs: claim.sourceRefs,
        });
    }
    for (const [index, typed] of records(proposalEditor?.output?.typed).entries()) {
        const claim = findClaim(claims, typed, index);
        if (!claim)
            continue;
        claim.candidateAction = stringValue(typed.action);
        claim.targetMemoryRefs = targetMemoryRefs(typed);
        claim.confidence = numberValue(typed.type_confidence);
        if (proposalEditor)
            claim.specialistTrace.push(messageTrace(proposalEditor));
    }
    const challengeLedger = [];
    const findingMessages = [memoryCartographer, evidenceAudit].filter((message) => Boolean(message));
    for (const message of findingMessages) {
        for (const [index, finding] of records(message.output?.findings).entries()) {
            const relation = stringValue(finding.relation);
            const claim = findClaim(claims, finding, index);
            if (!claim)
                continue;
            const kind = relationToChallengeKind(relation);
            if (message)
                claim.specialistTrace.push(messageTrace(message));
            if (relation === "novel") {
                claim.status = claim.status === "proposed" ? "endorsed" : claim.status;
                addTrace(trace, {
                    kind: "endorsement",
                    claimId: claim.claimId,
                    challengeId: null,
                    agent: message.agent,
                    step: message.step,
                    phase: message.phase,
                    threadId: message.threadId,
                    messageId: message.messageId,
                    summary: stringValue(finding.rationale) ?? "Claim was endorsed as novel.",
                    refs: rowSourceRefs(finding),
                });
                continue;
            }
            if (!kind)
                continue;
            claim.status = statusFromRelation(relation);
            const resolution = resolutionForClaim(claim, finalSynthesis);
            if (resolution)
                claim.statusReason = resolution;
            const status = resolution ? "resolved" : "open";
            const challengeId = `challenge:${args.runId}:${challengeLedger.length + 1}`;
            const entry = {
                schemaVersion: refineryReviewSchemaVersion,
                challengeId,
                claimId: claim.claimId,
                kind,
                raisedBy: message.agent,
                targetAgent: "refinery-decision-synthesizer",
                status,
                rationale: stringValue(finding.rationale) ?? `${relation} relationship raised for claim.`,
                evidenceRefs: rowSourceRefs(finding),
                memoryRefs: memoryRefs(finding),
                resolution,
                phase: message.phase,
                threadId: message.threadId,
                messageId: message.messageId,
            };
            challengeLedger.push(entry);
            addTrace(trace, {
                kind: "challenge",
                claimId: claim.claimId,
                challengeId,
                agent: message.agent,
                step: message.step,
                phase: message.phase,
                threadId: message.threadId,
                messageId: message.messageId,
                summary: entry.rationale,
                refs: entry.evidenceRefs,
            });
        }
    }
    const finalAssignedClaimIds = new Set();
    for (const message of [finalSynthesis].filter((item) => Boolean(item))) {
        for (const [index, proposal] of records(message.output?.proposals).entries()) {
            const availableClaims = message.phase === "proposal-synthesis"
                ? claims.filter((claim) => !finalAssignedClaimIds.has(claim.claimId))
                : claims;
            const claim = findClaim(availableClaims.length > 0 ? availableClaims : claims, proposal, index);
            if (!claim)
                continue;
            if (message.phase === "proposal-synthesis") {
                finalAssignedClaimIds.add(claim.claimId);
                claim.status = "accepted";
                claim.statusReason = stringValue(proposal.rationale);
                claim.candidateAction = stringValue(proposal.action) ?? claim.candidateAction;
                claim.targetMemoryRefs = targetMemoryRefs(proposal);
                claim.confidence = numberValue(proposal.confidence) ?? claim.confidence;
            }
            addTrace(trace, {
                kind: "handoff",
                claimId: claim.claimId,
                challengeId: null,
                agent: message.agent,
                step: message.step,
                phase: message.phase,
                threadId: message.threadId,
                messageId: message.messageId,
                summary: stringValue(proposal.rationale) ?? "Claim was handed off as a proposal candidate.",
                refs: rowSourceRefs(proposal),
            });
        }
        for (const [index, rejected] of records(message.output?.rejected).entries()) {
            const availableClaims = message.phase === "proposal-synthesis"
                ? claims.filter((claim) => !finalAssignedClaimIds.has(claim.claimId))
                : claims;
            const claim = findClaim(availableClaims.length > 0 ? availableClaims : claims, rejected, index);
            if (!claim)
                continue;
            if (message.phase === "proposal-synthesis") {
                finalAssignedClaimIds.add(claim.claimId);
                claim.status = "rejected";
                claim.statusReason = stringValue(rejected.reason) ?? stringValue(rejected.rationale);
            }
            addTrace(trace, {
                kind: "challenge",
                claimId: claim.claimId,
                challengeId: null,
                agent: message.agent,
                step: message.step,
                phase: message.phase,
                threadId: message.threadId,
                messageId: message.messageId,
                summary: stringValue(rejected.reason) ?? stringValue(rejected.rationale) ?? "Claim was rejected.",
                refs: rowSourceRefs(rejected),
            });
        }
    }
    for (const claim of claims) {
        if (claim.status === "proposed")
            claim.status = "unresolved";
    }
    return {
        schemaVersion: refineryReviewSchemaVersion,
        topology: args.topology,
        claims,
        challengeLedger,
        trace,
        summary: {
            claims: claims.length,
            acceptedClaims: claims.filter((claim) => claim.status === "accepted").length,
            rejectedClaims: claims.filter((claim) => claim.status === "rejected").length,
            challengedClaims: claims.filter((claim) => claim.status === "challenged").length,
            challenges: challengeLedger.length,
            unresolvedChallenges: challengeLedger.filter((challenge) => challenge.status === "open").length,
            moves: trace.length,
        },
    };
}
export function claimCardsForCritique(args) {
    return records(args.claimScoutOutput.candidates).map((candidate, index) => ({
        schemaVersion: refineryReviewSchemaVersion,
        claimId: `claim:${args.runId}:${index + 1}`,
        body: rowBody(candidate) ?? `Unnamed claim ${index + 1}`,
        sourceRefs: rowSourceRefs(candidate),
        whyFutureUseful: stringValue(candidate.why_future_useful),
        candidateAction: null,
        targetMemoryRefs: [],
        confidence: null,
        status: "proposed",
        statusReason: null,
        specialistTrace: [],
    }));
}
//# sourceMappingURL=deliberation.js.map