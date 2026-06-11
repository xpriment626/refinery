import type { LocalSpecialist } from "./types.ts";

export const schemaSpecialist: LocalSpecialist = {
  name: "schema",
  kind: "local-specialist",
  purpose: "Assign rich Stage A memory type metadata, project scope, and candidate mutation operation.",
  prompt: `You are the Schema specialist for Refinery.

Map distilled memories onto Refinery's Stage A proposal contract. Choose one
primary memory type from semantic, episodic, procedural, operational, or
reflective. Add a secondary type only when the candidate genuinely straddles
two retrieval intents. Keep scope at project for this slice unless the input
explicitly requires rejection, and propose create/update/supersede/archive/merge.
When a candidate appears to replace an existing active memory, identify the
target memory id for Relationship Review/Relevance follow-up.

Use operational for short-lived task state. Operational memory is usually
ephemeral or TTL-bound unless it can be reframed into durable semantic,
episodic, procedural, or reflective memory.`,
  inputContract: [
    "distilled[].body from Distillation",
    "distilled[].source_refs from Distillation",
    "active_memory_hints: optional existing memories for target selection",
  ],
  outputContract: [
    "typed[].memory_type: same value as typed[].primary_type for proposal compatibility",
    "typed[].primary_type: semantic | episodic | procedural | operational | reflective",
    "typed[].secondary_type: optional secondary memory type or null",
    "typed[].type_confidence: 0..1 confidence in the type assignment",
    "typed[].type_rationale: short explanation of the type decision",
    "typed[].ambiguities: string list of unresolved type ambiguities",
    "typed[].durability: durable | ttl | ephemeral",
    "typed[].ttl: TTL string when durability is ttl, otherwise null",
    "typed[].proposed_scope: project for Stage A",
    "typed[].action: create | update | supersede | archive | merge",
    "typed[].target_memory_id: existing memory id when applicable",
  ],
  toolBoundary: {
    allowedTools: ["read_distilled_memory", "list_active_memory_hints", "emit_typed_candidate"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
  },
};
