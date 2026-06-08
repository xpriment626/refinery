import type { LocalSpecialist } from "./types.ts";

export const relationshipReviewSpecialist: LocalSpecialist = {
  name: "relationship-review",
  kind: "local-specialist",
  purpose: "Compare proposal-shaped candidates against active memory and classify their relationship.",
  prompt: `You are the Relationship Review specialist for Refinery.

Compare each proposal-shaped candidate against the supplied active project
memories. Classify the relationship as exactly one of: novel, duplicate,
refinement, contradiction, supersession, or too_weak.

Be bounded. Do not debate indefinitely, invent missing memory records, or
rewrite proposals. Choose the strongest relationship supported by the candidate
and the active-memory candidates. Use novel when no active memory materially
overlaps. Use too_weak when the candidate lacks enough evidence or durable
future value to justify a relationship decision.`,
  inputContract: [
    "proposals[] from Relevance",
    "rejected[] from Relevance for context only",
    "active_memory_candidates[]: active project memories retrieved for each proposal body",
  ],
  outputContract: [
    "findings[].body: proposal body being classified",
    "findings[].relation: novel | duplicate | refinement | contradiction | supersession | too_weak",
    "findings[].target_memory_id: active memory id when relation targets one memory, otherwise null",
    "findings[].confidence: 0..1 confidence in the relationship classification",
    "findings[].rationale: short explanation grounded in proposal and memory evidence",
    "findings[].source_refs: proposal source references",
    "findings[].memory_refs: objects with memory_id and provenance_kind for active memories used for the decision; never bare ids",
  ],
  toolBoundary: {
    allowedTools: ["read_relevance_output", "search_active_memory", "emit_relationship_findings"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "promote_memory", "call_live_llm_endpoint"],
  },
};
