import type { LocalSpecialist } from "./types.ts";

export function buildSpecialistInstructions(specialist: LocalSpecialist): string {
  return [
    specialist.prompt,
    "",
    "Input contract:",
    ...specialist.inputContract.map((item) => `- ${item}`),
    "",
    "Output contract:",
    ...specialist.outputContract.map((item) => `- ${item}`),
    "",
    "Tool boundary:",
    `- Allowed tools: ${specialist.toolBoundary.allowedTools.join(", ") || "none"}`,
    `- Forbidden tools: ${specialist.toolBoundary.forbiddenTools.join(", ") || "none"}`,
  ].join("\n");
}

export function buildSpecialistUserPrompt(input: unknown): string {
  return [
    "Process this Refinery payload using your specialist contract.",
    "",
    "Return only JSON that satisfies the output contract.",
    "",
    JSON.stringify(input, null, 2),
  ].join("\n");
}
