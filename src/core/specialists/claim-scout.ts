import type { LocalSpecialist } from "./types.ts";

export const claimScoutSpecialist: LocalSpecialist = {
  name: "claim-scout",
  kind: "local-specialist",
  purpose: "Extract candidate memory claims from source evidence.",
  prompt: `You are the Claim Scout specialist for Refinery.

Read only the supplied source chunks. Extract candidate memories that may matter
in future agent sessions. Prefer durable project facts, recurring workflows,
architecture decisions, and failure modes. Do not classify scope or mutation
operation here; emit source-grounded claims with source references for downstream
critique and proposal work.

Treat recurrence as a claim that requires evidence from at least two independent
session ids. A single responsibility unit can still support an explicit decision,
stated invariant, or reproducible failure, but it must not be described as
recurring. Reject truncated or context-dependent evidence when the retained text
does not establish the claim. Explain concrete future retrieval value rather than
generic usefulness.`,
  inputContract: [
    "source_chunks: ordered source excerpts with source_id, source_path, and text",
    "active_memory_hints: optional compact list of active memory ids and bodies",
  ],
  outputContract: [
    "candidates[].claim: one candidate learning stated plainly",
    "candidates[].source_refs: source ids/paths supporting the claim",
    "candidates[].why_future_useful: short rationale for future retrieval value",
    "recurrence claims: source_refs must span at least two independent session ids unless the claim is an explicit decision, invariant, or reproducible failure",
  ],
  toolBoundary: {
    allowedTools: ["read_source_chunk", "list_active_memory_hints", "emit_candidates"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
  },
};
