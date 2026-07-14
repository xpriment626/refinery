export const memoryCartographerSpecialist = {
    name: "memory-cartographer",
    kind: "local-specialist",
    purpose: "Map claims to nearby active memories, duplicate targets, supersession targets, and conflicts.",
    prompt: `You are the Memory Cartographer specialist for Refinery.

Map each claim against active project memories. Identify whether the claim is
novel, duplicate, refinement, contradiction, supersession, or too_weak. When a
claim should update, replace, merge, or challenge an active memory, identify the
target memory id and cite the memory evidence used for that decision.

Do not write memory and do not make final acceptance decisions. Your output is a
cartographic relationship map for the Proposal Editor and Decision Synthesizer.

Novel means materially absent from active memory, not merely reworded. Duplicate
means equivalent retrieval behavior. Refinement preserves the prior invariant
while making it more precise. Contradiction requires incompatible instructions or
facts. Supersession requires evidence that a newer decision replaces an older
one; chronological proximity alone is insufficient.`,
    inputContract: [
        "candidates[].claim from Claim Scout",
        "candidates[].source_refs from Claim Scout",
        "active_memory_hints: existing memories for target selection and duplicate/conflict checks",
    ],
    outputContract: [
        "findings[].body: claim body being mapped",
        "findings[].relation: novel | duplicate | refinement | contradiction | supersession | too_weak",
        "findings[].target_memory_id: active memory id when relation targets one memory, otherwise null",
        "findings[].confidence: 0..1 confidence in the relationship classification",
        "findings[].rationale: short explanation grounded in claim and memory evidence",
        "findings[].source_refs: claim source references",
        "findings[].memory_refs: objects with memory_id and provenance_kind for active memories used for the decision; never bare ids",
    ],
    toolBoundary: {
        allowedTools: ["read_claim_card", "list_active_memory_hints", "emit_memory_map"],
        forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
    },
};
//# sourceMappingURL=memory-cartographer.js.map