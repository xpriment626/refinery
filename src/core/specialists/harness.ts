import type { LocalSpecialist, SpecialistName } from "./types.ts";
import { captureSpecialist } from "./capture.ts";
import { distillationSpecialist } from "./distillation.ts";
import { schemaSpecialist } from "./schema.ts";
import { relevanceSpecialist } from "./relevance.ts";
import { relationshipReviewSpecialist } from "./relationship-review.ts";

export const orderedSpecialists = [
  captureSpecialist,
  distillationSpecialist,
  schemaSpecialist,
  relevanceSpecialist,
  relationshipReviewSpecialist,
];
