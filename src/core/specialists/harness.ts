import type { LocalSpecialist, SpecialistName } from "./types.ts";
import { captureSpecialist } from "./capture.ts";
import { distillationSpecialist } from "./distillation.ts";
import { schemaSpecialist } from "./schema.ts";
import { relevanceSpecialist } from "./relevance.ts";
import { relationshipReviewSpecialist } from "./relationship-review.ts";

export interface SequentialRefinementHarness {
  order: SpecialistName[];
  usesLiveLlm: false;
  specialists: LocalSpecialist[];
  describe(): string;
}

export const orderedSpecialists = [
  captureSpecialist,
  distillationSpecialist,
  schemaSpecialist,
  relevanceSpecialist,
  relationshipReviewSpecialist,
];

export function createSequentialRefinementHarness(): SequentialRefinementHarness {
  const order = orderedSpecialists.map((specialist) => specialist.name);
  return {
    order,
    usesLiveLlm: false,
    specialists: orderedSpecialists,
    describe() {
      return [
        "Local specialist scaffold only; no live LLM endpoint is invoked.",
        "Handoff order: Capture -> Distillation -> Schema -> Relevance -> Relationship Review.",
        "Each specialist owns a prompt, input contract, output contract, and tool boundary.",
      ].join(" ");
    },
  };
}
