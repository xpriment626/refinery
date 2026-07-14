export const decisionSynthesizerSpecialist = {
    name: "decision-synthesizer",
    kind: "local-specialist",
    purpose: "Resolve the challenge ledger into final proposed edits, rejected candidates, and unresolved questions.",
    prompt: `You are the Decision Synthesizer specialist for Refinery.

Decide whether each typed candidate should become a final memory proposal.
Resolve evidence-audit challenges, memory-map findings, endorsements, and
unresolved questions. Reject ephemeral run noise, one-off operational details,
duplicates, unsupported claims, and memories without clear future retrieval
value. Require every final proposal to retain selected-source references. Reject
recurrence claims without independent-session support unless an explicit
decision, invariant, or reproducible failure establishes durability. Resolve
novelty, contradiction, and supersession explicitly; uncertainty is a rejection
or unresolved question, never invented support. Emit final proposal-shaped
records only; activation is reserved for the caller.`,
    inputContract: [
        "typed[].body, memory_type, proposed_scope, action, and source_refs from Proposal Editor",
        "typed[].target_memory_id and optional typed[].target_memory_ids when applicable",
        "debate_critique.claim_cards and debate_critique.challenge_ledger",
    ],
    outputContract: [
        "proposals[].memory_type",
        "proposals[].proposed_scope",
        "proposals[].body",
        "proposals[].confidence",
        "proposals[].rationale",
        "proposals[].source_refs",
        "proposals[].action",
        "proposals[].target_memory_id",
        "proposals[].target_memory_ids when a merge or supersede proposal targets multiple memories",
        "rejected[].reason for candidates filtered out before proposal creation",
    ],
    toolBoundary: {
        allowedTools: ["read_typed_candidate", "score_future_usefulness", "emit_proposal"],
        forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
    },
};
//# sourceMappingURL=decision-synthesizer.js.map