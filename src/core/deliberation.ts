import crypto from "node:crypto";
import { refineryReviewSchemaVersion } from "./types.ts";

export type DeliberationMoveKind = "claim" | "question" | "challenge" | "handoff" | "endorsement";

export type ChallengeKind =
  | "duplicate"
  | "evidence_gap"
  | "conflict"
  | "scope_risk"
  | "staleness"
  | "open_question";

export type ChallengeStatus = "open" | "answered" | "accepted" | "rejected" | "resolved";

export type ClaimStatus = "proposed" | "challenged" | "endorsed" | "accepted" | "rejected" | "unresolved";

export interface ClaimCard {
  schemaVersion: typeof refineryReviewSchemaVersion;
  claimId: string;
  body: string;
  sourceRefs: unknown[];
  whyFutureUseful: string | null;
  candidateAction: string | null;
  targetMemoryRefs: Array<string | number>;
  confidence: number | null;
  status: ClaimStatus;
  statusReason: string | null;
  specialistTrace: Array<{
    step: string;
    phase: string | null;
    messageId: string | null;
    threadId: string | null;
  }>;
}

export interface ChallengeLedgerEntry {
  schemaVersion: typeof refineryReviewSchemaVersion;
  challengeId: string;
  claimId: string;
  kind: ChallengeKind;
  raisedBy: string;
  targetAgent: string | null;
  status: ChallengeStatus;
  rationale: string;
  evidenceRefs: unknown[];
  memoryRefs: Array<{ memory_id: string | number; provenance_kind: string | null }>;
  resolution: string | null;
  phase: string | null;
  threadId: string | null;
  messageId: string | null;
}

export interface DeliberationTraceEntry {
  moveId: string;
  kind: DeliberationMoveKind;
  claimId: string | null;
  challengeId: string | null;
  agent: string;
  step: string;
  phase: string | null;
  threadId: string | null;
  messageId: string | null;
  summary: string;
  refs: unknown[];
}

export interface DeliberationSpecialistMessage {
  step: string;
  agent: string;
  status: "succeeded" | "failed";
  messageId: string | null;
  threadId: string | null;
  phase: string | null;
  output: Record<string, unknown> | null;
}

