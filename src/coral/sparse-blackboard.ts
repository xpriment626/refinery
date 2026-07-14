import crypto from "node:crypto";
import type { ReviewPacket } from "../core/types.ts";

export const sparseBlackboardSchemaVersion = "refinery.sparse-blackboard.v1" as const;

export interface SparseTopic {
  id: string;
  responsibilityUnitId: string;
  sourceChunkIds: string[];
  graphNodeIds: string[];
  state: "awake" | "sleeping" | "deferred";
}

export interface SparseRoutingDecision {
  candidateCount: number;
  wakeCartographer: boolean;
  wakeAuditor: boolean;
  wakeProposalEditor: boolean;
  wakeDecisionSynthesizer: boolean;
  overlapDetected: boolean;
  weaknessDetected: boolean;
  contradictionRisk: boolean;
  highImpact: boolean;
  disagreement: boolean;
  reasons: string[];
}

export interface SparseBlackboard {
  schemaVersion: typeof sparseBlackboardSchemaVersion;
  runId: string;
  topology: "sparse-blackboard";
  topics: SparseTopic[];
  sleepingTopicIds: string[];
  deferredTopicIds: string[];
  claims: Record<string, unknown>[];
  cartographyFindings: Record<string, unknown>[];
  auditFindings: Record<string, unknown>[];
  typedCandidates: Record<string, unknown>[];
  routing: SparseRoutingDecision;
  wakeSequence: string[];
  modelCalls: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "was", "were", "with", "we", "you", "your",
]);

function hash(parts: string[]): string {
  const digest = crypto.createHash("sha256");
  for (const part of parts) digest.update(part).update("\0");
  return digest.digest("hex").slice(0, 20);
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)
    ?.filter((token) => token.length >= 3 && !STOP_WORDS.has(token)) ?? []);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => (
    Boolean(item) && typeof item === "object" && !Array.isArray(item)
  )) : [];
}

function chunkId(chunk: unknown): string | null {
  return chunk && typeof chunk === "object" && !Array.isArray(chunk) && typeof (chunk as Record<string, unknown>).id === "string"
    ? String((chunk as Record<string, unknown>).id)
    : null;
}

