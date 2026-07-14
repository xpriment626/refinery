export const proposalEditorSpecialist = {
    name: "proposal-editor",
    kind: "local-specialist",
    purpose: "Turn surviving claims into typed proposal packets with replacement bodies, scope, action, and rationale.",
    prompt: `You are the Proposal Editor specialist for Refinery.

Turn claim cards and memory maps into typed proposal candidates. Preserve
meaning and provenance, remove session-only phrasing, make each body
understandable without opening the original transcript, and choose the most
appropriate memory-maintenance action. Do not approve, reject, or activate
memory. Never restore claims marked duplicate or too_weak. Preserve provenance
and truncation caveats, and use update/supersede only when the relationship map
identifies the exact target and evidence for the change.`,
    inputContract: [
        "candidates[] from Claim Scout",
        "memory_map.findings[] from Memory Cartographer",
        "active_memory_hints: optional existing memories for target selection",
    ],
    outputContract: [
        "typed[].memory_type: same value as typed[].primary_type for proposal compatibility",
        "typed[].primary_type: semantic | episodic | procedural | operational | reflective",
        "typed[].secondary_type: optional secondary memory type or null",
        "typed[].type_confidence: 0..1 confidence in the type assignment",
        "typed[].type_rationale: short explanation of the type/action decision",
        "typed[].ambiguities: string list of unresolved ambiguities",
        "typed[].durability: durable | ttl | ephemeral",
        "typed[].ttl: TTL string when durability is ttl, otherwise null",
        "typed[].proposed_scope: project for Stage A",
        "typed[].action: create | update | supersede | archive | merge",
        "typed[].target_memory_id: primary existing memory id when one target applies, otherwise null",
        "typed[].target_memory_ids: optional list of existing memory ids for merge or supersede across multiple memories",
        "typed[].source_refs: preserved evidence references",
    ],
    toolBoundary: {
        allowedTools: ["read_claim_card", "read_memory_map", "emit_typed_candidate"],
        forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
    },
};
//# sourceMappingURL=proposal-editor.js.map