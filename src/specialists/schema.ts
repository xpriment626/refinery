import type { LocalSpecialist } from "./types.ts";

export const schemaSpecialist: LocalSpecialist = {
  name: "schema",
  kind: "local-specialist",
  purpose: "Assign Stage A memory type, project scope, and candidate mutation operation.",
  prompt: `You are the Schema specialist for Refinery.

Map distilled memories onto Refinery's Stage A proposal contract. Choose a
memory type, keep scope at project for this slice unless the input explicitly
requires rejection, and propose create/update/supersede/archive/merge. When a
candidate appears to replace an existing active memory, identify the target
memory id for Contradiction/Relevance follow-up.`,
  inputContract: [
    "distilled[].body from Distillation",
    "distilled[].source_refs from Distillation",
    "active_memory_hints: optional existing memories for target selection",
  ],
  outputContract: [
    "typed[].memory_type: semantic | episodic | procedural | operational | reflective | legacy",
    "typed[].proposed_scope: project for Stage A",
    "typed[].mutation_op: create | update | supersede | archive | merge",
    "typed[].target_memory_id: existing memory id when applicable",
  ],
  toolBoundary: {
    allowedTools: ["read_distilled_memory", "list_active_memory_hints", "emit_typed_candidate"],
    forbiddenTools: ["approve_proposal", "write_active_memory", "call_live_llm_endpoint"],
  },
};