export interface DeliberationArtifacts {
  schemaVersion: typeof refineryReviewSchemaVersion;
  topology: string;
  claims: ClaimCard[];
  challengeLedger: ChallengeLedgerEntry[];
  trace: DeliberationTraceEntry[];
  summary: {
    claims: number;
    acceptedClaims: number;
    rejectedClaims: number;
    challengedClaims: number;
    challenges: number;
    unresolvedChallenges: number;
    moves: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hashParts(parts: unknown[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(JSON.stringify(part)).update("\0");
  return hash.digest("hex").slice(0, 12);
}

function refKeys(refs: unknown[]): Set<string> {
  return new Set(refs.map((ref) => JSON.stringify(ref)).filter((ref) => ref !== undefined));
}

function refsOverlap(left: unknown[], right: unknown[]): boolean {
  const keys = refKeys(left);
  return right.some((ref) => keys.has(JSON.stringify(ref)));
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalized(text)
      .split(/[^a-z0-9:_/-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4),
  );
}

function rowBody(row: Record<string, unknown>): string | null {
  return stringValue(row.body) ?? stringValue(row.claim) ?? stringValue(row.proposal_body);
}

function rowSourceRefs(row: Record<string, unknown>): unknown[] {
  return arrayValue(row.source_refs ?? row.sourceRefs);
}

function bodyMatchScore(claim: ClaimCard, row: Record<string, unknown>): number {
  const body = rowBody(row);
  if (!body) return 0;
  const claimBody = normalized(claim.body);
  const rowText = normalized(body);
  if (claimBody === rowText) return 100;
  if (claimBody.includes(rowText) || rowText.includes(claimBody)) return 90;
  if (claimBody.slice(0, 80) && rowText.includes(claimBody.slice(0, 80))) return 80;
  const claimTokens = tokenSet(claimBody);
  const rowTokens = tokenSet(rowText);
  if (claimTokens.size === 0 || rowTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of rowTokens) {
    if (claimTokens.has(token)) overlap += 1;
  }
  const ratio = overlap / Math.min(claimTokens.size, rowTokens.size);
  if (ratio >= 0.6) return 70;
  if (ratio >= 0.35) return 45;
  if (ratio >= 0.2) return 20;
  return 0;
}

function findClaim(claims: ClaimCard[], row: Record<string, unknown>, index?: number): ClaimCard | null {
  const refs = rowSourceRefs(row);
  const refMatches = refs.length > 0 ? claims.filter((claim) => refsOverlap(claim.sourceRefs, refs)) : [];
  const uniqueRefClaim = refMatches.length === 1 ? refMatches[0] : null;
  const scored = claims
    .map((claim) => {
      let score = bodyMatchScore(claim, row);
      const targets = targetMemoryRefs(row);
      if (targets.length > 0 && idsOverlap(claim.targetMemoryRefs, targets)) score += 45;
      if (uniqueRefClaim?.claimId === claim.claimId) score += 15;
      if (typeof index === "number" && claim.claimId.endsWith(`:${index + 1}`)) score += 8;
      return { claim, score };
    })
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score <= 0) return null;
  const second = scored[1];
  if (second && best.score === second.score && best.score < 60) return null;
  return best.claim;
}

function relationToChallengeKind(relation: string | null): ChallengeKind | null {
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

function memoryRefs(row: Record<string, unknown>): Array<{ memory_id: string | number; provenance_kind: string | null }> {
  return records(row.memory_refs).flatMap((ref) => {
    const memoryId = ref.memory_id;
    if (typeof memoryId !== "string" && typeof memoryId !== "number") return [];
    const provenanceKind = typeof ref.provenance_kind === "string" ? ref.provenance_kind : null;
    return [{ memory_id: memoryId, provenance_kind: provenanceKind }];
  });
}

function targetMemoryRefs(row: Record<string, unknown>): Array<string | number> {
  if (Array.isArray(row.target_memory_ids)) {
    return row.target_memory_ids.filter((item): item is string | number => typeof item === "string" || typeof item === "number");
  }
  const target = row.target_memory_id ?? row.targetMemoryId;
  if (typeof target === "string" || typeof target === "number") return [target];
  return memoryRefs(row).map((ref) => ref.memory_id);
}

function idsOverlap(left: Array<string | number>, right: Array<string | number>): boolean {
  const keys = new Set(left.map((item) => String(item)));
  return right.some((item) => keys.has(String(item)));
}

function statusFromRelation(relation: string | null): ClaimStatus {
  if (relation === "novel") return "endorsed";
  if (relation) return "challenged";
  return "proposed";
}

function messageTrace(message: DeliberationSpecialistMessage): ClaimCard["specialistTrace"][number] {
  return {
    step: message.step,
    phase: message.phase,
    messageId: message.messageId,
    threadId: message.threadId,
  };
}

function firstMessage(
  messages: DeliberationSpecialistMessage[],
  step: string,
  phase?: string,
): DeliberationSpecialistMessage | null {
  return messages.find((message) =>
    message.status === "succeeded" &&
    message.output &&
    message.step === step &&
    (phase ? message.phase === phase : true)
  ) ?? null;
}

function addTrace(
  trace: DeliberationTraceEntry[],
  args: Omit<DeliberationTraceEntry, "moveId">,
): void {
  trace.push({
    moveId: `move:${trace.length + 1}`,
    ...args,
  });
}

function resolutionForClaim(claim: ClaimCard, finalRelevance: DeliberationSpecialistMessage | null): string | null {
  if (!finalRelevance?.output) return null;
  const rejected = records(finalRelevance.output.rejected);
  const rejection = rejected.find((row) => bodyMatchScore(claim, row) > 0);
  if (rejection) return stringValue(rejection.reason) ?? stringValue(rejection.rationale) ?? "Rejected during proposal synthesis.";
  const proposal = records(finalRelevance.output.proposals).find((row) => bodyMatchScore(claim, row) > 0);
  if (proposal) return stringValue(proposal.rationale) ?? "Accepted into final proposal synthesis.";
  return null;
}

export function buildDeliberationArtifacts(args: {
  runId: string;
  topology: string;
  messages: DeliberationSpecialistMessage[];
}): DeliberationArtifacts {
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

  const claims = records(claimScout?.output?.candidates).map((candidate, index): ClaimCard => ({
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

  const trace: DeliberationTraceEntry[] = [];
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
    if (!claim) continue;
    claim.candidateAction = stringValue(typed.action);
    claim.targetMemoryRefs = targetMemoryRefs(typed);
    claim.confidence = numberValue(typed.type_confidence);
    if (proposalEditor) claim.specialistTrace.push(messageTrace(proposalEditor));
  }

  const challengeLedger: ChallengeLedgerEntry[] = [];
  const findingMessages = [memoryCartographer, evidenceAudit].filter((message): message is DeliberationSpecialistMessage => Boolean(message));
  for (const message of findingMessages) {
    for (const [index, finding] of records(message.output?.findings).entries()) {
      const relation = stringValue(finding.relation);
      const claim = findClaim(claims, finding, index);
      if (!claim) continue;
      const kind = relationToChallengeKind(relation);
      if (message) claim.specialistTrace.push(messageTrace(message));
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
      if (!kind) continue;
      claim.status = statusFromRelation(relation);
      const resolution = resolutionForClaim(claim, finalSynthesis);
      if (resolution) claim.statusReason = resolution;
      const status: ChallengeStatus = resolution ? "resolved" : "open";
      const challengeId = `challenge:${args.runId}:${challengeLedger.length + 1}`;
      const entry: ChallengeLedgerEntry = {
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

  const finalAssignedClaimIds = new Set<string>();
  for (const message of [finalSynthesis].filter((item): item is DeliberationSpecialistMessage => Boolean(item))) {
    for (const [index, proposal] of records(message.output?.proposals).entries()) {
      const availableClaims = message.phase === "proposal-synthesis"
        ? claims.filter((claim) => !finalAssignedClaimIds.has(claim.claimId))
        : claims;
      const claim = findClaim(availableClaims.length > 0 ? availableClaims : claims, proposal, index);
      if (!claim) continue;
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
      if (!claim) continue;
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
    if (claim.status === "proposed") claim.status = "unresolved";
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

export function claimCardsForCritique(args: {
  runId: string;
  claimScoutOutput: Record<string, unknown>;
}): ClaimCard[] {
  return records(args.claimScoutOutput.candidates).map((candidate, index): ClaimCard => ({
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
