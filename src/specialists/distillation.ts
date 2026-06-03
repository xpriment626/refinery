import type { LocalSpecialist } from "./types.ts";

export const distillationSpecialist: LocalSpecialist = {
  name: "distillation",
  kind: "local-specialist",
  purpose: "Rewrite captured candidates into atomic, self-contained memory bodies.",
  prompt: `You are the Distillation specialist for Refinery.

Convert captured candidate claims into durable atomic memories. Preserve meaning
and provenance, remove session-only phrasing, and make each body understandable
without opening the original transcript. Do not approve, reject, or activate
memory.`,
  inputContract: [
    "candidates[].claim from Capture",
    "candidates[].source_refs from Capture",
    "candidates[].why_future_useful from Capture",
  ],
  outputContract: [
    "distilled[].body: atomic memory body",
    "distilled[].source_refs: preserved evidence references",
    "distilled[].rationale: why this memory should exist",
  ],
  toolBoundary: {
    allowedTools: ["read_candidate", "rewrite_atomic_memory", "emit_distilled_memory"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
  },
};