function unitIdFromChunk(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return null;
  const metadata = (chunk as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return typeof (metadata as Record<string, unknown>).unitId === "string"
    ? String((metadata as Record<string, unknown>).unitId)
    : null;
}

export function buildSparseTopics(packet: ReviewPacket): SparseTopic[] {
  const plan = packet.graph?.plan;
  const chunks = records(packet.derivedViews.source_chunks);
  if (!plan || plan.responsibilityUnits.length === 0) {
    return [{
      id: `topic:${hash([packet.objective.project, "root"])}`,
      responsibilityUnitId: "root",
      sourceChunkIds: chunks.map(chunkId).filter((id): id is string => Boolean(id)),
      graphNodeIds: [],
      state: "awake",
    }];
  }
  const contexts = packet.graph?.context ?? [];
  return plan.responsibilityUnits.map((unit) => {
    const unitContexts = contexts.filter((context) => context.responsibilityUnitId === unit.id);
    const graphNodeIds = new Set(unit.nodeIds);
    const sourceUnitIds = new Set(unitContexts.flatMap((context) => (
      typeof context.metadata.unitId === "string" ? [context.metadata.unitId] : []
    )));
    const sourceChunkIds = chunks
      .filter((chunk) => {
        const id = chunkId(chunk);
        if (id && graphNodeIds.has(id)) return true;
        const sourceUnitId = unitIdFromChunk(chunk);
        return Boolean(sourceUnitId && sourceUnitIds.has(sourceUnitId));
      })
      .map(chunkId)
      .filter((id): id is string => Boolean(id));
    return {
      id: `topic:${hash([packet.objective.project, unit.id])}`,
      responsibilityUnitId: unit.id,
      sourceChunkIds,
      graphNodeIds: unit.nodeIds,
      state: unit.state,
    };
  });
}

function candidateBody(candidate: Record<string, unknown>): string {
  return typeof candidate.claim === "string"
    ? candidate.claim
    : typeof candidate.body === "string" ? candidate.body : "";
}

function sourceRefs(candidate: Record<string, unknown>): unknown[] {
  return Array.isArray(candidate.source_refs)
    ? candidate.source_refs
    : Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [];
}

function memoryBody(memory: Record<string, unknown>): string {
  return typeof memory.body === "string" ? memory.body : "";
}

function materiallyOverlaps(left: string, right: string): boolean {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap >= Math.max(3, Math.ceil(Math.min(leftTokens.size, rightTokens.size) * 0.3));
}

function negativePolarity(text: string): boolean {
  return /\b(no|not|never|without|disable|disabled|forbid|forbidden|avoid|must not)\b/i.test(text);
}

function relationForBody(findings: Record<string, unknown>[], body: string): string[] {
  return findings.filter((finding) => {
    const findingBody = typeof finding.body === "string" ? finding.body : "";
    return findingBody === body || materiallyOverlaps(findingBody, body);
  }).flatMap((finding) => typeof finding.relation === "string" ? [finding.relation] : []);
}

export function routeSparseClaims(args: {
  candidates: Record<string, unknown>[];
  activeMemories: Record<string, unknown>[];
  cartographyFindings?: Record<string, unknown>[];
  auditFindings?: Record<string, unknown>[];
  typedCandidates?: Record<string, unknown>[];
}): { decision: SparseRoutingDecision; survivors: Record<string, unknown>[] } {
  const cartography = args.cartographyFindings ?? [];
  const audit = args.auditFindings ?? [];
  let overlapDetected = false;
  let contradictionRisk = false;
  let weaknessDetected = false;
  let highImpact = false;
  for (const candidate of args.candidates) {
    const body = candidateBody(candidate);
    const matchingMemories = args.activeMemories.filter((memory) => materiallyOverlaps(body, memoryBody(memory)));
    if (matchingMemories.length > 0) overlapDetected = true;
    if (matchingMemories.some((memory) => negativePolarity(body) !== negativePolarity(memoryBody(memory)))) {
      contradictionRisk = true;
    }
    const futureValue = typeof candidate.why_future_useful === "string" ? candidate.why_future_useful.trim() : "";
    if (sourceRefs(candidate).length === 0 || body.length < 32 || futureValue.length < 16) weaknessDetected = true;
    if (/\b(security|credential|secret|delete|archive|supersed|always|never|must|invariant|release|migration)\b/i.test(body)) {
      highImpact = true;
    }
  }
  const survivors = args.candidates.filter((candidate) => {
    const relations = [...relationForBody(cartography, candidateBody(candidate)), ...relationForBody(audit, candidateBody(candidate))];
    return !relations.includes("duplicate") && !relations.includes("too_weak");
  });
  const relationPairs = args.candidates.map((candidate) => ({
    cartography: relationForBody(cartography, candidateBody(candidate)),
    audit: relationForBody(audit, candidateBody(candidate)),
  }));
  const disagreement = relationPairs.some((pair) => pair.cartography.length > 0 && pair.audit.length > 0
    && pair.cartography.some((relation) => !pair.audit.includes(relation)));
  const wakeCartographer = args.candidates.length > 0 && overlapDetected;
  const wakeAuditor = args.candidates.length > 0 && (weaknessDetected || contradictionRisk || highImpact);
  const wakeProposalEditor = survivors.length > 0;
  const wakeDecisionSynthesizer = (args.typedCandidates?.length ?? 0) > 0 || disagreement;
  const reasons = [
    ...(wakeCartographer ? ["active-memory-overlap"] : []),
    ...(weaknessDetected ? ["weak-or-truncated-claim"] : []),
    ...(contradictionRisk ? ["contradiction-risk"] : []),
    ...(highImpact ? ["high-impact-claim"] : []),
    ...(survivors.length > 0 ? ["surviving-candidates"] : ["no-surviving-candidates"]),
    ...(disagreement ? ["specialist-disagreement"] : []),
  ];
  return {
    survivors,
    decision: {
      candidateCount: args.candidates.length,
      wakeCartographer,
      wakeAuditor,
      wakeProposalEditor,
      wakeDecisionSynthesizer,
      overlapDetected,
      weaknessDetected,
      contradictionRisk,
      highImpact,
      disagreement,
      reasons,
    },
  };
}

export function createSparseBlackboard(runId: string, packet: ReviewPacket): SparseBlackboard {
  const topics = buildSparseTopics(packet);
  return {
    schemaVersion: sparseBlackboardSchemaVersion,
    runId,
    topology: "sparse-blackboard",
    topics,
    sleepingTopicIds: topics.filter((topic) => topic.state === "sleeping").map((topic) => topic.id),
    deferredTopicIds: topics.filter((topic) => topic.state === "deferred").map((topic) => topic.id),
    claims: [],
    cartographyFindings: [],
    auditFindings: [],
    typedCandidates: [],
    routing: routeSparseClaims({ candidates: [], activeMemories: [] }).decision,
    wakeSequence: [],
    modelCalls: 0,
  };
}
