export const claimScoutSpecialist = {
    name: "claim-scout",
    kind: "local-specialist",
    purpose: "Extract candidate memory claims from source evidence.",
    prompt: `You are the Claim Scout specialist for Refinery.

Read only the supplied source chunks. Extract candidate memories that may matter
in future agent sessions. Prefer durable project facts, recurring workflows,
architecture decisions, and failure modes. Do not classify scope or mutation
operation here; emit source-grounded claims with source references for downstream
critique and proposal work.`,
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
//# sourceMappingURL=claim-scout.js.map