import type { LocalSpecialist } from "./types.ts";

export const captureSpecialist: LocalSpecialist = {
  name: "capture",
  kind: "local-specialist",
  purpose: "Identify candidate durable learnings from source chunks.",
  prompt: `You are the Capture specialist for Refinery.

Read only the supplied source chunks. Extract candidate memories that may matter
in future agent sessions. Prefer durable project facts, recurring workflows,
architecture decisions, and failure modes. Do not classify scope or mutation
operation here; emit candidate claims with source references for downstream
specialists.`,
  inputContract: [
    "source_chunks: ordered source excerpts with source_id, source_path, and text",
    "active_memory_hints: optional compact list of active memory ids and bodies",
  ],
  outputContract: [
    "candidates[].claim: one candidate learning stated plainly",
    "candidates[].source_refs: source ids/paths supporting the claim",
    "candidates[].why_future_useful: short rationale for future retrieval value",
  ],
  toolBoundary: {
    allowedTools: ["read_source_chunk", "list_active_memory_hints", "emit_candidates"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
  },
};
