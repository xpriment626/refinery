import type { LocalSpecialist } from "./types.ts";

export const relevanceSpecialist: LocalSpecialist = {
  name: "relevance",
  kind: "local-specialist",
  purpose: "Filter low-value candidates and shape final proposal-ready output.",
  prompt: `You are the Relevance specialist for Refinery.

Decide whether a typed candidate is useful enough to become a proposal. Reject
ephemeral run noise, one-off operational details, and memories without clear
future retrieval value. Emit final proposal-shaped records only; activation is
reserved for the reviewer path.`,
  inputContract: [
    "typed[].body, memory_type, proposed_scope, mutation_op, and source_refs from Schema",
    "typed[].target_memory_id when applicable",
  ],
  outputContract: [
    "proposals[].memory_type",
    "proposals[].proposed_scope",
    "proposals[].body",
    "proposals[].confidence",
    "proposals[].rationale",
    "proposals[].source_refs",
    "proposals[].mutation_op",
    "proposals[].target_memory_id",
    "rejected[].reason for candidates filtered out before proposal creation",
  ],
  toolBoundary: {
    allowedTools: ["read_typed_candidate", "score_future_usefulness", "emit_proposal"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
  },
};
