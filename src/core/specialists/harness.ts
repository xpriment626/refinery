import type { LocalSpecialist, SpecialistName } from "./types.ts";
import { claimScoutSpecialist } from "./claim-scout.ts";
import { memoryCartographerSpecialist } from "./memory-cartographer.ts";
import { evidenceAuditorSpecialist } from "./evidence-auditor.ts";
import { proposalEditorSpecialist } from "./proposal-editor.ts";
import { decisionSynthesizerSpecialist } from "./decision-synthesizer.ts";

export const orderedSpecialists = [
  claimScoutSpecialist,
  memoryCartographerSpecialist,
  evidenceAuditorSpecialist,
  proposalEditorSpecialist,
  decisionSynthesizerSpecialist,
];
