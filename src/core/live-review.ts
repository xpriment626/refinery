import type { ModelConfig } from "../env.ts";
import { memoryMaintenanceActions, type MemoryMaintenanceAction } from "./types.ts";
import type { LocalSpecialist } from "./specialists/types.ts";

export interface ClaimScoutCandidate {
  claim: string;
  source_refs: unknown[];
  why_future_useful: string;
}

export interface ClaimScoutOutput {
  candidates: ClaimScoutCandidate[];
}

export interface DistilledMemory {
  body: string;
  source_refs: unknown[];
  rationale: string;
}

export interface TypedCandidate {
  body: string;
  memory_type: string;
  primary_type: string;
  secondary_type: string | null;
  type_confidence: number;
  type_rationale: string;
  ambiguities: string[];
  durability: "durable" | "ttl" | "ephemeral";
  ttl: string | null;
  proposed_scope: string;
  action: MemoryMaintenanceAction;
  target_memory_id: string | number | null;
  target_memory_ids?: Array<string | number>;
  source_refs: unknown[];
}

export interface ProposalEditorOutput {
  typed: TypedCandidate[];
}

export interface MemoryProposalDraft {
  memory_type: string;
  proposed_scope: string;
  body: string;
  confidence: number;
  rationale: string;
  source_refs: unknown[];
  action: MemoryMaintenanceAction;
  target_memory_id: string | number | null;
  target_memory_ids?: Array<string | number>;
  staleness_reason?: string | null;
  forget_reason?: string | null;
  update_reason?: string | null;
  conflict_reason?: string | null;
  scope_reason?: string | null;
  replacement_body?: string | null;
  ambiguities?: string[];
}

export interface RejectedCandidate {
  body?: string;
  reason: string;
}

export interface DecisionSynthesizerOutput {
  proposals: MemoryProposalDraft[];
  rejected: RejectedCandidate[];
  skillCandidates?: unknown;
  skill_candidates?: unknown;
}

export interface RelationshipFinding {
  body: string;
  relation: "novel" | "duplicate" | "refinement" | "contradiction" | "supersession" | "too_weak";
  target_memory_id: string | number | null;
  confidence: number;
  rationale: string;
  source_refs: unknown[];
  memory_refs: { memory_id: string | number; provenance_kind: string | null }[];
}

export interface EvidenceFindingOutput {
  findings: RelationshipFinding[];
}

export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("Model response did not contain a JSON object.");
  return JSON.parse(candidate.slice(first, last + 1)) as unknown;
}

export function redactModel(config: ModelConfig): Omit<ModelConfig, "apiKey"> & {
  apiKeyPresent: boolean;
} {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
    apiKeyPresent: Boolean(config.apiKey),
  };
}

function parseAction(value: unknown, label: string): MemoryMaintenanceAction {
  const action = value;
  if (!memoryMaintenanceActions.includes(action as MemoryMaintenanceAction)) {
    throw new Error(`${label} has invalid action.`);
  }
  return action as MemoryMaintenanceAction;
}

function optionalString(record: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in record)) return undefined;
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be string or null when present.`);
  return value;
}

function optionalStringArray(record: Record<string, unknown>, field: string): string[] | undefined {
  if (!(field in record)) return undefined;
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings when present.`);
  }
  return value;
}

function parseTargetMemoryIds(value: unknown, label: string): {
  target_memory_id: string | number | null;
  target_memory_ids: Array<string | number>;
} {
  if (value === null || value === undefined) {
    return { target_memory_id: null, target_memory_ids: [] };
  }
  if (typeof value === "string" || typeof value === "number") {
    return { target_memory_id: value, target_memory_ids: [value] };
  }
  if (Array.isArray(value)) {
    const ids = value.filter((item): item is string | number => typeof item === "string" || typeof item === "number");
    if (ids.length !== value.length) {
      throw new Error(`${label} target_memory_id must contain only strings or numbers when an array is used.`);
    }
    return { target_memory_id: ids[0] ?? null, target_memory_ids: ids };
  }
  throw new Error(`${label} target_memory_id must be string, number, null, or an array of strings/numbers.`);
}

export function parseClaimScout(raw: string): ClaimScoutOutput {
  const parsed = extractJson(raw) as { candidates?: unknown[] };
  if (!Array.isArray(parsed.candidates)) throw new Error("Claim Scout output must contain candidates array.");
  return {
    candidates: parsed.candidates.map((candidate, index) => {
      if (!candidate || typeof candidate !== "object") throw new Error(`Candidate ${index} must be an object.`);
      const c = candidate as Partial<ClaimScoutCandidate>;
      if (typeof c.claim !== "string" || !c.claim.trim()) throw new Error(`Candidate ${index} missing claim.`);
      if (!Array.isArray(c.source_refs)) throw new Error(`Candidate ${index} missing source_refs array.`);
      if (typeof c.why_future_useful !== "string" || !c.why_future_useful.trim()) {
        throw new Error(`Candidate ${index} missing why_future_useful.`);
      }
      return { claim: c.claim, source_refs: c.source_refs, why_future_useful: c.why_future_useful };
    }),
  };
}

