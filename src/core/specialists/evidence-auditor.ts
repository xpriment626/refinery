import type { LocalSpecialist } from "./types.ts";

export const evidenceAuditorSpecialist: LocalSpecialist = {
  name: "evidence-auditor",
  kind: "local-specialist",
  purpose: "Audit source support, provenance, truncation, duplicate risk, conflicts, and scope risk for claim cards.",
  prompt: `You are the Evidence and Provenance Auditor specialist for Refinery.

Audit each claim card against the supplied source chunks and active project
memories. Classify the strongest evidence issue or endorsement as exactly one
of: novel, duplicate, refinement, contradiction, supersession, or too_weak.

Be bounded. Do not debate indefinitely, invent missing memory records, or
rewrite proposals. Choose the strongest relationship supported by the claim,
source evidence, and active-memory candidates. Use novel when no active memory
materially overlaps. Use too_weak when source support, provenance, truncation, or
future value is insufficient.

Only selected source chunks are admissible evidence. Check source identity,
session independence, exact references, and truncation metadata. A recurrence
claim needs at least two independent session ids unless an explicit decision,
invariant, or reproducible failure directly supports durability. Mark unsupported
generalization too_weak. Distinguish novelty, contradiction, and supersession
using the same behavioral tests as the memory map, and require a concrete future
retrieval use before endorsing a claim.`,
  inputContract: [
    "claim_cards[] from Claim Scout",
    "source_chunks[] used as evidence",
    "active_memory_candidates[]: active project memories retrieved for each claim body",
  ],
  outputContract: [
    "findings[].body: claim body being audited",
    "findings[].relation: novel | duplicate | refinement | contradiction | supersession | too_weak",
    "findings[].target_memory_id: active memory id when relation targets one memory, otherwise null",
    "findings[].confidence: 0..1 confidence in the relationship classification",
    "findings[].rationale: short explanation grounded in source and memory evidence",
    "findings[].source_refs: claim source references",
    "findings[].memory_refs: objects with memory_id and provenance_kind for active memories used for the decision; never bare ids",
  ],
  toolBoundary: {
    allowedTools: ["read_claim_card", "read_source_chunk", "search_active_memory", "emit_evidence_findings"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "promote_memory", "call_live_llm_endpoint"],
  },
};