export function parseProposalEditor(raw: string): ProposalEditorOutput {
  const parsed = extractJson(raw) as { typed?: unknown[] };
  if (!Array.isArray(parsed.typed)) throw new Error("Proposal Editor output must contain typed array.");
  return {
    typed: parsed.typed.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Typed item ${index} must be an object.`);
      const t = item as Partial<TypedCandidate>;
      if (typeof t.body !== "string" || !t.body.trim()) throw new Error(`Typed item ${index} missing body.`);
      if (typeof t.memory_type !== "string" || !t.memory_type.trim()) throw new Error(`Typed item ${index} missing memory_type.`);
      if (typeof t.primary_type !== "string" || !t.primary_type.trim()) throw new Error(`Typed item ${index} missing primary_type.`);
      if (t.secondary_type !== null && typeof t.secondary_type !== "string") {
        throw new Error(`Typed item ${index} secondary_type must be string or null.`);
      }
      if (typeof t.type_confidence !== "number" || t.type_confidence < 0 || t.type_confidence > 1) {
        throw new Error(`Typed item ${index} type_confidence must be 0..1.`);
      }
      if (typeof t.type_rationale !== "string" || !t.type_rationale.trim()) {
        throw new Error(`Typed item ${index} missing type_rationale.`);
      }
      if (!Array.isArray(t.ambiguities)) throw new Error(`Typed item ${index} missing ambiguities array.`);
      if (t.durability !== "durable" && t.durability !== "ttl" && t.durability !== "ephemeral") {
        throw new Error(`Typed item ${index} has invalid durability.`);
      }
      if (t.ttl !== null && typeof t.ttl !== "string") throw new Error(`Typed item ${index} ttl must be string or null.`);
      if (typeof t.proposed_scope !== "string" || !t.proposed_scope.trim()) {
        throw new Error(`Typed item ${index} missing proposed_scope.`);
      }
      const action = parseAction(t.action, `Typed item ${index}`);
      const record = item as Record<string, unknown>;
      const target = parseTargetMemoryIds(
        record.target_memory_ids ?? record.target_memory_id,
        `Typed item ${index}`,
      );
      if (!Array.isArray(t.source_refs)) throw new Error(`Typed item ${index} missing source_refs array.`);
      return {
        body: t.body,
        memory_type: t.memory_type,
        primary_type: t.primary_type,
        secondary_type: t.secondary_type,
        type_confidence: t.type_confidence,
        type_rationale: t.type_rationale,
        ambiguities: t.ambiguities,
        durability: t.durability,
        ttl: t.ttl,
        proposed_scope: t.proposed_scope,
        action,
        target_memory_id: target.target_memory_id,
        ...(target.target_memory_ids.length > 1 ? { target_memory_ids: target.target_memory_ids } : {}),
        source_refs: t.source_refs,
      };
    }),
  };
}

export function parseDecisionSynthesizer(raw: string): DecisionSynthesizerOutput {
  const parsed = extractJson(raw) as {
    proposals?: unknown[];
    rejected?: unknown[];
    skillCandidates?: unknown;
    skill_candidates?: unknown;
  };
  if (!Array.isArray(parsed.proposals) || !Array.isArray(parsed.rejected)) {
    throw new Error("Decision Synthesizer output must contain proposals and rejected arrays.");
  }
  const output: DecisionSynthesizerOutput = {
    proposals: parsed.proposals.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Proposal ${index} must be an object.`);
      const p = item as Partial<MemoryProposalDraft>;
      if (typeof p.memory_type !== "string" || !p.memory_type.trim()) throw new Error(`Proposal ${index} missing memory_type.`);
      if (typeof p.proposed_scope !== "string" || !p.proposed_scope.trim()) {
        throw new Error(`Proposal ${index} missing proposed_scope.`);
      }
      if (typeof p.body !== "string" || !p.body.trim()) throw new Error(`Proposal ${index} missing body.`);
      if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) {
        throw new Error(`Proposal ${index} confidence must be 0..1.`);
      }
      if (typeof p.rationale !== "string" || !p.rationale.trim()) throw new Error(`Proposal ${index} missing rationale.`);
      if (!Array.isArray(p.source_refs)) throw new Error(`Proposal ${index} missing source_refs array.`);
      const action = parseAction(p.action, `Proposal ${index}`);
      const record = item as Record<string, unknown>;
      const target = parseTargetMemoryIds(
        record.target_memory_ids ?? record.target_memory_id,
        `Proposal ${index}`,
      );
      return {
        memory_type: p.memory_type,
        proposed_scope: p.proposed_scope,
        body: p.body,
        confidence: p.confidence,
        rationale: p.rationale,
        source_refs: p.source_refs,
        action,
        target_memory_id: target.target_memory_id,
        ...(target.target_memory_ids.length > 1 ? { target_memory_ids: target.target_memory_ids } : {}),
        ...(optionalString(record, "staleness_reason") !== undefined ? { staleness_reason: optionalString(record, "staleness_reason") } : {}),
        ...(optionalString(record, "forget_reason") !== undefined ? { forget_reason: optionalString(record, "forget_reason") } : {}),
        ...(optionalString(record, "update_reason") !== undefined ? { update_reason: optionalString(record, "update_reason") } : {}),
        ...(optionalString(record, "conflict_reason") !== undefined ? { conflict_reason: optionalString(record, "conflict_reason") } : {}),
        ...(optionalString(record, "scope_reason") !== undefined ? { scope_reason: optionalString(record, "scope_reason") } : {}),
        ...(optionalString(record, "replacement_body") !== undefined ? { replacement_body: optionalString(record, "replacement_body") } : {}),
        ...(optionalStringArray(record, "ambiguities") !== undefined ? { ambiguities: optionalStringArray(record, "ambiguities") } : {}),
      };
    }),
    rejected: parsed.rejected.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Rejected item ${index} must be an object.`);
      const r = item as Partial<RejectedCandidate>;
      const explanation = (item as { rejection_rationale?: unknown }).rejection_rationale
        ?? (item as { rationale?: unknown }).rationale
        ?? (item as { rejection_reason?: unknown }).rejection_reason
        ?? (item as { type_rationale?: unknown }).type_rationale
        ?? (item as { update_reason?: unknown }).update_reason;
      const reason = typeof r.reason === "string" && r.reason.trim()
        ? r.reason
        : typeof explanation === "string" && explanation.trim()
          ? explanation
          : null;
      if (!reason) throw new Error(`Rejected item ${index} missing reason.`);
      return { body: typeof r.body === "string" ? r.body : undefined, reason };
    }),
  };
  if (parsed.skillCandidates !== undefined) output.skillCandidates = parsed.skillCandidates;
  if (parsed.skill_candidates !== undefined) output.skill_candidates = parsed.skill_candidates;
  return output;
}

export function parseEvidenceFindings(raw: string): EvidenceFindingOutput {
  const parsed = extractJson(raw) as { findings?: unknown[] };
  if (!Array.isArray(parsed.findings)) throw new Error("Evidence finding output must contain findings array.");
  return {
    findings: parsed.findings.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`Finding ${index} must be an object.`);
      const f = item as Partial<RelationshipFinding>;
      if (typeof f.body !== "string" || !f.body.trim()) throw new Error(`Finding ${index} missing body.`);
      if (!["novel", "duplicate", "refinement", "contradiction", "supersession", "too_weak"].includes(String(f.relation))) {
        throw new Error(`Finding ${index} has invalid relation.`);
      }
      if (f.target_memory_id !== null && typeof f.target_memory_id !== "string" && typeof f.target_memory_id !== "number") {
        throw new Error(`Finding ${index} target_memory_id must be string, number, or null.`);
      }
      if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
        throw new Error(`Finding ${index} confidence must be 0..1.`);
      }
      if (typeof f.rationale !== "string" || !f.rationale.trim()) throw new Error(`Finding ${index} missing rationale.`);
      if (!Array.isArray(f.source_refs)) throw new Error(`Finding ${index} missing source_refs array.`);
      if (!Array.isArray(f.memory_refs)) throw new Error(`Finding ${index} missing memory_refs array.`);
      const memoryRefs = f.memory_refs.map((memoryRef) => {
        if (typeof memoryRef === "string" || typeof memoryRef === "number") {
          return { memory_id: typeof memoryRef === "number" ? `memory:${memoryRef}` : memoryRef, provenance_kind: null };
        }
        if (memoryRef && typeof memoryRef === "object") {
          const ref = memoryRef as { memory_id?: unknown; provenance_kind?: unknown };
          if (typeof ref.memory_id !== "string" && typeof ref.memory_id !== "number") {
            throw new Error(`Finding ${index} memory_ref missing memory_id.`);
          }
          return {
            memory_id: typeof ref.memory_id === "number" ? `memory:${ref.memory_id}` : ref.memory_id,
            provenance_kind: typeof ref.provenance_kind === "string" ? ref.provenance_kind : null,
          };
        }
        throw new Error(`Finding ${index} memory_ref must be an object, string, or number.`);
      });
      return { ...(f as RelationshipFinding), memory_refs: memoryRefs };
    }),
  };
}

export function buildPrompt(args: {
  specialist: LocalSpecialist;
  shape: string;
  instruction: string;
  payload: unknown;
}): { system: string; user: string } {
  return {
    system: [
      args.specialist.prompt,
      "",
      "Return only JSON matching this shape:",
      args.shape,
      args.instruction,
      "Do not wrap the answer in prose. Do not activate, approve, or write memory.",
    ].join("\n"),
    user: [
      "Process this Refinery live review payload using your specialist contract.",
      "",
      JSON.stringify(args.payload, null, 2),
    ].join("\n"),
  };
}
